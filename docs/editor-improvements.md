# Editor improvements — 3 October 2026

This local milestone refines zone editing, CAD navigation/rendering and AI placement in the existing editor. The light planner/exhibitor surfaces and the separate dark CAD workspace retain their established presentation. It does not complete Phase 2 or the broader CAD work.

## Using the changes

- In **Zones**, choose **Zone colour** with the native colour picker, or use **Auto colour** to choose an unused colour. New zones receive different colours, including zones of the same type. Colour identifies the area; the visible zone type, B2B/B2C event type and Internal/Sellable text still describe its rules.
- Choose **Edit**, change the name, type, event type or colour, then **Update zone**. This keeps the original polygon and its position in the zone list. **Resize or edit coordinates → Save zone coordinates** explicitly rebuilds the area as a rectangle; **Redraw zone** starts drawing again. Save the layout to persist changes.
- Zone colour is shared by the list, 3D view and CAD view. Legacy zones without a valid saved colour use an indexed display fallback. CAD captions choose black or white text for contrast and appear only where they fit.
- In CAD, **Fit plan** frames the drawing. Toggle **Pan** and left-drag to move the view; the existing middle-drag and wheel navigation remain available. **Planning & restricted zones** controls both sets of zone geometry.
- The exhibitor map no longer carries the floating dark Hall card. The page header still identifies the hall and layout and displays stall availability.
- AI proposals still require review and **Apply**, which rechecks the current layout. Saving persists the applied result.

## Rendering and planning work

CAD caches its drawing in an offscreen canvas and paints cursor, drag preview and command feedback over it. Geometry, selection, hover, layers, grid, issues, proposals and viewport changes invalidate the relevant cached drawing. The optimization avoids repainting the full plan for an otherwise unchanged cursor frame; it is not a promise that every interaction uses one paint.

The AI planner's local fixtures show reduced runtime for the same large-hall and two-event-zone results. The fine-grid case now completes substantially more placement work instead of stopping at the earlier bounded-search result.

## Local fixture measurements

These are observed development-machine runs, not an SLA, browser frame-rate guarantee or production-load benchmark. The CAD baseline is recorded here; the retained current fixture asserts paint counts rather than a fragile time threshold.

| Fixture | Before | After | Interpretation |
| --- | --- | --- | --- |
| CAD: 500 stalls, 100 cursor frames | 630 ms; 100 base paints and 100 stall paints | 29 ms; 1 base paint and 1 stall paint | Reuses unchanged drawing geometry between cursor frames. |
| AI: 150 × 90 m hall, 3 × 3 m stalls | 3,274 ms; 500 stalls | 317 ms; 500 stalls | Same proposal limit and stall count. |
| AI: 80 × 60 m hall, 0.25 m grid, 3 × 2 m stalls | 683 ms; 51 stalls | 1,231 ms; 285 stalls | More complete work; this case is not a latency reduction. |
| AI: two B2B/B2C zones, 3 × 3 m stalls | 2,660 ms; 402 stalls | 328 ms; 402 stalls | Same total: 259 in the larger zone and 143 in the smaller zone. |

Saved AI results: [before](evidence/editor-improvements/ai-before.json) and [after](evidence/editor-improvements/ai-after.json). Fixture definitions are in [benchmark-planner.ts](../scripts/benchmark-planner.ts). From the backend, run:

```powershell
node -r ts-node/register scripts/benchmark-planner.ts
```

An optional output path writes a fresh JSON result. Keep the recorded before/after files unchanged when collecting a new run. The CAD fixture is in `../frontend-angular/src/app/planner/drafting/cad-canvas.component.spec.ts`; from the frontend, run:

```powershell
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless --include=src/app/planner/drafting/cad-canvas.component.spec.ts
```

The recorded runs used the bundled Node executable because the default fnm path had permission issues. Substitute an available Node executable when reproducing them.

## Verification and limits

- 79 focused backend unit tests passed.
- 84 focused frontend tests passed: 29 colour/component/CAD and engine checks, plus 55 existing planner-store and workflow guard checks. This was not a full-suite rerun.
- Four dedicated test-database API checks passed. On Windows, teardown hung until the verified test server was stopped; the runner then exited with code 0.
- Backend type-check and the Angular development build passed.
- Real-browser checks drew two same-type zones in blue and orange, changed the first to green, and verified saved/reloaded colours `#047857` and `#c2410c`. CAD matched those colours, and Pan/Fit plan were exercised. A 64-stall AI proposal was generated, applied and saved on the owned temporary layout 1108; that scratch layout was subsequently removed.
- The fresh visual finish review returned **ship**, with no material fixes, after opening all eight desktop/mobile captures. The existing detector reported 32 advisories and no primary findings. No new raster assets or visual identity were introduced. [Review and evidence](../.impeccable/review/editor-improvements/finish-review.md).

The static mobile captures do not establish touch-drag behavior. External SelfCare synchronization, EMC permissions/approval policy, payment and hold/cancellation workflow, production deployment and broader CAD work remain outstanding. Phase 2 remains in progress.
