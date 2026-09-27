# Planner validation: adversarial test report

Date: 27 September 2026. Scope: backend-nest only. Frontend files, browser UI aur production data change nahi kiye.

## Seedha jawab

Original 7 requested rules ke core tests pehle se the. Lekin har possible edge case covered tha, yeh kehna sahi nahi hota. Is audit ke start par current checkout mein **293 unit tests / 13 suites pass** hue. Iske baad naye negative, precision, rotation, persistence aur retry cases likhkar system ko fail karne ki koshish ki. **6 distinct bugs reproduce hue**, unhe fix kiya, aur relevant suites dobara run kiye.

Final executed results:

| Check | Actual result |
| --- | --- |
| Unit tests | **355 passed, 0 failed, 0 skipped; 16 suites** |
| Integration tests | **30 passed, 0 failed, 0 skipped; 4 suites** — 27 real PostgreSQL/migration tests + 3 assistant HTTP tests |
| Playwright running-API tests | **19 passed, 0 failed, 0 skipped, 0 flaky** |
| TypeScript type-check | **PASS**, exit 0 |
| Backend production build | **PASS**, exit 0 |
| Whitespace diff check | **PASS**, exit 0 |

Is audit mein **62 unit tests aur 9 Playwright API tests add hue**. Total final suite count 404 hai; ismein configuration, API compatibility aur health tests bhi hain, sirf placement tests nahi. Test count ko rule coverage percentage samajhna galat hoga.

## Failures actually reproduced, then fixed

| Bug | Reproduction / observed failure BEFORE fix | Fix / verified AFTER fix |
| --- | --- | --- |
| B01 Rotated corner passage crash | ADV-G01: translated boundary, 90.37° rotation, exact passage; polygon clipping threw `Unable to complete output ring`. Initial fix exposed the same class at 20.37° and 60.37°. | Gap containment uses the joining convex hull; near-collinear numerical vertices are removed. All 36 angle tests pass. ADV-A09 saves/reloads/audits the three reproduced angles through real HTTP. |
| B02 Missing second open-side audit error | ADV-G05: two facing stalls both block each other's open side; audit omitted the second stall because it deduplicated all pair errors. | Directional `OPEN_SIDE_BLOCKED` errors remain attached to each affected stall. Symmetric pair deduplication stays. |
| B03 Degenerate finite geometry caused HTTP 500 | ADV-G07 / ADV-A03: width 2 m at `posX=1e20` in a very large hall; JavaScript coordinates collapse edges, clipping throws a degenerate-segment error. | Derived edges are checked before clipping/persistence. API returns structured **400 / INVALID_DIMENSIONS**, including when another valid stall appears first. |
| B04 Number sequence overflow caused HTTP 500 | ADV-N01 / ADV-A02: explicit `STALL-2147483645` plus two automatically numbered stalls. Service accepted a next sequence of 2147483648; PostgreSQL rejected the integer. | Automatic allocation uses the same capacity limit as explicit numeric identifiers. **400 before persistence**, no layout written. |
| B05 Hall resize left stale layout metadata | ADV-A01: resize owned hall 80×60 to 90×70. Reload returned `hall.width=90`, `layout.hallWidth=80`. | Hall and owner layout width/length metadata update in one transaction. Reload is consistent and stalls unchanged. |
| B06 Small overlaps disappeared at large coordinates | ADV-G06: two 2×2 footprints overlapping by 0.01 m at offset 1e9. Global-coordinate area arithmetic returned no overlap. | Polygon area uses a local origin to prevent cancellation. Same overlap is detected at offsets 0, 1e8 and 1e9. |

Recorded red runs: first focused unit run **4 failed / 84 passed**; additional large-coordinate overlap reproduction **1 failed / 44 intentionally filtered out**; first adversarial API run **3 failed / 5 passed**. After the first geometry repair, **2 failed / 86 passed** exposed additional angles; those were fixed before final verification. These were real test failures, not findings inferred only from reading code.

Type-check also caught one typing mistake in the new test's HTTP headers; it was corrected and type-check rerun successfully.

## Rule-by-rule test cases

U = unit; I = HTTP/database integration; A = Playwright API against a running server. `ADV-*` IDs are searchable in test names. Every row below passed in the final run; the scope column describes what was actually checked.

| ID / rule | Input / attempt | Expected and actual final result | Scope / evidence |
| --- | --- | --- | --- |
| R01 Default passage | Omit rules / omit event width; B2B and B2C | Both default to 3 m | U authoritative-placement; A default/width test |
| R02 Allowed settings | 3, 3.5, 5 m | Accept; use selected event setting | U authoritative-placement, ADV-G01; A width test, ADV-A09 |
| R03 Invalid settings | 2.99, 5.01, -1, 0, string `3`, null; NaN/Infinity in unit inputs | Reject; API invalid width gives 400 with INVALID_PASSAGE_WIDTH and no insert | U authoritative-placement; A width test |
| R04 Corner minimum | Exact 3/5 m vs 0.01 m too short | Exact accepted; short gap rejected as CORNER_PASSAGE | U + A |
| R05 Rotated corner minimum | 36 angles, 3/3.5/5 m, both boundary windings; exact vs 1 mm short | Same decision under rigid transforms | U ADV-G01; A ADV-A09 |
| R06 Actual irregular boundary | L-shaped notch, concave corner, edge crossing a thin notch even though vertices are inside | Outside footprint / outside passage rejected | U authoritative-placement; A irregular-notch test |
| R07 Exterior gap is not passage | Gap across outside notch; thin exterior sliver inside joining region | CORNER_PASSAGE; outside space never counted | U authoritative-placement |
| R08 Usable floor holes | Outside/wall mask interrupts footprint or open strip | OUTSIDE_HALL / OPEN_SIDE_PASSAGE | U authoritative-placement; assistant tests |
| R09 Circular floor | Square fits bounding box but open strip exits actual circle | Reject against radius, not square bounds | U authoritative-placement; circular I and assistant tests |
| R10 Valid touching backs | Exactly one open side per stall, opposite world directions, outward from shared edge | Non-corner shared-edge contact accepted, including rotations | U original + ADV-G01; A rotated-back test |
| R11 Invalid touching | Same-side, sideways, multiple open sides or corner contact | Reject INVALID_BACK_TO_BACK / CORNER_PASSAGE | U authoritative-placement; A invalid open-side PUT |
| R12 Point vs partial edge contact | Point-only contact vs positive-length partial shared back edge | Point rejected; valid partial back edge accepted | U ADV-G03 |
| R13 Full open-side strip | FRONT/BACK/LEFT/RIGHT each with a blocker entering by 1 mm | OPEN_SIDE_BLOCKED includes the affected side | U ADV-G02 |
| R14 Open side at wall | Exactly required depth inside floor vs 1 mm outside | Exact accepted; short depth rejected | U authoritative-placement |
| R15 Every open side | Multiple open sides; block one of them | Reject the blocked strip | U authoritative-placement |
| R16 Rotated edge distances | Rotated 3 m edge gap vs 2.99 m; outward normals rotate too | Geometry uses edges, not centres | U authoritative-placement + ADV-G01; A rotation tests |
| R17 Overlap and cancellation | Large stall across several stalls; overlapping cancelled/booked stalls | Active/booked blockers enforced; CANCELLED ignored spatially | U placement-rules, ADV-G04; I cancellation persistence |
| R18 Peripheral clearance | 0.5 m vs exact 1 m; notch walls; configured clearance | Below selected clearance rejected; exact accepted | U placement-rules |
| R19 Restricted zones | Compulsory passage overlap; zero-clearance boundary contact; smoke-curtain clearance | Overlap/too-close rejected; permitted contact accepted | U placement-rules; assistant obstacle/zone tests |
| R20 Doors / emergency access | Stall in emergency access rectangle; event-width-dependent depth | Access blockage rejected | U placement-rules |
| R21 Basic data and snap | Missing hall/name; invalid shape/status/event/side; zero/negative/nonfinite dimensions; size not multiple of snap | 400 / domain rejection; empty layout remains valid | U validator/service; I malformed/type/empty cases |
| R22 Move/rotate/resize | Full PUT moves outside, rotates across edge, grows across boundary | Reject; old saved state remains | A move/rotate/resize test; I invalid update |
| R23 Rule/event changes | Keep stalls unchanged; increase passage 3→5 or switch B2B=3 to B2C=5 | Revalidate all stalls; reject and roll back | A full PUT test + ADV-A04 |
| R24 Hall edit path | Shrink owned hall / change rules; valid expansion | Invalid edit rejected; valid resize keeps metadata consistent | A owned-hall test + ADV-A01 |
| R25 Structured errors / audit | Invalid placement; two mutually blocked faces | Useful code, geometry/side/index data; audit reports both affected faces | U filter/service + ADV-G05; I errors/audit; A negative cases |
| R26 Split identifier semantics | Parent identifier `5-10`, 28 children | `5-10-A` … `5-10-Z`, `5-10-AA`, `5-10-AB`; parent text not dimensions | U splitSuffix; A 28-child save/reload |
| R27 Suffix rollover | Z→AA, AZ→BA, ZZ→AAA | Correct alphabetic sequence | U splitSuffix |
| R28 Duplicate prevention | Same explicit labels; existing child label collision | Reject; no partial child/ledger records | U service; A duplicate/collision test |
| R29 Same-key concurrency | Five simultaneous identical split requests | All return success; one child set, one ledger record | A concurrency/retry test with direct PostgreSQL assertions |
| R30 Conflicting retries | Different key on same parent; same key changed payload; simultaneous competing keys | 409 conflict; exactly one winner | A retry tests |
| R31 Canonical retry payload | Reorder object keys; separately reorder children | Key order replay accepted; child order change rejected | A ADV-A05 |
| R32 Atomic split failure | Child outside parent; force late child insert failure with temporary database trigger | Parent, stalls and ledger unchanged; retry after removing trigger succeeds | A rollback test |
| R33 Lineage and stable reload | Split then PUT/GET; stale parent PUT; nested split; forged relationship fields | Stable child identifiers/lineage; parent cannot resurrect or lose split state | A original persistence test + ADV-A06 |
| R34 Identifier capacity | Child name would exceed 255 chars; numeric sequence exhausted | Whole operation rejected before invalid state is persisted | U ADV-N01; A ADV-A02/07 |
| R35 Numeric precision | Edge collapse at 1e20; small overlap translated to 1e9 | Controlled structured rejection / correct overlap | U ADV-G06/07; A ADV-A03 |
| R36 Auto-layout proposals | Rows, back-to-back, island, perimeter × rectangle/notch/circle; B2C 5 m | Six proposals per case; entire resulting layout valid; input unchanged | U ADV-P01 (12 cases) |
| R37 Assistant input/failure paths | Bad intent, unknown marker, malformed request, short aisle request, provider failure/timeout, rate limit | Validation/clarification/fallback; minimum hall aisle preserved; 429 at configured limit | Existing U assist tests + 3 assistant HTTP I tests |
| R38 Legacy migration | Existing identifier/open sides; migrate up/down/up in disposable schema | Values preserved, rotation defaults, lineage constraint supports compatibility | I placement-migration |
| R39 Trusted-import access | Missing/incorrect token | 404, persistence not called | U ADV-S01; A ADV-A08 |
| R40 Trusted-import exception | Correct mocked seed token | Deliberately calls placement bypass; this is an exception, not a normal planner validation pass | U ADV-S02 + existing trusted-service import test |

ADV-G01 contains **216 angle × width × winding combinations**. Each checks exact corner gap, short corner gap and valid touching backs: **648 layout scenarios inside 36 parameterized Jest tests**. These internal scenarios are not added again to the 355 test count.

Exact test names and file-level counts are in [planner-validation-test-inventory.md](planner-validation-test-inventory.md). The inventory is generated from the final runner JSON, including every unit, integration and API result.

## Commands actually executed

Commands were run from `backend-nest` using Windows PowerShell. Initial sandboxed Node startup failed with `EPERM` resolving the workspace path. The same commands were rerun using the tool's approved execution outside the filesystem sandbox; this was an environment limitation, not a passed test.

Final verification commands:

```powershell
npm test -- --runInBand --json --outputFile=test-results/audit-unit.json
npm run test:e2e -- --runInBand --json --outputFile=test-results/audit-integration.json
npm run typecheck
$env:PLAYWRIGHT_JSON_OUTPUT_FILE='coverage/planner-audit/api.json'
npm run test:api -- --reporter=line,json
npm run build
git diff --check
```

Reproduction/focused commands also executed:

```powershell
npm test -- --runInBand --runTestsByPath src/layouts/placement/adversarial-placement.spec.ts src/layouts/layout.service.spec.ts --json --outputFile=test-results/audit-red-unit.json
npm test -- --runInBand --runTestsByPath src/layouts/placement/adversarial-placement.spec.ts --testNamePattern ADV-G06
$env:PLAYWRIGHT_JSON_OUTPUT_FILE='test-results/audit-red-api.json'
npm run test:api -- --grep 'ADV-A' --reporter=line,json
npm test -- --runInBand --runTestsByPath src/layouts/placement/adversarial-placement.spec.ts src/layouts/layout.service.spec.ts --json --outputFile=test-results/audit-fixed-unit.json
npm test -- --runInBand --runTestsByPath src/layouts/placement/adversarial-placement.spec.ts
```

`audit-fixed-unit` was an intermediate run with two remaining failures, not the final success result. Playwright cleans `test-results` on startup, so final unit/integration JSON and the red API JSON were copied to ignored `coverage/planner-audit/`. Final evidence files: `unit.json`, `integration.json`, `api.json`, `red-api.json`. These are local runner artifacts; the repository Markdown report/inventory retain the readable results. No commit or deployment was made.

Only files changed in this audit were formatted with the installed Prettier. No full-project formatting was performed. Formatting after verification changed whitespace only.

## Persistence, migration and API contract

Tests used local **stall_designer_test**, with a temporary running Nest API on **127.0.0.1:18081**. Database suites ran sequentially. Existing test setup refuses remote database hosts and clears managed database URLs. The existing PostgreSQL suite truncates the isolated test database; Playwright deletes its own created layouts. The rollback trigger and migration schema are temporary and cleaned up.

No new schema migration was needed for these fixes. Existing `1758240600000-AddPlacementAndSplits.ts` compatibility was rerun against real PostgreSQL using a transaction that is rolled back. No development/production migration was executed.

Existing endpoint names, centre-origin metre coordinates and clockwise rotation/open-side conventions remain. Save/PUT/split use authoritative validation; the assistant returns proposals that must go through save/PUT. Contract details, examples, error structures and the import exception are in [placement-api.md](placement-api.md); assistant details are in [ai-layout-assistant.md](ai-layout-assistant.md).

## Files changed by this audit

Production fixes:

- `src/layouts/placement/polygon-geometry.ts` — stable area, derived-edge guard, robust joining hull.
- `src/layouts/placement/oriented-placement.ts` — reject unrepresentable candidate geometry.
- `src/layouts/placement/placement-rules.ts` — preserve directional open-side audit errors.
- `src/layouts/layout.validator.ts` — reject degenerate derived geometry before other stalls can encounter it.
- `src/layouts/layout.service.ts` — numeric sequence capacity guard and corrected import-bypass comment.
- `src/halls/hall.repository.ts` — transactional layout dimension synchronization on hall update.

Tests and documents:

- `src/layouts/placement/adversarial-placement.spec.ts` — new, 45 cases.
- `src/layouts/assist/adversarial-assist.spec.ts` — new, 12 cases.
- `src/layouts/seed-import.controller.spec.ts` — new, 4 cases.
- `src/layouts/layout.service.spec.ts` — 1 added sequence-limit regression.
- `test/api/adversarial.spec.ts` — new, 9 running-API cases.
- `docs/placement-api.md` — current assistant/import endpoints, precision errors and audit semantics.
- `docs/planner-validation-test-report.md` and `docs/planner-validation-test-inventory.md` — this report and actual runner inventory.

Pre-existing changes in `package.json`, hall seeding scripts/data, `layouts.module.ts`, `seed-import.controller.ts`, annotations tests and fixtures were present before the audit. They were preserved; they are not claimed as changes made by this audit.

## Explicit limits / remaining exceptions

- **Seed import bypass exists:** configured correct token permits historical placements that fail normal passage/overlap rules. It predates this audit. Missing/wrong-token HTTP access and correct-token controller dispatch were tested; a live privileged import was not performed. Therefore “every HTTP route rejects invalid placement” is not a true claim for this checkout.
- Live external AI providers were **not called**. Provider behavior was mocked; deterministic planner, parser, fallback, timeout and assistant HTTP tests ran locally.
- Browser UI, dragging/visual highlighting and frontend preview/backend parity were **not tested here**; no frontend repository changes were made.
- Split concurrency tests exercise five same-key retries and two competing keys on local PostgreSQL. They are meaningful race/atomicity checks, not production load testing or a proof over all possible interleavings.
- Geometry tests cover named edge cases and the 648 rigid-transform scenarios; they are not exhaustive over every possible polygon/float combination. Distances retain documented 1e-6 m tolerance.
- PostgreSQL and the temporary API were available. There is **no unresolved service blocker for the executed backend suites**. Passing tests do not constitute production deployment verification.
