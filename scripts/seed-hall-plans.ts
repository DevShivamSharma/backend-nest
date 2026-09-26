import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AppModule } from '../src/app.module';
import { HallService } from '../src/halls/hall.service';
import type { HallDto } from '../src/layouts/dto/layout-save-request.dto';

/**
 * Writes each hall's SelfCare plan (data/hall-plans.json, from `npm run build:hall-shapes`) onto
 * the standalone hall of the same name.
 *
 *   npm run seed:hall-plans [-- path/to/hall-plans.json] [--dry-run]
 *
 * The plan replaces the hall's rectangles, outline, zones, gate labels, icons, north arrow,
 * legend and size — every field the plan defines. `openings` (rule-engine doors, not part of the
 * SelfCare plan) and the hall's id and name are kept. A hall with no standalone row of that name
 * is reported and skipped: this script never creates halls.
 *
 * Standalone halls only, lowest id per name — the same set `GET /api/halls?standalone=true`
 * serves to the planner (a saved layout's private copy shares the master's name; BR-18).
 */
interface PlansFile {
  halls: Record<
    string,
    Omit<HallDto, 'name' | 'shape' | 'radius'> & { width: number; length: number }
  >;
}

async function seed(): Promise<void> {
  const logger = new Logger('seed-hall-plans');
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const path = resolve(
    args.find((a) => !a.startsWith('--')) ?? join(__dirname, 'data', 'hall-plans.json'),
  );
  const file = JSON.parse(readFileSync(path, 'utf-8')) as PlansFile;

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const halls = app.get(HallService);
    const byName = new Map<string, { id: number }>();
    for (const hall of await halls.list(true)) {
      if (hall.name === null) continue;
      const seen = byName.get(hall.name);
      if (!seen || hall.id < seen.id) byName.set(hall.name, hall);
    }

    let updated = 0;
    let missing = 0;
    for (const [name, plan] of Object.entries(file.halls)) {
      const target = byName.get(name);
      if (!target) {
        logger.warn(`skip   ${name} — no standalone hall with this name`);
        missing++;
        continue;
      }
      const current = await halls.get(target.id);
      const write: HallDto = {
        name: current.name,
        shape: 'SQUARE',
        radius: 0,
        width: plan.width,
        length: plan.length,
        blockedAreas: plan.blockedAreas ?? null,
        boundary: plan.boundary ?? null,
        zones: plan.zones ?? null,
        openings: current.openings,
        markers: plan.markers ?? null,
        amenities: plan.amenities ?? null,
        compass: plan.compass ?? null,
        legends: plan.legends ?? null,
        rules: plan.rules ?? null,
      };
      if (!dryRun) await halls.update(target.id, write);
      logger.log(
        `${dryRun ? 'would update' : 'update'} ${name} (id ${target.id}) — ${plan.blockedAreas?.length ?? 0} rectangles, ` +
          `${plan.zones?.length ?? 0} zones, ${plan.markers?.length ?? 0} labels, ${plan.amenities?.length ?? 0} icons`,
      );
      updated++;
    }
    logger.log(`done: ${updated} hall(s) ${dryRun ? 'checked' : 'updated'}, ${missing} not found`);
  } finally {
    await app.close();
  }
}

seed().catch((error) => {
  new Logger('seed-hall-plans').error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
