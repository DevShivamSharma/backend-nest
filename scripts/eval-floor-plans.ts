import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { readSource } from '../src/venues/floor-plan/source';
import { analysePage } from '../src/venues/floor-plan/analyse';
async function main() {
  for (const [file, names, foyers] of [
    ['12-12A.pdf', ['HALL 12A', 'HALL 12'], 1],
    ['8-9-10.pdf', ['HALL 11', 'HALL 10', 'HALL 9', 'HALL 8'], 3],
  ] as const) {
    const source = await readSource(
        new Uint8Array(readFileSync(join(__dirname, '../test/fixtures/floor-plan', file))),
        file,
      ),
      page = analysePage(source[0]);
    assert.deepEqual(
      page.regions.filter((r) => r.role === 'hall').map((r) => r.name),
      names,
    );
    assert.equal(page.regions.filter((r) => r.role === 'foyer').length, foyers);
    assert.ok(page.regions.every((r) => !r.confirmed));
    console.log(
      `${file}: hall identities and foyer candidates pass; boundaries still require human review.`,
    );
  }
  const denseSource = await readSource(
    new Uint8Array(
      readFileSync(join(__dirname, '../test/fixtures/floor-plan/dense-multiple-halls.pdf')),
    ),
    'dense-multiple-halls.pdf',
  );
  const dense = analysePage(denseSource[0]);
  assert.ok(dense.preview.length > 1000);
  assert.deepEqual(
    dense.regions.filter((r) => r.role === 'hall').map((r) => r.name),
    ['EXHIBITION HALL - 5', 'EXHIBITION HALL - 4', 'EXHIBITION HALL - 3', 'EXHIBITION HALL - 2'],
  );
  for (const n of [5, 4, 3, 2]) {
    const h = dense.regions.find((r) => r.name === `EXHIBITION HALL - ${n}`)!;
    assert.equal(h.confirmed, false);
    assert.deepEqual(dense.regions.find((r) => r.name === `FOYER ${n}F`)!.hallIds, [h.id]);
    assert.ok(Math.abs(h.grid!.width - h.grid!.height) / h.grid!.width < 0.02);
  }
  assert.ok(dense.warnings.some((w) => w.includes('main-branch engine')));
  assert.ok(dense.calibration.source.includes('CAD grid layer'));
  assert.ok(dense.objects.some((o) => o.kind === 'column'));
  assert.ok(dense.objects.some((o) => o.kind === 'fire_curtain'));
  console.log(
    'Dense CAD PDF: main CAD engine, four separate hall candidates, restrictions and named foyer ownership pass; boundaries require human review.',
  );
  const foyerSource = await readSource(
    new Uint8Array(
      readFileSync(join(__dirname, '../test/fixtures/floor-plan/hall-with-gridded-foyer.pdf')),
    ),
    'hall-with-gridded-foyer.pdf',
  );
  const foyerPage = analysePage(foyerSource[0]);
  const actualHalls = foyerPage.regions.filter((r) => r.role === 'hall');
  assert.deepEqual(
    actualHalls.map((r) => r.name),
    ['EXHIBITION HALLS -14'],
  );
  const foyer = foyerPage.regions.find((r) => r.name === 'FOYER-14G');
  assert.equal(foyer?.role, 'foyer');
  assert.deepEqual(foyer?.hallIds, [actualHalls[0].id]);
  assert.ok(foyer?.grid);
  assert.ok(Math.abs(foyer!.grid!.height * foyerPage.calibration.metresPerUnit! - 1) < 0.001);
  assert.ok(foyerPage.calibration.confirmed);
  assert.ok(foyerPage.calibration.source.includes('CAD grid layer'));
  assert.ok(foyerPage.regions.every((r) => !r.confirmed));
  assert.ok(!actualHalls.some((r) => /foyer|hall-11|hall-12a/i.test(r.name)));
  console.log(
    'Hall with gridded foyer: one actual hall; foyer grid remains a linked foyer, and adjacent-hall direction labels do not become imported halls.',
  );
  for (const file of ['generic-mm.dxf', 'generic-scan.png']) {
    const source = await readSource(
        new Uint8Array(readFileSync(join(__dirname, '../test/fixtures/floor-plan', file))),
        file,
      ),
      page = analysePage(source[0]);
    assert.equal(page.regions.filter((r) => r.role === 'hall').length, 1);
    assert.equal(page.regions[0].name, 'HALL ALPHA');
    if (file.endsWith('.dxf')) {
      assert.equal(page.calibration.metresPerUnit, 0.001);
      assert.equal(page.grid!.width * page.calibration.metresPerUnit, 2);
    } else assert.equal(page.calibration.confirmed, false);
    console.log(`${file}: generic source path passes.`);
  }
  console.log(
    'These source fixtures check extraction and identities, not 99% geometric truth. Analytical geometry regression tests run separately.',
  );
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
