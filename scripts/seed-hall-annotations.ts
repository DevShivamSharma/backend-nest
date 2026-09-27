import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { configuration } from '../src/config/configuration';
import { validateEnv } from '../src/config/env.validation';
import { buildDataSourceOptions } from '../src/database/data-source-options';
import { HallEntity } from '../src/layouts/entities/hall.entity';
import { LayoutEntity } from '../src/layouts/entities/layout.entity';
import { validateHallGeometry } from '../src/layouts/placement/hall-geometry';

type AnnotationPlan = Pick<
  HallEntity,
  'width' | 'length' | 'amenities' | 'markers' | 'compass' | 'legends'
>;

/** Only the four visual columns are writable; placement geometry and saved hall copies stay intact. */
export async function refreshHallAnnotations(
  source: DataSource,
  name: string,
  plan: AnnotationPlan,
  apply = false,
  hallId?: number,
): Promise<string> {
  if (!plan.amenities?.length && !plan.markers?.length && !plan.compass && !plan.legends?.length) {
    return `skip ${name}: source has no annotations`;
  }
  const checked = validateHallGeometry({
    ...plan,
    compass: plan.compass ? { ...plan.compass } : null,
  });
  const patch = {
    amenities: checked.amenities,
    markers: checked.markers,
    compass: checked.compass,
    legends: checked.legends,
  };
  return source.transaction(async (manager) => {
    const query = manager
      .getRepository(HallEntity)
      .createQueryBuilder('hall')
      .where('hall.name = :name', { name })
      .andWhere('NOT EXISTS (SELECT 1 FROM layouts owner WHERE owner.hall_id = hall.id)');
    if (hallId !== undefined) query.andWhere('hall.id = :hallId', { hallId });
    const candidates = await query.orderBy('hall.id', 'ASC').setLock('pessimistic_write').getMany();
    if (!candidates.length) return `skip ${name}: no standalone hall`;
    if (candidates.length !== 1) throw new Error(`${name}: ambiguous standalone halls; no update`);
    const current = candidates[0];
    if (current.width !== plan.width || current.length !== plan.length) {
      throw new Error(`${name}: dimensions differ from source; annotation origin would be wrong`);
    }
    // A saved layout's hall is private. Recheck ownership after locking the hall.
    if (await manager.getRepository(LayoutEntity).countBy({ hallId: current.id })) {
      throw new Error(`${name}: hall belongs to a saved layout; no update`);
    }
    if (apply) await manager.getRepository(HallEntity).update(current.id, patch);
    return (
      `${apply ? 'updated' : 'would update'} ${name} (id ${current.id}): ` +
      `${current.amenities?.length ?? 0} -> ${patch.amenities?.length ?? 0} icons, ` +
      `${current.markers?.length ?? 0} -> ${patch.markers?.length ?? 0} labels, ` +
      `compass ${!!patch.compass}, legends ${patch.legends?.length ?? 0}`
    );
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    if (!args.includes(flag)) return undefined;
    const next = args[args.indexOf(flag) + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`);
    return next;
  };
  const path = resolve(value('--file') ?? join(__dirname, 'data', 'hall-annotations.json'));
  const file = JSON.parse(readFileSync(path, 'utf8')) as { halls: Record<string, AnnotationPlan> };
  const name = value('--hall');
  if (args.includes('--apply') && !name && !args.includes('--all')) {
    throw new Error('Choose --hall <name> or --all before applying the repair');
  }
  const hallId = value('--id') === undefined ? undefined : Number(value('--id'));
  if (hallId !== undefined && (!name || !Number.isSafeInteger(hallId) || hallId <= 0)) {
    throw new Error('--id requires a positive integer and an explicit --hall name');
  }
  if (name && !file.halls[name]) throw new Error(`No source annotations for ${name}`);
  const selected = Object.entries(file.halls).filter(([key]) => !name || key === name);
  validateEnv(process.env);
  // An annotation repair must never apply schema migrations as a side effect.
  const source = new DataSource({
    ...buildDataSourceOptions(configuration().database),
    migrationsRun: false,
  });
  await source.initialize();
  try {
    for (const [key, plan] of selected) {
      console.log(
        await refreshHallAnnotations(source, key, plan, args.includes('--apply'), hallId),
      );
    }
  } finally {
    await source.destroy();
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
