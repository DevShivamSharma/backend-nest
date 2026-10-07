# Venue platform — API

NestJS 11 + TypeORM + PostgreSQL. Module A of the platform: organisations (tenants), their
configuration, users, dynamic roles and permissions, invitations, sign-in and the audit log.

## Setup

```bash
npm install
cp .env.example .env          # fill in the database and JWT_ACCESS_SECRET
npm run migration:run         # also runs automatically at start-up
npm run admin:create          # creates the Super Admin from SUPER_ADMIN_* in .env
npm run start:dev             # http://localhost:8080/api
```

Tests:

```bash
npm test                      # unit tests
npm run test:e2e              # full API flows against the local venue_platform_test database
```

The e2e suite wipes and rebuilds `venue_platform_test` on every run; it refuses to run
against anything but a local host.

## Modules

| Module | Responsibility |
| --- | --- |
| `auth` | Login, refresh-token rotation (httpOnly cookie, reuse detection), logout, `me`, accept invitation, password reset. Global `JwtAuthGuard`; `@Public()` opts out. |
| `users` | Accounts (one per email across the platform), argon2id passwords. |
| `organisations` | Tenants: slug (old slugs kept as aliases), status, booking mode, features, limits, versioned configuration. `GET /api/orgs/:slug/public-config`. |
| `roles` | Dynamic RBAC: the permission catalogue (code) and roles (data). |
| `access` | Memberships and `OrgAccessGuard`, which every `/api/orgs/:slug/...` route uses. |
| `team` | Members and invitations of an organisation. |
| `org-settings` | An organisation's own configuration and audit log. |
| `admin` | The Super Admin console under `/api/admin`. |
| `audit`, `mail` | Append-only audit log; outgoing email (log transport for now). |

## Access rules

1. Every route needs a signed-in user unless marked `@Public()`.
2. `/api/orgs/:slug/...`: the slug must name an **active** organisation (else 404), the user
   must be a **member** (else 403 — the Super Admin is not a member by default), and the
   member's role must hold **every permission** the route declares with
   `@OrgAccess(...)` / `@RequirePermissions(...)` (else 403).
3. `/api/admin/...`: Super Admin only.
4. Nobody can give a role holding permissions they lack, or act on a member who holds more
   than they do. Every organisation keeps at least one Venue Admin (the locked owner role,
   which always holds every permission).

Permissions live in `src/roles/permissions.ts`. Ones marked `available: false` belong to
modules not built yet: they can be given to roles now and take effect when their module
checks them. Event-scoped roles (organiser, exhibitor) can be given once events exist.
