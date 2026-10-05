# Meeting workflow validation · 3 October 2026

Scope: MASTER-PLAN WP1–WP7, through publication, in the existing local Angular/NestJS/PostgreSQL project.

## Implementation checks

| Check | Result |
|---|---|
| Backend full unit suite | 501 passed, 3 pre-existing skipped tests |
| Backend final type-check and production build | Passed |
| Backend placement/workflow API suites | 15 passed (11 placement + 4 workflow); the 4 workflow checks passed again after publication numbering ordering changed |
| Angular full unit suite | 329 passed |
| Additional final store guards | 4 passed: oversized AI proposal, stale utilization at Apply, zone retype/delete/atomic invalid edit, new-hall save isolation |
| Angular final production build | Passed; CSS-budget and polygon-clipping CommonJS warnings remain |
| New workflow browser checks | 6 passed: batch geometry, zone geometry, draw/guided/save/publish/exhibitor, row/merge, override/locate, desktop/mobile usability |
| Meeting rule UI checks | 2 passed |
| Hall 12A live rehearsal | Passed on localhost:4200 against the real API; temporary result removed afterward |
| Patch whitespace | Passed with Windows CRLF handling |

The full frontend discovery pattern was corrected from `src/**/*.spe c.ts` to `src/**/*.spec.ts`, so the unit result includes the actual suite.

## Browser regression run

All **106 selected cases passed across the initial run and targeted reruns**. The expanded run first passed 91 cases. Initial failures included real-backend requests from an unlisted alternate CORS origin, stale test assumptions (rules-library landing dialog, Help-triggered tour, agreement before AI, invalid aisle minimum, valid intermediate movement, and the enabledRules fixture), and one notification-hover timeout while two browser runs competed for software rendering. The app's CORS configuration and established tour behavior were preserved. A subsequent split-label check was updated to turn on the existing Labels display option before expecting labels to be visible.

Targeted reruns passed the remaining 15 cases: 4 in `meeting-final-rerun`, 8 in `meeting-final-confirm`, and the last 3 in `meeting-tour-confirm`. These are distinct cases, not a claim that the original 106-case command finished green in a single run. The six new workflow tests are part of those 106; the two meeting-rule UI tests were verified separately.

The tour tests also found one real regression: the extra publication controls reduced the space for the highlighted action on a small phone. During the optional tour only, those controls are now hidden and the scroll panel provides 8px target padding. The full five-step tour passed at 1440×900, 390×844 and 320×568 with 100% target visibility. The finish reviewer inspected all six fresh stall/position captures and returned **ship** for this correction. Normal planner surfaces are unchanged.

## Functional evidence

- Planning zones validate simple polygons, hall containment, unique IDs and non-overlap; stall validation uses actual footprints and cross-event separation.
- Rules agreement precedes guided size/count requests; changed hall settings expire agreement and pending plans. Applying a proposal rechecks current placement and remaining area.
- Batch side edits validate the final group before any mutation. Pavilion merge rejects booked stalls, gaps and nonrectangular unions; cancelled numbered parents retain identity.
- Publish recomputes issues on the server. Empty/malformed publication cannot write; placement/utilization issues require a recorded reason. Published stalls receive numbers. Ordinary edits return publication to Draft.
- The Hall 12A fixture produces 75 valid 6 × 6 stalls, 2,700 / 8,480 m² (31.8%), with four illustrative zones and no publication override. The source imported hall is unchanged.
- The browser rehearsal covers the actual backend guided fill, a newly saved temporary copy, checked publish, numbering and exhibitor navigation. The saved start and backup remain available.

## UI review and handover

The Impeccable finish reviewer inspected desktop/mobile zones, guided rules and publish captures. Its sole material fix was durable product context; the verdict pass scored that PRODUCT.md fix resolved and returned **ship**. A fresh documenter recorded DESIGN.md, the design sidecar and a scoped planner brief. This is a local planner-surface review, not a claim about unrelated venue pages or all future accessibility states.

See [meeting-demo.md](meeting-demo.md) for the 10-minute Hinglish demo, saved layout links, source provenance, fallback and recreation commands. Pricing, EMC markup and booking polish remain Phase 2. No remote deployment was performed.
