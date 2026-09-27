import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe } from '@nestjs/common';
import { buildPlan, jsonRows } from '../../scripts/build-demo-hall-shapes';
import { refreshHallAnnotations } from '../../scripts/seed-hall-annotations';
import { loadGeometry } from '../../scripts/seed-demo-halls';
import { HallDto } from '../layouts/dto/layout-save-request.dto';
import { HallEntity } from '../layouts/entities/hall.entity';
import { HallService } from './hall.service';

// Reading a seed file must not bootstrap the application's environment or database.
jest.mock('../app.module', () => ({ AppModule: class {} }));

const fixture = join(__dirname, '../../test/fixtures/selfcare/hall-14ff.json');
const plan = buildPlan(jsonRows(fixture)[0], 'Hall 14FF')!;

describe('SelfCare Hall 14FF annotation pipeline', () => {
  it('uses repaired annotations when seeding demo masters without replacing their geometry', () => {
    const geometry = loadGeometry().get('Hall 8-9-10')!;
    const original = JSON.parse(
      readFileSync(join(__dirname, '../../scripts/data/demo-hall-shapes.json'), 'utf8'),
    ).halls['Hall 8-9-10'];
    expect(geometry.blockedAreas).toEqual(original.blockedAreas);
    expect(geometry.boundary).toEqual(original.boundary);
    expect(geometry.amenities).toHaveLength(8);
    expect(geometry.markers).toHaveLength(10);
    expect(geometry.compass).not.toBeNull();
    expect(geometry.legends).toHaveLength(9);
  });
  it('keeps every source image, group, repeated label and visibility flag', () => {
    const row = JSON.parse(readFileSync(fixture, 'utf8')).data[0];
    expect(row.layout_data.nonClickableAreas).toHaveLength(203);
    expect(row.helper_text).toHaveLength(13);
    expect(plan.amenities).toHaveLength(22);
    expect(plan.markers).toHaveLength(16);
    expect(plan.legends).toHaveLength(12);
    expect(plan.compass).not.toBeNull();
    let offset = 0;
    for (const group of row.helper_text) {
      const icons = plan.amenities.slice(offset, offset + group.image.length);
      expect(icons.map((i) => i.label)).toEqual(group.image.map((i: any) => i.label));
      expect(icons.map((i) => i.slot)).toEqual(group.image.map((_: any, i: number) => i));
      expect(
        icons.every(
          (i) =>
            i.anchor?.x === group.positionX / 20 - 42 && i.anchor?.z === group.positionY / 20 - 58,
        ),
      ).toBe(true);
      offset += icons.length;
    }
    expect(plan.markers.filter((m) => m.text === 'T-14FC')).toHaveLength(3);
    expect(plan.openings).toEqual([]);
    expect(plan.amenities[0].anchor).toEqual({ x: -56, z: 42 });
    expect(plan.markers).toEqual(
      row.exit_labels.map((l: any) => ({
        text: l.text,
        position: { x: l.positionX / 20 - 42, z: l.positionY / 20 - 58 },
      })),
    );
    expect(plan.legends.map((l) => l.visibleInViewMode)).toEqual(
      row.legends.map((l: any) => l.visibleInViewMode),
    );
  });

  it('survives Nest whitelist, validation, repository write and response serialization', async () => {
    let stored: any;
    const repository = {
      create: jest.fn(
        async (write) => (stored = JSON.parse(JSON.stringify({ id: 9001, ...write }))),
      ),
      findById: jest.fn(async () => stored),
    };
    const service = new HallService(repository as any);
    const body = {
      name: 'Hall 14FF',
      shape: 'SQUARE',
      radius: 0,
      width: 84,
      length: 116,
      amenities: plan.amenities,
      markers: plan.markers,
      compass: plan.compass,
      legends: plan.legends,
    };
    const dto = await new ValidationPipe({ whitelist: true, transform: true }).transform(body, {
      type: 'body',
      metatype: HallDto,
    });
    await service.create(dto);
    const response = await service.get(9001);
    for (const key of ['amenities', 'markers', 'compass', 'legends'] as const) {
      expect(response[key]).toEqual(plan[key]);
    }
  });

  it('repairs only annotation columns, is repeatable, and defaults to a dry run', async () => {
    const current = {
      id: 100,
      name: 'Hall 14FF',
      width: 84,
      length: 116,
      amenities: [],
      markers: [],
    };
    const update = jest.fn(async (_id, patch) => Object.assign(current, patch));
    const query: any = {
      where: () => query,
      andWhere: () => query,
      orderBy: () => query,
      setLock: () => query,
      getMany: async () => [current],
    };
    const manager = {
      getRepository: (entity: unknown) =>
        entity === HallEntity
          ? { createQueryBuilder: () => query, update }
          : { countBy: async () => 0 },
    };
    const source: any = { transaction: async (fn: any) => fn(manager) };
    await refreshHallAnnotations(source, 'Hall 14FF', plan);
    expect(update).not.toHaveBeenCalled();
    await refreshHallAnnotations(source, 'Hall 14FF', plan, true);
    const first = JSON.stringify(current);
    await refreshHallAnnotations(source, 'Hall 14FF', plan, true);
    expect(JSON.stringify(current)).toBe(first);
    expect(Object.keys(update.mock.calls[0][1]).sort()).toEqual([
      'amenities',
      'compass',
      'legends',
      'markers',
    ]);
    current.width = 83;
    await expect(refreshHallAnnotations(source, 'Hall 14FF', plan, true)).rejects.toThrow(
      'dimensions differ',
    );
    current.width = 84;
    query.getMany = async () => [current, { ...current, id: 101 }];
    await expect(refreshHallAnnotations(source, 'Hall 14FF', plan, true)).rejects.toThrow(
      'ambiguous',
    );
    query.getMany = async () => [current];
    const hallRepo = manager.getRepository(HallEntity);
    manager.getRepository = (entity: unknown) =>
      entity === HallEntity ? hallRepo : { countBy: async () => 1 };
    await expect(refreshHallAnnotations(source, 'Hall 14FF', plan, true)).rejects.toThrow(
      'saved layout',
    );
    expect(update).toHaveBeenCalledTimes(2);
  });
});
