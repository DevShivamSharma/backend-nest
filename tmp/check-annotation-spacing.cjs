const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../frontend-angular');
const ts = require(path.join(root, 'node_modules/typescript'));
require.extensions['.ts'] = (module, file) => {
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }}).outputText;
  module._compile(code, file);
};
const { annotationRect, placeAnnotationCards, ANNOTATION_GAP } = require(path.join(root, 'src/app/planner/geometry/annotation-placement.ts'));
const { planCards, cardLayout } = require(path.join(root, 'src/app/planner/geometry/plan-annotations.ts'));
const { floorOutlines } = require(path.join(root, 'src/app/planner/geometry/hall-plan.ts'));
const { pointInPolygon, rectOverlapsPolygon } = require(path.join(root, 'src/app/planner/geometry/placement-rules.ts'));
const halls = JSON.parse(fs.readFileSync(path.join(__dirname, 'production-hall-icons-before.json'), 'utf8')).halls;
const annotations = JSON.parse(fs.readFileSync(path.join(__dirname, '../scripts/data/hall-annotations.json'), 'utf8')).halls;
const overlaps = (a,b) => a.minX < b.maxX-1e-6 && a.maxX > b.minX+1e-6 && a.minZ < b.maxZ-1e-6 && a.maxZ > b.minZ+1e-6;
const assert = require('node:assert/strict');
let audited = 0, cardCount = 0, shifted = 0;
for (const hall of halls) {
  const plan = annotations[hall.name];
  if (!plan) continue;
  const cards = planCards(plan.amenities).map(card => ({...card, ...cardLayout(card.items.map(i => i.label))}));
  const floors = floorOutlines(hall);
  const placed = placeAnnotationCards(cards, floors);
  for (let i=0; i<placed.length; i++) {
    const rect = annotationRect(placed[i], ANNOTATION_GAP);
    if (!floors.some(f=>pointInPolygon(cards[i].anchor, f))) {
      assert(!floors.some(f=>rectOverlapsPolygon(rect, f)), hall.name+' floor collision '+i);
    }
    for(let j=0;j<placed.length;j++) if(i!==j) assert(!overlaps(rect, annotationRect(placed[j])), hall.name+' card collision '+i+' '+j);
    if(JSON.stringify(cards[i].anchor)!==JSON.stringify(placed[i].anchor)) shifted++;
  }
  audited++; cardCount+=placed.length;
  if (hall.name === 'Hall 14GF' || hall.name === 'Hall 14FF') console.log(hall.name, placed.map((c,i)=>({from:cards[i].anchor,to:c.anchor,width:+c.width.toFixed(2)})));
}
console.log('Plan audit:', { halls: audited, cards: cardCount, shifted });
const jasmine = require(path.join(root, 'node_modules/jasmine-core')).boot();
const env = jasmine.getEnv();
let passed=0, failed=0;
env.addReporter({
  specDone(r) { if(r.status==='passed') passed++; else {failed++; console.error(r.fullName, r.failedExpectations);} },
  jasmineDone(r) { console.log('Annotation tests:', { passed, failed, status:r.overallStatus }); process.exitCode=r.overallStatus==='passed'?0:1; }
});
for(const name of ['annotation-placement.spec.ts','plan-annotations.spec.ts']) require(path.join(root,'src/app/planner/geometry',name));
env.execute();
