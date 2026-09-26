# Placement implementation and verification

Implemented in backend-nest only. Frontend repositories were not modified. Code discovery used codebase-memory-mcp; the graph was indexed before discovery and refreshed after implementation.

## Delivered behavior

- Shared authoritative validation for layout create/full replacement (including move/rotate/resize/generated placements), split, and updates of layout-owned halls.
- Configurable 3–5 m passage, default 3 m, strict validation of supplied settings.
- Rotated edge geometry, full open-side strips, actual irregular outlines/holes, corner separation, walkable corner gaps and constrained back-to-back contact.
- Persistent rotation, open sides, selected hall rules, lineage and stable section identifiers.
- Atomic split endpoint with layout row locking, scoped idempotency keys, database uniqueness, parent snapshots, deferred lineage FK, and rollback on late database failure.
- Explicit identifiers such as `5-10`; children `5-10-A` … `5-10-Z`, `5-10-AA`, `5-10-AB` …; no dimension parsing.
- Old invalid layouts remain readable/auditable but cannot be resaved without repair. Unchanged footprints no longer bypass final validation.

[Full API integration contract and examples](placement-api.md). There are no standalone move/rotate/resize/auto-layout endpoints in this backend; the existing save/PUT path validates their final layouts.

## Final actual test results

Environment: Windows PowerShell, Node.js v20.20.2, real local PostgreSQL, isolated `stall_designer_test`. Database test suites ran sequentially for the final verification.

| Exact command                             | Actual result                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run typecheck`                       | Passed, no TypeScript errors                                                 |
| `npm run build`                           | Passed, Nest production build                                                |
| `npm test -- --runInBand`                 | **252 passed**, 11 suites; 35.876 s                                          |
| `npm run test:e2e -- --runInBand`         | **27 passed**, 3 suites; 45.908 s                                            |
| `npm run test:api`                        | **10 passed**, 25.8 s; Playwright against a listening API at 127.0.0.1:18081 |
| `git -c core.safecrlf=false diff --check` | Passed                                                                       |

Formatting was checked with `npx prettier --check` on all changed/new TypeScript files and the contract; the exact PowerShell commands are below. The report itself is Markdown.

```powershell
$changedTs = @(git -c core.safecrlf=false diff --name-only -- '*.ts')
$newTs = @(git ls-files --others --exclude-standard -- '*.ts')
npx prettier --check @changedTs @newTs docs/placement-api.md docs/placement-implementation.md
```

Coverage includes insufficient/exact 3 m and 5 m corner passages, invalid width types/ranges, valid and invalid open-side arrangements, touching rotated backs, arbitrary rotations, concave notches and narrow exterior slivers, blocked-floor holes, circular floors, rule changes on unchanged stalls, move/rotation/resize PUT validation, duplicate identifiers, split suffix transitions, repeated/concurrent requests, child-number collisions, stale pre-split PUT rejection, persisted reloads, and rollback after a database trigger rejects a child insertion.

The migration compatibility test creates a temporary schema inside a transaction, inserts a pre-migration `5-10` row with existing open sides, runs up/down/up, checks defaults and unchanged identity, validates the lineage FK, then rolls the whole schema back.

## Migration and rollout

New migration: `src/database/migrations/1758240600000-AddPlacementAndSplits.ts`, registered in `src/database/data-source-options.ts`.

- Adds `stalls.rotation`, `stalls.parent_stall_number`, `stalls.is_split_parent`.
- Widens `stalls.stall_number` to 255 without renumbering existing records.
- Adds `layout_splits` with scoped uniqueness and a deferred parent identity FK.
- Existing explicit passage settings remain in `hall.rules` JSONB; absent values default to 3 m.
- Tested on the isolated test database only. Development/production migrations were **not run**. Use the existing `npm run migration:show` / `npm run migration:run` rollout workflow (startup also runs pending migrations).
- Down removes rotation/lineage/ledger data; it deliberately does not narrow identifier length. Back up before reverting after live splits.

No service or tooling blockers remain. Browser UI E2E was not run because this task is backend-only; Playwright API tests were run. No commit, push or deployment was performed.

## Changed files

All paths below are relative to backend-nest. Files include implementation, migration, integration contract, regression updates, dependencies and isolated API test tooling.

- `.gitignore`
- `docs/placement-api.md`
- `docs/placement-implementation.md`
- `package-lock.json`
- `package.json`
- `playwright.config.ts`
- `src/app.module.ts`
- `src/database/data-source-options.ts`
- `src/database/migrations/1758240600000-AddPlacementAndSplits.ts`
- `src/halls/hall.repository.ts`
- `src/layouts/dto/layout-response.dto.ts`
- `src/layouts/dto/layout-save-request.dto.ts`
- `src/layouts/entities/hall.entity.ts`
- `src/layouts/entities/stall.entity.ts`
- `src/layouts/layout.controller.ts`
- `src/layouts/layout.repository.ts`
- `src/layouts/layout.service.spec.ts`
- `src/layouts/layout.service.ts`
- `src/layouts/layout.validator.spec.ts`
- `src/layouts/layout.validator.ts`
- `src/layouts/placement/assert-placements.ts`
- `src/layouts/placement/authoritative-placement.spec.ts`
- `src/layouts/placement/hall-geometry.ts`
- `src/layouts/placement/oriented-placement.ts`
- `src/layouts/placement/placement-rules.spec.ts`
- `src/layouts/placement/placement-rules.ts`
- `src/layouts/placement/polygon-geometry.ts`
- `src/layouts/split-numbering.ts`
- `test/api-server.ts`
- `test/api/placement.spec.ts`
- `test/layout-rules.e2e-spec.ts`
- `test/layouts.e2e-spec.ts`
- `test/placement-migration.e2e-spec.ts`
- `test/setup-env.ts`
