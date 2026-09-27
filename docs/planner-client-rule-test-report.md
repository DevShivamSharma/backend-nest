# Aapke planner rules ke against test-case report

Verification date: 27 September 2026. Yeh aapke original 7 rules ka direct mapping hai. Neeche ke results pichhle executed backend audit se liye gaye hain; is document ko banate waqt tests dobara run nahi kiye gaye.

**PASS ka matlab:** expected behavior mila. Invalid layout ko reject karne wala test bhi PASS hai jab backend sahi rejection karta hai.

## Original 7 rules

| Aapka rule | Tested input / scenario | Expected behavior | Actual result | Detailed report reference |
| --- | --- | --- | --- | --- |
| 1. Passage configurable 3–5 m; default 3 m | Setting omitted; B2B/B2C defaults | 3 m use ho | PASS | R01 |
| 1 | Explicit 3, 3.5, 5 m | Valid settings accept hon | PASS | R02 |
| 1 | 2.99, 5.01, 0, negative, string, null; unit-level NaN/Infinity | Invalid setting reject ho; invalid API request records na likhe | PASS | R03 |
| 2. Corner stall ke neighbouring stalls se selected passage | 3 m setting: exact 3 m vs 2.99 m gap | Exact accept, short reject | PASS | R04 |
| 2 | 5 m setting: exact 5 m vs 4.99 m gap | Exact accept, short reject | PASS | R04 |
| 2 | Corner par touching arrangement | Back-to-back exception se corner clearance bypass na ho | PASS | R11 |
| 2 | Rotated corners, 36 angles, 3/3.5/5 m, both polygon windings | Rotation se acceptance rule na badle | PASS | R05 / ADV-G01 |
| 3. Actual irregular hall boundary; outside empty space passage nahi | L-shaped cut-out; notch ke andar stall ya open-side strip | Reject | PASS | R06 |
| 3 | Stall ke vertices andar, lekin edge narrow notch cross kare | Reject | PASS | R06 |
| 3 | Neighbour ke beech gap exterior notch ya thin outside sliver cross kare | Outside region ko passage na gina jaye | PASS | R07 |
| 3 | Outside/wall hole footprint ya required passage mein aaye | Reject | PASS | R08 |
| 3 | Circular floor ka bounding box fit, lekin actual circle ke bahar passage | Actual radius se reject | PASS | R09 |
| 4. Non-corner back-to-back touching, opposite outward open sides | Shared back edge, exactly one open side each, outward opposite directions | Accept, including rotated cases | PASS | R10 |
| 4 | Same direction, sideways, open face touching, multiple open sides | Reject | PASS | R11 |
| 4 | Point contact vs valid partial shared back edge | Point reject, positive-length valid back edge accept | PASS | R12 / ADV-G03 |
| 5. Har open side ke saamne selected-width clear passage | FRONT, BACK, LEFT, RIGHT mein 1 mm blocker intrusion | Affected side reject aur error mein identify ho | PASS | R13 / ADV-G02 |
| 5 | Hall edge tak exact required depth vs 1 mm short | Exact accept, short reject | PASS | R14 |
| 5 | Multiple open sides; unmein ek blocked | Reject | PASS | R15 |
| 5 | Do facing stalls ek doosre ka passage block karein | Audit dono stalls ke affected sides report kare | PASS after fix | R25 / ADV-G05 |
| 6. Distance actual rotated edges se, centres se nahi | Rotated exact 3 m edge gap vs 2.99 m | Exact accept, short reject | PASS | R16 |
| 6 | Centre/unrotated dimensions fit, lekin rotated footprint boundary cross kare | Reject | PASS | R06/R16 |
| 6 | Real overlap ko large coordinate offset par translate karein | Overlap detection consistent rahe | PASS after fix | R35 / ADV-G06 |
| 6 | Finite number se stall edges numerical precision mein collapse ho jayein | Controlled 400 / INVALID_DIMENSIONS; server crash nahi | PASS after fix | R35 / ADV-G07 / ADV-A03 |
| 7. 5-10 identifier; children A…Z, AA… | Parent 5-10 ko 28 children mein split karein | 5-10-A … 5-10-Z, 5-10-AA, 5-10-AB | PASS | R26 |
| 7 | Z→AA, AZ→BA, ZZ→AAA suffix calculation | Correct sequence | PASS | R27 |
| 7 | Existing child identifier collision | Duplicate reject; partial split na bane | PASS | R28 |
| 7 | Split ke baad PUT/GET; nested split | Identifiers aur parent-child relationship stable | PASS | R33 / ADV-A06 |

Rule 2/6 rotation matrix mein 216 angle × width × winding combinations hain. Har combination mein exact gap, short gap aur valid touching backs check hue: 648 layout scenarios, 36 parameterized unit tests ke andar. Inhe overall test count mein dobara add nahi kiya gaya.

## Aapki backend/persistence requirements

| Requirement | Test case | Expected / actual result |
| --- | --- | --- |
| Create/update authoritative validation | Invalid create aur invalid full-layout PUT | Reject; invalid state save nahi — PASS |
| Move/rotate/resize validation | Move outside, rotation across boundary, size expansion | Reject; previous saved state retained — PASS |
| Width/event change revalidation | Unchanged stalls, setting 3→5; B2B=3 se B2C=5 | Revalidate and reject insufficient passage — PASS |
| Hall update consistency | Invalid owned-hall change; valid resize 80×60→90×70 | Invalid rollback; valid hall/layout dimensions consistent — PASS after fix |
| Auto-layout validation | Rows/back-to-back/island/perimeter × rectangular/notched/circular hall, 5 m B2C | Complete generated layouts pass validation; input unchanged — PASS |
| Same-request concurrency | Five simultaneous identical split requests | One child set, one ledger entry — PASS |
| Competing split requests | Two simultaneous different-key splits on same parent | Exactly one success, one conflict — PASS |
| Repeated request semantics | Same key/same data; changed data; reordered object keys vs reordered children | Safe replay or appropriate conflict — PASS |
| Atomic split | Child outside parent; forced late database insert failure | No partial child/ledger state; retry after fault removal works — PASS |
| Stable persistence | Save, reload, PUT, reload split geometry/rules/identifiers | Values and lineage stable — PASS |
| Forged/stale updates | Forged parent fields; stale PUT resurrecting original parent | Lineage preserved; resurrection rejected — PASS |
| Identifier limits | Child name >255 characters; numeric sequence overflow | Controlled rejection; no invalid insert — PASS after overflow fix |
| Legacy schema compatibility | Existing row through migration up/down/up | Identifier/open sides preserved; rotation defaults maintained — PASS |

## Additional existing planner checks covered

| Check | Executed cases | Result |
| --- | --- | --- |
| Overlap/status | Several active stalls overlapped; CANCELLED vs BOOKED blocker | Active/booked enforced; cancelled ignored spatially — PASS |
| Peripheral clearance | 0.5 m vs configured 1 m; exact 1 m; notch walls | Required clearance enforced — PASS |
| Restricted zones | Compulsory passage overlap; zero-clearance contact; smoke-curtain clearance | Applicable zone rule enforced — PASS |
| Emergency/door access | Stall in emergency access region; event-dependent depth | Blockage rejected — PASS |
| Input/grid | Missing data, invalid dimensions/shape/side/status/event; invalid snap-size multiple | Invalid inputs rejected — PASS |
| Assistant failures | Invalid intent, unknown marker, fallback/timeout, rate limiting | Expected clarification/fallback/rejection — PASS |

Peripheral clearance and size snapping have separate configuration/default behavior; they are not automatically the same number as the selected 3–5 m passage.

## Actual results and scope

- Unit: **355/355 PASS**.
- Integration: **30/30 PASS** — 27 PostgreSQL/migration + 3 assistant HTTP.
- Playwright running API: **19/19 PASS**.
- Type-check/build: **PASS**.
- 6 reproduced bugs fixed. 62 unit + 9 API tests added in the audit.
- 404 is the full backend test total, including health/config/compatibility tests; it is not 404 separate planner rules.
- No new migration needed for audit fixes. Frontend unchanged.
- Browser UI and live external AI providers were not tested in this backend audit.
- Existing token-protected historical seed import deliberately bypasses placement validation. It is an exception to normal planner saves; do not present it as a validated planner save route.
- Local PostgreSQL/API were available; no unresolved blocker for the executed suites.
- These are tested cases, not a claim that every possible geometry or concurrency interleaving is covered.

Detailed evidence, changed files, exact executed commands and API contract: [Full audit report](planner-validation-test-report.md).

Every executed test name and result: [Test inventory](planner-validation-test-inventory.md).

Client speaking script: [Hinglish presentation](planner-client-presentation-hinglish.md).

