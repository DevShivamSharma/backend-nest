# Backend placement and split contract

This contract supersedes the permissive touching/legacy-save behavior described in the older shared `13-rule-driven-layout-editor.md`. Frontend preview follows these semantics; the backend makes the final decision. The October 2026 meeting-rule changes are also documented in `frontend-angular/docs/stall-placement-contract.md`.

## Endpoints

| Endpoint                                         | Success | Purpose                                                                                                             |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /api/layout/save`                          | 201     | Create and validate the entire layout                                                                               |
| `PUT /api/layout/:id`                            | 200     | Replace and validate the entire final layout; move, rotate, resize and generated layouts use this existing endpoint |
| `GET /api/layout/:id`                            | 200     | Consistent persisted snapshot                                                                                       |
| `POST /api/layout/:id/validate`                  | 200     | Audit persisted state, including legacy layouts, without writing                                                    |
| `POST /api/layout/:id/stalls/:stallNumber/split` | 200     | Atomic split; URL-encode the parent identifier                                                                      |
| `PUT /api/halls/:id`                             | 200     | Also validates any layouts owning this hall before changing geometry/rules                                          |
| `POST /api/layout/assist`                        | 200     | Returns proposed placements/removals without saving; see `ai-layout-assistant.md`                                    |
| `POST /api/layout/seed-import`                   | 201     | Trusted historical import exception, enabled only with configured `SEED_TOKEN` and matching `x-seed-token` header   |

There are no separate backend move, rotate or resize endpoints. The assistant proposes a layout; clients must use save/PUT for final validation and persistence of generated placements. PUT is still full replacement, not PATCH. Keep all stalls you want retained, including cancelled split parents. The existing list/delete/stall-type endpoints are unchanged. A successful owned-hall resize updates `layout.hallWidth` and `layout.hallLength` in the same transaction as the hall.

## Coordinates, sides and geometry

- All dimensions, positions and passage widths are **metres**. `posX`/`posZ` remain stall-centre coordinates in the hall-centred X-right/Z-down plan.
- `width` and `length` are local X/Z dimensions. New optional `rotation` is **clockwise degrees in the 2D plan**, around the stall centre. Default 0; persisted in `[0,360)`. Conversion: `x' = x cos θ − z sin θ`, `z' = x sin θ + z cos θ`. A 90° rotation sends local FRONT toward world −X. Three.js consumers should convert this convention explicitly when applying a Y rotation.
- Local sides: FRONT = +Z, BACK = −Z, RIGHT = +X, LEFT = −X. `openSides` rotates with the stall. Entries normalize to uppercase and deduplicate. Missing/null/empty `openSides` derives from `gateSide`, default FRONT. `gateSide` remains the first open side for old clients.
- `hall.boundary` is a simple polygon of `{x,z}` vertices, either winding; an optional repeated closing vertex is accepted. It overrides the nominal rectangular outline, including when extending beyond nominal dimensions. Without it, SQUARE uses centred width/length and CIRCLE uses the exact radius.
- `blockedAreas` with kind `outside` or `wall` subtract physical floor, including holes. Kind `zone` keeps its existing visual-only meaning; physical restrictions belong in `hall.zones`. Explicit boundaries are never expanded using inferred exterior floor regions.
- Every full open-side edge has a rectangular clearance strip extending outward by the selected passage width. The entire strip must fit inside usable floor and contain no active stall. PASSAGE/door-access zones can be walked through; PARTITION, SMOKE_CURTAIN, NO_CONSTRUCTION and FACILITY_ACCESS zones cannot supply this clearance. Existing zone/door/peripheral restrictions still apply to stall footprints.
- All footprint containment, intersections and distances use **rotated polygon edges**, including concave outlines and holes, rather than centres or axis-aligned bounds. Distance comparisons use 1e-6 m tolerance; polygon area tolerance is 1e-12 m². Contact at the far edge of the required strip is allowed.
- Finite numeric inputs must also produce finite, non-degenerate stall edges accurate within 1e-6 m. Inputs that collapse or overflow derived geometry receive HTTP 400 with `INVALID_DIMENSIONS`, `stallIndex` and an empty geometry list; unusable coordinates are not passed to polygon clipping.
- **Between stalls, the passage is required in front of open sides only.** Stalls may share walls, touch at a point or stand any distance apart on their closed sides: a pair of stalls only must not overlap (`STALL_OVERLAP`). No stall may stand in the clearance strip of its own or another stall's open side (`OPEN_SIDE_BLOCKED`, reported on both stalls). `INVALID_BACK_TO_BACK` and `PATHWAY_WIDTH` are no longer issued.
- **Hall corners:** `hall.rules.enabledRules.cornerKeepOut` defaults on. `CORNER_PASSAGE` is issued when the real stall footprint is less than one passage width from both walls adjoining a hall corner. Clearance from either wall at the exact limit is sufficient. Rotated/custom footprints and polygon notches are checked; circles and interior obstacles do not create hall corners. Legacy corner placements need repair or an explicit switch-off before saving.
- **Emergency doors:** when emergency access is enabled, access depth is at least 3 m even with a narrower aisle or `openingAccessDepth`. Larger `emergencyExitClearance` values are honored; new values below 3 m are rejected. Other doors still use `openingAccessDepth` or the selected aisle width.
- CANCELLED stalls occupy no space, but their identifiers remain reserved while retained. Split parents are permanently cancelled containers and cannot be resurrected, removed or geometrically changed through PUT.

## Passage width and persistence

Keep the existing field `hall.rules.minPassageWidth: { B2B, B2C }`. `eventType` selects the active value. Each supplied value must be a finite number from **1.5 to 5 inclusive** (fractions allowed); strings, null values and out-of-range numbers are rejected, never clamped. Omitted values default to **3 for both event types**. Existing explicitly stored B2C=4 remains 4.

WP-1 also persists `maxUtilization` (default 0.7) and `eventSeparation` (default 3 m) in the existing rules JSONB. This work package stores the values; utilization enforcement and zone separation follow in later work packages.

Explicit selections persist in the hall's existing `rules` JSONB. Absent/null rules retain the 3 m default and do not turn on optional grid/peripheral restrictions. With a rules object, the existing defaults remain 1 m peripheral clearance and 1 m size snap; these are independent of passage width and may be configured as before. Hall boundary, zones, blocked areas and open sides retain their existing fields and persistence. Rotation and split lineage are additional stall columns.

### Create example

```http
POST /api/layout/save
Content-Type: application/json
```

```json
{
  "layoutName": "Expo",
  "eventType": "B2B",
  "hall": {
    "name": "Main",
    "shape": "SQUARE",
    "width": 60,
    "length": 60,
    "rules": { "minPassageWidth": { "B2B": 5, "B2C": 5 }, "peripheralClearance": 0 }
  },
  "stalls": [
    {
      "name": "Section",
      "stallNumber": "5-10",
      "width": 12,
      "length": 4,
      "height": 3,
      "posX": 0,
      "posZ": 0,
      "rotation": 0,
      "openSides": ["FRONT"]
    }
  ]
}
```

The existing `{message, layout, hall, stalls}` response envelope is preserved; `layout.hall` and `layout.stalls` repeat the top-level values. IDs remain numeric. Example stall response (generated numeric IDs are illustrative):

```json
{
  "id": 1000,
  "name": "Section",
  "stallNumber": "5-10",
  "width": 12,
  "length": 4,
  "height": 3,
  "posX": 0,
  "posZ": 0,
  "rotation": 0,
  "openSides": ["FRONT"],
  "gateSide": "FRONT",
  "color": "#3498db",
  "status": "AVAILABLE",
  "stallTypeId": null,
  "parentStallNumber": null,
  "isSplitParent": false
}
```

Creation now accepts unique explicit section identifiers such as `5-10` (up to 255 characters). Missing identifiers retain the existing `STALL-001` sequence. On PUT, echo existing `stallNumber` values to preserve identity. Unknown identifiers on PUT retain the previous behavior: they are replaced by newly generated sequence numbers. Numeric database stall IDs still change on PUT; do not use them as permanent identity. `parentStallNumber` and `isSplitParent` are server-owned; PUT restores them by issued identifier and cannot forge lineage.

### Split example

```http
POST /api/layout/1000/stalls/5-10/split
Content-Type: application/json
```

```json
{
  "idempotencyKey": "section-5-10-v1",
  "children": [
    {
      "name": "A",
      "width": 3,
      "length": 4,
      "height": 3,
      "posX": -4,
      "posZ": 0,
      "rotation": 0,
      "openSides": ["FRONT"]
    },
    {
      "name": "B",
      "width": 3,
      "length": 4,
      "height": 3,
      "posX": 4,
      "posZ": 0,
      "rotation": 0,
      "openSides": ["FRONT"]
    }
  ]
}
```

Response: the usual complete layout envelope with message `Stall split successfully.`. The stalls are the retained cancelled parent `5-10` (`isSplitParent: true`) and children `5-10-A`, `5-10-B` (`parentStallNumber: "5-10"`). Array order assigns suffixes: A…Z, AA, AB…AZ, BA…ZZ, AAA. The identifier is never parsed as dimensions. Child-supplied identifiers are ignored. Nested splitting uses the entire immediate parent identifier, e.g. `5-10-A-A`.

Supply 2 or more active children with complete geometry. Children must fit inside the actual rotated parent footprint; they may leave internal passage space and need not tile its area. Every final active stall must satisfy all placement rules. Parent plus children count against `MAX_STALLS_PER_LAYOUT` (default 2000).

`idempotencyKey` is required (1–128 letters/digits/underscore/hyphen), scoped to the layout. Same key, parent and child payload retries return the current persisted layout without creating records; object-key ordering is ignored, child array order is significant. Reusing a key with a different payload/parent or splitting an already-split parent with another key returns **409** with a useful `message`. Replays after later edits return current state, not a cached historical response.

The transaction locks the layout before reading children or allocating identifiers. Layout PUT, split, hall edits and delete use the same lock ordering. Parent snapshot, child identifiers, lineage and replacement rows commit together. Database uniqueness on `(layout_id, stall_number)`, `(layout_id, parent_number)` and `(layout_id, idempotency_key)` plus a deferred lineage FK prevent duplicate and orphan split records. A stale pre-split PUT is rejected. Ordinary concurrent full-layout PUTs retain the API's serialized last-writer behavior; there is no new revision/ETag contract.

## Validation errors

Geometry rejection is HTTP **400**, retaining the existing envelope and adding structured `violations`. No writes commit. Example:

```json
{
  "success": false,
  "status": 400,
  "message": "Stall 0 (A) placement rejected: FRONT passage is blocked by 1.",
  "violations": [
    {
      "stallIndex": 0,
      "stallNumber": null,
      "code": "OPEN_SIDE_BLOCKED",
      "ruleRef": "Placement",
      "message": "FRONT passage is blocked by 1.",
      "side": "FRONT",
      "requiredWidth": 3,
      "relatedStallIds": ["1"],
      "geometry": [
        {
          "type": "polygon",
          "points": [
            { "x": 1, "z": 1 },
            { "x": -1, "z": 1 },
            { "x": -1, "z": 4 },
            { "x": 1, "z": 4 }
          ]
        }
      ]
    }
  ]
}
```

On save/PUT/split, `stallIndex` and `relatedStallIds` refer to zero-based final-layout array indexes (split response includes the parent). Audit uses persisted numeric row IDs serialized as strings. Open-side failures include `side` and `requiredWidth`. Geometry is a polygon for rotated shapes; render the complete supplied geometry, not assumed axis-aligned rectangles.

Audit returns `{layoutId, ruleDriven, valid, entries}`. Each entry carries `stallId`, `stallNumber` and `violations`. Symmetric pair errors are deduplicated, but each affected open side keeps its own `OPEN_SIDE_BLOCKED` error. Numeric identifiers generated with the configured prefix must stay below 2147483646; exhaustion is rejected with HTTP 400 before database writes.

Codes: `INVALID_DIMENSIONS`, `OUTSIDE_HALL`, `STALL_OVERLAP`, `CORNER_PASSAGE`, `INVALID_BACK_TO_BACK`, `PATHWAY_WIDTH`, `OPEN_SIDE_PASSAGE`, `OPEN_SIDE_BLOCKED`, `PERIPHERAL_CLEARANCE`, `RESTRICTED_ZONE`, `ENTRY_EXIT_BLOCKED`, `EMERGENCY_ACCESS`, `SPLIT_OUTSIDE_PARENT`, `INVALID_STALL_IDENTIFIER`. Invalid passage settings use `INVALID_PASSAGE_WIDTH` with `field`, `value`, `min: 1.5`, `max: 5` instead of stall geometry. Existing malformed-input/type errors retain HTTP 400 and `message`; split conflicts and database constraints use 409.

## Migration and existing data

`1758240600000-AddPlacementAndSplits.ts` adds rotation default 0, nullable parent identifier, split-parent flag default false, and the `layout_splits` ledger with uniqueness and deferred foreign key. It widens `stall_number` from 32 to 255. Existing geometry, numbers, open sides, rules and relationships are not rewritten or renumbered. The FK is installed NOT VALID so historical data is not rescanned; new writes are still checked. Down removes the new columns/ledger and retains widened identifiers to avoid truncation; reverting after creating splits discards lineage and rotation, so back up first.

Run `npm run migration:show` then `npm run migration:run` with the intended environment. The application's existing `migrationsRun: true` also applies pending migrations on startup. This change was applied only to the local isolated test database during verification, not to the development/production database.

Legacy invalid layouts remain readable/auditable. Normal planner save/update/split and owned-hall updates validate the whole final state, including unchanged stalls, rule changes, rotation and open-side changes; repair invalid placements before saving.

**Historical-import exception:** trusted seed scripts and the existing `POST /api/layout/seed-import` route deliberately call `skipPlacementRules: true`. The route returns 404 without a configured matching seed token. Authorized imports still validate DTOs, numeric geometry, hall input and identifiers, but may persist overlapping stalls or insufficient passages. The planner must not use this route; imported violations remain visible through audit. This exception was already present when the September 27 adversarial audit began and was preserved. It is not a guarantee that every HTTP write enforces placement rules.

The September 27 audit required no additional schema migration. Detailed coverage, reproduced failures and executed commands are in `planner-validation-test-report.md`.

## Meeting workflow additions (3 October 2026)

`hall.planningZones` is an optional array of up to 100 zones. A zone contains a unique nonblank `id`, `label`, `kind` (`MEDIA`, `ADMIN`, `FOOD`, `EXHIBITION`), `eventType` (`B2B`, `B2C`) and a simple `polygon` of `{x,z}` points. Polygons must have positive area, stay inside the usable floor and may touch but cannot overlap. Send `[]` to remove all planning zones. Invalid zone structure/geometry is always rejected, including during publish with an override.

Media/Admin are internal. When planning zones exist, a stall must fit wholly inside one Food/Exhibition zone. Distinct B2B/B2C zone stalls require at least `rules.eventSeparation` (minimum 3 m) between actual footprints. Rotated/custom footprints participate in validation and area calculation; cancelled stalls do not consume usable stall area. Added violation codes are `INTERNAL_ZONE`, `ZONE_BOUNDARY` and `EVENT_SEPARATION`.

The assist body accepts an optional `zoneId` alongside the complete hall, existing stalls and requirement. It must identify a sellable zone. Without it the planner visits sellable zones by descending area. AI proposals stop at the remaining hall utilization budget: `rules.maxUtilization` is greater than zero and at most 0.7 (default 0.7). The denominator is actual floor area minus non-traversable obstacles, not the hall bounding rectangle. Manual layouts can exceed that budget, but publication then requires an explicit override.

### Publishing

- `POST /api/layout/publish` creates and publishes a new layout.
- `POST /api/layout/:id/publish` publishes a full replacement of an existing layout.
- Both require the ordinary complete save payload (`hall`, `stalls`, optional `layoutName`, `eventType`, `ruleIds`), plus optional `overrideReason`. They are not empty-body status toggles.
- Empty active layouts are rejected. The server recomputes placement issues, `MAX_UTILIZATION` and `DISABLED_RULE` issues. With any issues, a trimmed, nonblank reason of at most 1,000 characters is required; otherwise HTTP 400 includes the issues. Numeric, structural, identity and zone-shape validation cannot be overridden.
- Success returns the normal detail envelope. `layout.status` is `PUBLISHED`, `publishedAt` is the server timestamp, and `publishOverrides` is either null or `{reason, issues}`. Missing stall identifiers are allocated before the reviewed issue record is built; existing identifiers and split lineage are retained. Geometry and publication metadata commit together.
- Ordinary save/update, split and owned-hall edits reset publication to `DRAFT` and clear its timestamp/override record. The UI also shows Draft immediately when a published snapshot changes locally.
- The client displays at most three independently checked 6 × 6 m empty-space suggestions, with bounded search. They are alternatives, not a jointly validated placement proposal; there may be no suggestion even when some differently sized space remains.

Migration `1791000000000-PlanningZonesAndPublish.ts` adds nullable `hall.planning_zones`, `layouts.status` (existing rows default Draft), `published_at` and `publish_overrides`. It is registered in the explicit migration list and has been applied to the local development and isolated test databases. No remote deployment is included.

The executable Hall 12A fixture and 10-minute script are documented in [meeting-demo.md](meeting-demo.md).

## Tests

```text
npm run typecheck
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run test:api
```

Run database suites sequentially: existing Jest tests truncate the isolated database. Both test harnesses use local `stall_designer_test` and refuse non-local hosts; `.env` provides discrete local PostgreSQL credentials. Managed database URLs are removed before boot and are not reloaded. The database must exist and the user must be able to migrate it. Playwright starts an actual API at `127.0.0.1:18081`, uses APIRequestContext only, and stops it afterward; no browser installation or frontend UI tests are needed. Migration compatibility uses a disposable schema in a rolled-back transaction. API rollback testing injects a temporary database trigger into the test database only.
