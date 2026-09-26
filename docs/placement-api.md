# Backend placement and split contract

This contract supersedes the permissive touching/legacy-save behavior described in the older shared `13-rule-driven-layout-editor.md`. No frontend files were changed. No newer frontend split/rotation contract was found in the shared docs. Frontend preview must implement these semantics; the backend makes the final decision.

## Endpoints

| Endpoint                                         | Success | Purpose                                                                                                             |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `POST /api/layout/save`                          | 201     | Create and validate the entire layout                                                                               |
| `PUT /api/layout/:id`                            | 200     | Replace and validate the entire final layout; move, rotate, resize and generated layouts use this existing endpoint |
| `GET /api/layout/:id`                            | 200     | Consistent persisted snapshot                                                                                       |
| `POST /api/layout/:id/validate`                  | 200     | Audit persisted state, including legacy layouts, without writing                                                    |
| `POST /api/layout/:id/stalls/:stallNumber/split` | 200     | Atomic split; URL-encode the parent identifier                                                                      |
| `PUT /api/halls/:id`                             | 200     | Also validates any layouts owning this hall before changing geometry/rules                                          |

There are no separate backend move, rotate, resize or auto-layout endpoints. Clients sending generated layouts must use save/PUT. PUT is still full replacement, not PATCH. Keep all stalls you want retained, including cancelled split parents. The existing list/delete/stall-type endpoints are unchanged.

## Coordinates, sides and geometry

- All dimensions, positions and passage widths are **metres**. `posX`/`posZ` remain stall-centre coordinates in the hall-centred X-right/Z-down plan.
- `width` and `length` are local X/Z dimensions. New optional `rotation` is **clockwise degrees in the 2D plan**, around the stall centre. Default 0; persisted in `[0,360)`. Conversion: `x' = x cos θ − z sin θ`, `z' = x sin θ + z cos θ`. A 90° rotation sends local FRONT toward world −X. Three.js consumers should convert this convention explicitly when applying a Y rotation.
- Local sides: FRONT = +Z, BACK = −Z, RIGHT = +X, LEFT = −X. `openSides` rotates with the stall. Entries normalize to uppercase and deduplicate. Missing/null/empty `openSides` derives from `gateSide`, default FRONT. `gateSide` remains the first open side for old clients.
- `hall.boundary` is a simple polygon of `{x,z}` vertices, either winding; an optional repeated closing vertex is accepted. It overrides the nominal rectangular outline, including when extending beyond nominal dimensions. Without it, SQUARE uses centred width/length and CIRCLE uses the exact radius.
- `blockedAreas` with kind `outside` or `wall` subtract physical floor, including holes. Kind `zone` keeps its existing visual-only meaning; physical restrictions belong in `hall.zones`. Explicit boundaries are never expanded using inferred exterior floor regions.
- Every full open-side edge has a rectangular clearance strip extending outward by the selected passage width. The entire strip must fit inside usable floor and contain no active stall. PASSAGE/door-access zones can be walked through; PARTITION, SMOKE_CURTAIN, NO_CONSTRUCTION and FACILITY_ACCESS zones cannot supply this clearance. Existing zone/door/peripheral restrictions still apply to stall footprints.
- All footprint containment, intersections and distances use **rotated polygon edges**, including concave outlines and holes, rather than centres or axis-aligned bounds. Distance comparisons use 1e-6 m tolerance; polygon area tolerance is 1e-12 m². Contact at the far edge of the required strip is allowed.
- A corner stall has its footprint within the selected passage width of **both incident segments of an actual non-collinear usable-floor vertex**. Convex and concave corners and physical cut-outs count; collinear vertices and a circle's bounding box do not. Corner stalls require at least the selected edge-to-edge distance from other active stalls. For nearest neighbours, the complete gap region (convex hull joining their footprints minus the footprints themselves) must fit inside walkable floor, excluding physical restricted zones; a narrow floor sliver or exterior notch cannot be counted as passage.
- Non-corner contact is permitted only along a positive-length shared edge when **each stall has exactly one open side**, the two world-space open normals are opposite, and both point directly away from that shared edge. Side-by-side, point-only or open-face touching is rejected. Nonzero gaps retain the existing minimum-passage rule.
- CANCELLED stalls occupy no space, but their identifiers remain reserved while retained. Split parents are permanently cancelled containers and cannot be resurrected, removed or geometrically changed through PUT.

## Passage width and persistence

Keep the existing field `hall.rules.minPassageWidth: { B2B, B2C }`. `eventType` selects the active value. Each supplied value must be a finite number from **3 to 5 inclusive** (fractions allowed); strings, null values and out-of-range numbers are rejected, never clamped. Omitted values default to **3 for both event types**. Existing explicitly stored B2C=4 remains 4.

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
  "message": "Stall 0 (A) placement rejected: Required 3 m clear passage; 2 m available next to 1.",
  "violations": [
    {
      "stallIndex": 0,
      "stallNumber": null,
      "code": "PATHWAY_WIDTH",
      "ruleRef": "Placement",
      "message": "Required 3 m clear passage; 2 m available next to 1.",
      "requiredWidth": 3,
      "actualWidth": 2,
      "relatedStallIds": ["1"],
      "geometry": [
        {
          "type": "polygon",
          "points": [
            { "x": -1, "z": -1 },
            { "x": 1, "z": -1 },
            { "x": 1, "z": 1 },
            { "x": -1, "z": 1 }
          ]
        }
      ]
    }
  ]
}
```

On save/PUT/split, `stallIndex` and `relatedStallIds` refer to zero-based final-layout array indexes (split response includes the parent). Audit uses persisted numeric row IDs serialized as strings. Open-side failures include `side` and `requiredWidth`. Geometry is a polygon for rotated shapes; render the complete supplied geometry, not assumed axis-aligned rectangles.

Codes: `INVALID_DIMENSIONS`, `OUTSIDE_HALL`, `STALL_OVERLAP`, `CORNER_PASSAGE`, `INVALID_BACK_TO_BACK`, `PATHWAY_WIDTH`, `OPEN_SIDE_PASSAGE`, `OPEN_SIDE_BLOCKED`, `PERIPHERAL_CLEARANCE`, `RESTRICTED_ZONE`, `ENTRY_EXIT_BLOCKED`, `EMERGENCY_ACCESS`, `SPLIT_OUTSIDE_PARENT`, `INVALID_STALL_IDENTIFIER`. Invalid passage settings use `INVALID_PASSAGE_WIDTH` with `field`, `value`, `min: 3`, `max: 5` instead of stall geometry. Existing malformed-input/type errors retain HTTP 400 and `message`; split conflicts and database constraints use 409.

## Migration and existing data

`1758240600000-AddPlacementAndSplits.ts` adds rotation default 0, nullable parent identifier, split-parent flag default false, and the `layout_splits` ledger with uniqueness and deferred foreign key. It widens `stall_number` from 32 to 255. Existing geometry, numbers, open sides, rules and relationships are not rewritten or renumbered. The FK is installed NOT VALID so historical data is not rescanned; new writes are still checked. Down removes the new columns/ledger and retains widened identifiers to avoid truncation; reverting after creating splits discards lineage and rotation, so back up first.

Run `npm run migration:show` then `npm run migration:run` with the intended environment. The application's existing `migrationsRun: true` also applies pending migrations on startup. This change was applied only to the local isolated test database during verification, not to the development/production database.

Legacy invalid layouts remain readable/auditable. Every new HTTP save/update validates the whole final state, including unchanged stalls, rule changes, rotation and open-side changes; repair invalid placements before saving. Trusted seed scripts keep their existing explicit placement-rule bypass, which is not exposed through HTTP.

## Tests

```text
npm run typecheck
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run test:api
```

Run database suites sequentially: existing Jest tests truncate the isolated database. Both test harnesses use local `stall_designer_test` and refuse non-local hosts; `.env` provides discrete local PostgreSQL credentials. Managed database URLs are removed before boot and are not reloaded. The database must exist and the user must be able to migrate it. Playwright starts an actual API at `127.0.0.1:18081`, uses APIRequestContext only, and stops it afterward; no browser installation or frontend UI tests are needed. Migration compatibility uses a disposable schema in a rolled-back transaction. API rollback testing injects a temporary database trigger into the test database only.
