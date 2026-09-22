import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import type { LayoutSaveRequestDto } from '../src/layouts/dto/layout-save-request.dto';
import { LayoutService } from '../src/layouts/layout.service';

/**
 * Seeds the demo database with SAVED LAYOUTS whose stall placements come from the real
 * production data — the companion to seed-demo-halls.ts, which seeds the empty master halls.
 *
 * WHY THIS EXISTS
 * Production `T_STALLS` holds the actual stall placement of each hall for real events
 * (5,829 rows). `scripts/data/demo-layouts.json` is generated from the `bm_prod` dump and
 * carries one layout per seeded hall — e.g. Hall 1GF with its real 120-stall placement —
 * converted to planner coordinates (20 px = 1 unit, verified against the "12sqm" area labels).
 * Stall colour encodes the real booking_status (Booked = red, Available = green). Full
 * provenance, including the source event id and any dropped rows, is inside the JSON.
 *
 * Every layout is written through `LayoutService.save()`, so the seed passes the same
 * BR-01…BR-13 and BR-22/23 validation as a save from the UI. The one exception is the placement
 * rules (BR-24): these are EXISTING production placements, which the editor reports through the
 * rule audit but never blocks, so the import passes `skipPlacementRules`. Stall numbers and
 * statuses are assigned by the service (BR-25).
 * NOTHING IN PRODUCTION IS READ AT RUNTIME OR WRITTEN TO.
 *
 * Run with:  npm run seed:demo-layouts [-- --refresh]
 * Idempotent: a layout whose name already exists is skipped, so re-running never duplicates.
 * With --refresh an existing demo layout (matched by name) is deleted and re-created from the
 * file — for a local database seeded before the rule-driven fields existed.
 */

interface DemoLayoutsFile {
  _provenance: string;
  layouts: Array<LayoutSaveRequestDto & { layoutName: string; source: unknown }>;
}

async function seed(): Promise<void> {
  const logger = new Logger('SeedDemoLayouts');
  const file = JSON.parse(
    readFileSync(join(__dirname, 'data', 'demo-layouts.json'), 'utf-8'),
  ) as DemoLayoutsFile;

  // 'log' is included so this script's own progress lines are not filtered out.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const layouts = app.get(LayoutService);
    const refresh = process.argv.includes('--refresh');
    const existing = new Map((await layouts.list()).map((layout) => [layout.name, layout.id]));

    let created = 0;
    let skipped = 0;

    for (const demo of file.layouts) {
      const found = existing.get(demo.layoutName);
      if (found !== undefined && refresh) {
        await layouts.delete(found);
        logger.log(`delete ${demo.layoutName} (layout id ${found}) — refreshing`);
      } else if (found !== undefined) {
        logger.log(`skip   ${demo.layoutName} — already present`);
        skipped++;
        continue;
      }

      const saved = await layouts.save(
        {
          layoutName: demo.layoutName,
          hall: demo.hall,
          stalls: demo.stalls,
        } as LayoutSaveRequestDto,
        { skipPlacementRules: true },
      );

      logger.log(
        `create ${demo.layoutName} (layout id ${saved.layout.id}) — ${saved.stalls.length} stalls`,
      );
      created++;
    }

    logger.log(`done — ${created} created, ${skipped} skipped`);
  } finally {
    await app.close();
  }
}

void seed().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
