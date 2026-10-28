import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { DataSource } from 'typeorm';

import { ConflictException as Conflict, NotFoundException } from '@nestjs/common';

import { CreateHallDto, HallImageDto } from '../dto/create-hall.dto';
import { HallsService } from './halls.service';

const CATEGORIES: Record<number, string> = {
  1: 'New Exhibition Halls (Ground Floor)',
  4: 'NTA (Non-Tower Area.)',
};

function build(existing: {
  hallMax: number;
  layoutMax: number;
  nameTaken?: boolean;
  /** The hall's pictures already (a missing hall when `null`), and which of them is the cover. */
  images?: number[] | null;
  hasCover?: boolean;
}) {
  let documentId = 5000;
  const sql: { text: string; params: unknown[] }[] = [];
  const tx = {
    query: (text: string, params: unknown[] = []) => {
      sql.push({ text, params });
      if (text.includes('INSERT INTO idp."T_DOCUMENTS"'))
        return Promise.resolve([{ id: ++documentId }]);
      if (text.includes('SELECT image_hall_ids'))
        return Promise.resolve(
          existing.images === null ? [] : [{ image_hall_ids: existing.images ?? [] }],
        );
      if (text.includes('type = $2')) return Promise.resolve(existing.hasCover ? [{}] : []);
      if (text.includes('LOWER(TRIM(name))'))
        return Promise.resolve(existing.nameTaken ? [{}] : []);
      if (text.includes('"T_HALLS_CATEGORY"')) {
        const name = CATEGORIES[params[0] as number];
        return Promise.resolve(name ? [{ category_name: name }] : []);
      }
      if (text.includes('MAX(id)'))
        return Promise.resolve([
          { next: (text.includes('"T_HALLS"') ? existing.hallMax : existing.layoutMax) + 1 },
        ]);
      return Promise.resolve([]);
    },
  };
  const db = { transaction: (fn: (t: unknown) => unknown) => fn(tx) } as unknown as DataSource;
  return { service: new HallsService(db), sql };
}

const dto = (input: Record<string, unknown>) => plainToInstance(CreateHallDto, input);
const hallInsert = (sql: { text: string; params: unknown[] }[]) =>
  sql.find((q) => q.text.includes('INSERT INTO idp."T_HALLS"'))!;
const layoutInsert = (sql: { text: string; params: unknown[] }[]) =>
  sql.find((q) => q.text.includes('INSERT INTO idp."T_HALL_LAYOUTS"'))!;

const L = [
  [0, 0],
  [6, 0],
  [6, 3],
  [10, 3],
  [10, 8],
  [0, 8],
];

describe('CreateHallDto', () => {
  it('accepts a name with a width and depth, fractions included, and trims the name', () => {
    const value = dto({ name: '  Hall 20 ', width: 40.5, depth: 30 });

    expect(validateSync(value)).toHaveLength(0);
    expect(value.name).toBe('Hall 20');
  });

  it('accepts an outline as [x, y] corners', () => {
    expect(validateSync(dto({ name: 'H', width: 10, depth: 8, outline: L }))).toHaveLength(0);
  });

  it.each([
    ['blank name', { name: ' ', width: 40, depth: 30 }],
    ['zero depth', { name: 'H', width: 40, depth: 0 }],
    ['a side over 2000 m', { name: 'H', width: 2001, depth: 30 }],
    ['negative capacity', { name: 'H', width: 4, depth: 3, hallAreaCapacity: -1 }],
    [
      'two-corner outline',
      {
        name: 'H',
        width: 4,
        depth: 3,
        outline: [
          [0, 0],
          [1, 1],
        ],
      },
    ],
    [
      'outline of objects',
      {
        name: 'H',
        width: 4,
        depth: 3,
        outline: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 2, y: 0 },
        ],
      },
    ],
    ['complementary days of 2', { name: 'H', width: 4, depth: 3, complementaryDays: 2 }],
    ['sort order over 20', { name: 'H', width: 4, depth: 3, sortOrder: 21 }],
  ])('refuses %s', (_label, input) => {
    expect(validateSync(dto(input)).length).toBeGreaterThan(0);
  });
});

describe('HallsService.create', () => {
  it('numbers the hall and its layout from the highest ids already saved', async () => {
    const { service, sql } = build({ hallMax: 97, layoutMax: 47 });

    const created = await service.create(dto({ name: 'Hall 20', width: 40, depth: 30 }), 'u1');

    expect(created).toMatchObject({
      hallId: 98,
      layoutId: 48,
      width: 40,
      depth: 30,
      area: 1200,
      hallAreaCapacity: 0,
    });
    expect(hallInsert(sql).params.slice(0, 2)).toEqual([98, 'Hall 20']);
    expect(layoutInsert(sql).params.slice(0, 2)).toEqual([48, 98]);
  });

  it("keeps ITPO's id sequences in step with the ids it used", async () => {
    const { service, sql } = build({ hallMax: 97, layoutMax: 47 });
    await service.create(dto({ name: 'Hall 20', width: 4, depth: 3 }), 'u1');

    expect(sql.filter((q) => q.text.includes('setval')).map((q) => q.params[0])).toEqual([98, 48]);
  });

  it('stores the grid in whole cells, the area from the exact size, the capacity as given', async () => {
    const { service, sql } = build({ hallMax: 1, layoutMax: 1 });
    const created = await service.create(
      dto({ name: 'Frac', width: 10.5, depth: 7.5, hallAreaCapacity: 500 }),
      'u1',
    );

    expect(created.area).toBe(78.75);
    expect(created.hallAreaCapacity).toBe(500);
    expect(hallInsert(sql).params[4]).toBe(500);
    expect(layoutInsert(sql).params.slice(3)).toEqual([11, 8]);
  });

  it('stores a rectangle with no blocked areas and a cut corner with one', async () => {
    const plain = build({ hallMax: 1, layoutMax: 1 });
    await plain.service.create(dto({ name: 'Plain', width: 10, depth: 8 }), 'u1');
    expect(JSON.parse(layoutInsert(plain.sql).params[2] as string)).toEqual({
      shape: 'non-circular',
      stallWidth: 1,
      stallHeight: 1,
      nonClickableAreas: [],
    });

    const cut = build({ hallMax: 1, layoutMax: 1 });
    await cut.service.create(dto({ name: 'L', width: 10, depth: 8, outline: L }), 'u1');
    expect(JSON.parse(layoutInsert(cut.sql).params[2] as string).nonClickableAreas).toHaveLength(1);
  });

  it("saves the flags SelfCare's form has, for an ordinary category", async () => {
    const { service, sql } = build({ hallMax: 1, layoutMax: 1 });
    await service.create(
      dto({
        name: 'Hall 21',
        width: 4,
        depth: 3,
        hallCategoryId: 1,
        isPopular: true,
        isVipLounge: true,
        isAvailableForFnB: true,
        complementaryDays: 1,
        sortOrder: 7,
      }),
      'u1',
    );

    // popular, vip lounge, fnb, complementary days, sort order
    expect(hallInsert(sql).params.slice(5, 10)).toEqual([true, true, true, 1, 7]);
  });

  it('clears the VIP lounge, F&B, complementary days and order for an NTA hall, as SelfCare does', async () => {
    const { service, sql } = build({ hallMax: 1, layoutMax: 1 });
    await service.create(
      dto({
        name: 'NTA 9',
        width: 4,
        depth: 3,
        hallCategoryId: 4,
        isPopular: true,
        isVipLounge: true,
        isAvailableForFnB: true,
        complementaryDays: 1,
        sortOrder: 7,
      }),
      'u1',
    );

    expect(hallInsert(sql).params.slice(3, 10)).toEqual([4, 0, true, false, false, 0, 0]);
  });

  it('refuses a hall category that does not exist, before writing anything', async () => {
    const { service, sql } = build({ hallMax: 1, layoutMax: 1 });

    await expect(
      service.create(dto({ name: 'X', width: 4, depth: 3, hallCategoryId: 99 }), 'u1'),
    ).rejects.toThrow('Unknown hall category.');
    expect(sql.some((q) => q.text.includes('INSERT'))).toBe(false);
  });

  it('refuses a name that is taken, whatever its case', async () => {
    const { service, sql } = build({ hallMax: 97, layoutMax: 47, nameTaken: true });

    await expect(
      service.create(dto({ name: 'hall 1gf', width: 4, depth: 3 }), 'u1'),
    ).rejects.toThrow(ConflictException);
    expect(sql.some((q) => q.text.includes('INSERT'))).toBe(false);
  });

  it('refuses a bad outline before touching the database', async () => {
    const { service, sql } = build({ hallMax: 97, layoutMax: 47 });
    const bowtie = [
      [0, 0],
      [10, 8],
      [10, 0],
      [0, 8],
    ];

    await expect(
      service.create(dto({ name: 'X', width: 10, depth: 8, outline: bowtie }), 'u1'),
    ).rejects.toThrow(BadRequestException);
    expect(sql).toHaveLength(0);
  });
});

const IMAGE = 'https://static.indiatradefair.com/admin_uploads/files/file-1.jpg';

describe('HallImageDto', () => {
  it('accepts an https URL as a cover or gallery picture', () => {
    expect(validateSync(plainToInstance(HallImageDto, { url: IMAGE, kind: 'cover' }))).toHaveLength(
      0,
    );
    expect(
      validateSync(plainToInstance(HallImageDto, { url: IMAGE, kind: 'gallery' })),
    ).toHaveLength(0);
  });

  it('refuses a URL that is not https, too long for ITPO, or a kind it does not know', () => {
    expect(
      validateSync(plainToInstance(HallImageDto, { url: 'http://x.in/a.jpg', kind: 'cover' })),
    ).not.toHaveLength(0);
    expect(
      validateSync(
        plainToInstance(HallImageDto, { url: `https://x.in/${'a'.repeat(200)}`, kind: 'cover' }),
      ),
    ).not.toHaveLength(0);
    expect(
      validateSync(plainToInstance(HallImageDto, { url: IMAGE, kind: 'banner' })),
    ).not.toHaveLength(0);
  });
});

describe('HallsService pictures', () => {
  it('saves the pictures of a new hall as documents and lists them on the hall', async () => {
    const { service, sql } = build({ hallMax: 99, layoutMax: 9 });
    const result = await service.create(
      dto({
        name: 'H',
        width: 10,
        depth: 8,
        images: [
          { url: IMAGE, kind: 'cover' },
          { url: 'https://static.indiatradefair.com/a%20b.jpg', kind: 'gallery' },
        ],
      }),
      'u1',
    );

    const documents = sql.filter((q) => q.text.includes('INSERT INTO idp."T_DOCUMENTS"'));
    expect(documents.map((d) => d.params)).toEqual([
      ['file-1.jpg', IMAGE, 'cover'],
      ['a b.jpg', 'https://static.indiatradefair.com/a%20b.jpg', 'files'],
    ]);
    expect(result.images).toEqual([
      { documentId: 5001, url: IMAGE, kind: 'cover' },
      { documentId: 5002, url: 'https://static.indiatradefair.com/a%20b.jpg', kind: 'gallery' },
    ]);
  });

  it('refuses a new hall with two covers', async () => {
    const { service } = build({ hallMax: 99, layoutMax: 9 });

    await expect(
      service.create(
        dto({
          name: 'H',
          width: 10,
          depth: 8,
          images: [
            { url: IMAGE, kind: 'cover' },
            { url: IMAGE, kind: 'cover' },
          ],
        }),
        'u1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('adds a picture to a hall that has none', async () => {
    const { service } = build({ hallMax: 1, layoutMax: 1, images: [] });

    await expect(service.addImage(7, { url: IMAGE, kind: 'gallery' })).resolves.toEqual({
      documentId: 5001,
      url: IMAGE,
      kind: 'gallery',
    });
  });

  it('refuses a second cover, and a picture for a hall that does not exist', async () => {
    const withCover = build({ hallMax: 1, layoutMax: 1, images: [14190], hasCover: true });
    await expect(
      withCover.service.addImage(7, { url: IMAGE, kind: 'cover' }),
    ).rejects.toBeInstanceOf(Conflict);

    const missing = build({ hallMax: 1, layoutMax: 1, images: null });
    await expect(
      missing.service.addImage(7, { url: IMAGE, kind: 'gallery' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("takes a picture off the hall's list, and answers not found for one it does not have", async () => {
    const { service, sql } = build({ hallMax: 1, layoutMax: 1, images: [11, 12] });

    await service.removeImage(7, 12);
    expect(sql.at(-1)!.text).toContain('array_remove');
    expect(sql.at(-1)!.params).toEqual([12, 7]);
    await expect(service.removeImage(7, 99)).rejects.toBeInstanceOf(NotFoundException);
  });
});
