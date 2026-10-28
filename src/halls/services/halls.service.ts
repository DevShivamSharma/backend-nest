import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import { MAX_HALL_IMAGES, type CreateHallDto, type HallImageDto } from '../dto/create-hall.dto';
import { blockedAreas, gridSize, outlineError } from '../domain/hall-grid';

export interface CreatedHall {
  hallId: number;
  layoutId: number;
  name: string;
  width: number;
  depth: number;
  /** Floor area in square metres: width times depth. */
  area: number;
  /** The capacity the user gave, as saved in T_HALLS.hall_area_capacity. */
  hallAreaCapacity: number;
  /** The pictures saved with it. */
  images: HallImage[];
}

export interface HallImage {
  documentId: number;
  url: string;
  kind: 'cover' | 'gallery';
}

/** How ITPO's `T_DOCUMENTS.type` tells a cover picture from the others. */
const DOCUMENT_TYPE = { cover: 'cover', gallery: 'files' } as const;

/** Held while a hall is made, so two at once cannot be given the same ids. */
const HALL_ID_LOCK = 7_300_001;

/**
 * ITPO's `T_HALLS` has an empty hall type on 42 of its 47 halls; a new hall gets the same.
 * Its own default for the rest (bookable, active, status 1) is left as the table has it.
 */
const HALL_TYPE_ID = '';

@Injectable()
export class HallsService {
  constructor(private readonly db: DataSource) {}

  /**
   * Makes a hall the way ITPO's own apps store one: a row in `T_HALLS` (its name) and one in
   * `T_HALL_LAYOUTS` (its floor). Both ids carry on from the highest already saved.
   */
  async create(dto: CreateHallDto, createdBy: string): Promise<CreatedHall> {
    const images = dto.images ?? [];
    if (images.filter((image) => image.kind === 'cover').length > 1) {
      throw new BadRequestException('A hall has one cover picture.');
    }

    if (dto.outline) {
      const problem = outlineError(dto.outline, dto.width, dto.depth);
      if (problem) {
        throw new BadRequestException(problem);
      }
    }

    const layoutData = {
      shape: 'non-circular',
      stallWidth: 1,
      stallHeight: 1,
      nonClickableAreas: blockedAreas(dto.width, dto.depth, dto.outline),
    };
    const grid = gridSize(dto.width, dto.depth);

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [HALL_ID_LOCK]);

      const [taken] = await tx.query<unknown[]>(
        `SELECT 1 FROM idp."T_HALLS" WHERE LOWER(TRIM(name)) = LOWER($1)`,
        [dto.name],
      );
      if (taken) {
        throw new ConflictException('A hall with this name already exists.');
      }

      let isNta = false;
      if (dto.hallCategoryId !== undefined) {
        const [category] = await tx.query<{ category_name: string }[]>(
          `SELECT category_name FROM idp."T_HALLS_CATEGORY" WHERE id = $1`,
          [dto.hallCategoryId],
        );
        if (!category) {
          throw new BadRequestException('Unknown hall category.');
        }
        isNta = isNtaCategory(category.category_name);
      }

      // Area is worked out from the size; capacity is what the user states, 0 when not given.
      const area = Math.round(dto.width * dto.depth * 100) / 100;
      const capacity = dto.hallAreaCapacity ?? 0;
      // As SelfCare's own form does: an NTA hall has no VIP lounge, F&B, complementary days or order.
      const vipLounge = !isNta && (dto.isVipLounge ?? false);
      const availableForFnb = !isNta && (dto.isAvailableForFnB ?? false);
      const complementaryDays = isNta ? 0 : (dto.complementaryDays ?? 0);
      const sortOrder = isNta ? 0 : (dto.sortOrder ?? 0);

      const hallId = await nextId(tx, 'T_HALLS');
      await tx.query(
        `INSERT INTO idp."T_HALLS" (id, name, hall_type_id, hall_category_id, hall_area_capacity,
                                is_popular, is_vip_lounge, is_available_for_fnb, complementary_days,
                                sort_order, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
        [
          hallId,
          dto.name,
          HALL_TYPE_ID,
          dto.hallCategoryId ?? null,
          capacity,
          dto.isPopular ?? false,
          vipLounge,
          availableForFnb,
          complementaryDays,
          sortOrder,
          createdBy,
        ],
      );

      const layoutId = await nextId(tx, 'T_HALL_LAYOUTS');
      await tx.query(
        `INSERT INTO idp."T_HALL_LAYOUTS" (id, hall_id, layout_data, status, length, breadth)
         VALUES ($1, $2, $3::jsonb, 1, $4, $5)`,
        [layoutId, hallId, JSON.stringify(layoutData), grid.columns, grid.rows],
      );

      const saved: HallImage[] = [];
      for (const image of images) {
        saved.push(await insertImage(tx, hallId, image));
      }

      return {
        hallId,
        layoutId,
        name: dto.name,
        width: dto.width,
        depth: dto.depth,
        area,
        hallAreaCapacity: capacity,
        images: saved,
      };
    });
  }

  /** Adds a picture (by its URL) to a hall that already exists. */
  async addImage(hallId: number, image: HallImageDto): Promise<HallImage> {
    return this.db.transaction(async (tx) => {
      const ids = await lockImageIds(tx, hallId);
      if (ids.length >= MAX_HALL_IMAGES) {
        throw new BadRequestException(`A hall has at most ${MAX_HALL_IMAGES} pictures.`);
      }
      if (image.kind === 'cover' && ids.length) {
        const [cover] = await tx.query<unknown[]>(
          `SELECT 1 FROM idp."T_DOCUMENTS" WHERE id = ANY($1::int[]) AND type = $2`,
          [ids, DOCUMENT_TYPE.cover],
        );
        if (cover) {
          throw new ConflictException('The hall already has a cover picture. Remove it first.');
        }
      }
      return insertImage(tx, hallId, image);
    });
  }

  /**
   * Takes a picture off a hall. Only the hall's list is changed; the document ITPO keeps for the
   * file is left as it is, since other records may still point at it.
   */
  async removeImage(hallId: number, documentId: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const ids = await lockImageIds(tx, hallId);
      if (!ids.includes(documentId)) {
        throw new NotFoundException('The hall has no such picture.');
      }
      await tx.query(
        `UPDATE idp."T_HALLS" SET image_hall_ids = array_remove(image_hall_ids, $1) WHERE id = $2`,
        [documentId, hallId],
      );
    });
  }
}

/** The pictures a hall has, with its row locked so two changes at once cannot lose one. */
async function lockImageIds(tx: EntityManager, hallId: number): Promise<number[]> {
  const [hall] = await tx.query<{ image_hall_ids: number[] | null }[]>(
    `SELECT image_hall_ids FROM idp."T_HALLS" WHERE id = $1 AND is_active IS NOT FALSE FOR UPDATE`,
    [hallId],
  );
  if (!hall) {
    throw new NotFoundException('Hall not found.');
  }
  return hall.image_hall_ids ?? [];
}

/** Records the picture the way ITPO's uploads are: a `T_DOCUMENTS` row (its URL is the path), listed on the hall. */
async function insertImage(
  tx: EntityManager,
  hallId: number,
  image: HallImageDto,
): Promise<HallImage> {
  const [{ id }] = await tx.query<{ id: number }[]>(
    `INSERT INTO idp."T_DOCUMENTS" (file_name, path, type) VALUES ($1, $2, $3) RETURNING id`,
    [fileNameOf(image.url), image.url, DOCUMENT_TYPE[image.kind]],
  );
  await tx.query(
    `UPDATE idp."T_HALLS" SET image_hall_ids = array_append(COALESCE(image_hall_ids, '{}'), $1::int) WHERE id = $2`,
    [id, hallId],
  );
  return { documentId: id, url: image.url, kind: image.kind };
}

/** The last part of the URL, as the file's name (`T_DOCUMENTS.file_name` holds 100 characters). */
function fileNameOf(url: string): string {
  const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? 'image';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // Not valid percent-encoding: the raw text will do as a name.
  }
  return name.slice(0, 100);
}

/** SelfCare's own test for the Non-Tower Area category, by its name. */
function isNtaCategory(name: string): boolean {
  const plain = name.toLowerCase().replace(/\./g, '').trim();
  return plain.includes('non-tower') || plain === 'nta';
}

/**
 * One more than the highest id in the table. ITPO's own inserts take ids from the table's
 * sequence, so it is moved up to match, or their next hall would reuse ours.
 */
async function nextId(tx: EntityManager, table: 'T_HALLS' | 'T_HALL_LAYOUTS'): Promise<number> {
  const [{ next }] = await tx.query<{ next: number }[]>(
    `SELECT COALESCE(MAX(id), 0) + 1 AS next FROM idp."${table}"`,
  );
  await tx.query(`SELECT setval(pg_get_serial_sequence('idp."${table}"', 'id'), $1)`, [next]);
  return next;
}
