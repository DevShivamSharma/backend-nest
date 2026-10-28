# EMS API - ITPO Stall Planning Portal (backend)

NestJS 11 + TypeORM + PostgreSQL, on the same base as ITPO's own backends (`itpo_admin`, `itpo_user`,
`itpo_stalls_be`): `registerAs` configs with env validation, `{ header, data }` responses, URI
versioning under an API prefix, a global exception filter, Docker and CI files.

## Layout

```
src/
  main.ts                  bootstrap: prefix, versioning, pipes, filter, interceptors, Swagger
  app.module.ts
  config/                  app config (+ AllConfigType)
  database/                config/, typeorm-config.service.ts, data-source.ts (CLI), migrations/
  common/                  filters/, pipes/, decorators/, constants/, health/, redis-service/
  response/                ResponseInterceptor ({ header, data })
  utils/                   validate-config, validation-options, serializer interceptor
  auth/                    controllers/ services/ guards/ domain/ dto/ config/
  halls/                   controllers/ services/ domain/ dto/
  events/                  controllers/ services/ dto/
  rules/                   controllers/ services/ domain/ dto/
```

## Run

```bash
npm install
cp .env.example .env              # same variable names as ITPO's backends
npm run migration:run             # creates our three tables in schema idp
npm run start:dev                 # http://localhost:3010/ems/itpo/api/v1/...
```

- Routes: `<API_PREFIX>/v1/...`, default `ems/itpo/api` (e.g. `POST /ems/itpo/api/v1/auth/login`).
  `/health` and `/health/ready` sit outside the prefix.
- Every route needs a Bearer token except login and refresh.
- Swagger at `/ems/docs` behind basic auth (`SWAGGER_USERNAME` / `SWAGGER_PASSWORD`).
- Responses: `{ "header": { "code", "error", "success", "msg" }, "data": ... }`. Errors answer HTTP
  200 with the real status in `header.code`, as ITPO's services do (`ERROR_HTTP_STATUS=real` for the
  real HTTP status).

## Database

ITPO's tables live in schema `idp` and are written as `idp."T_..."` in SQL. Our own tables
(`T_AUTH_REVOKED_SESSION`, `T_RULE_SET`, `T_EVENT_RULE_SWITCH`) are created there by migrations;
the history goes in `public.migrations`, which ITPO's services share, so `migration:revert`
reverts the last migration of any service.

```bash
npm run migration:show | migration:run | migration:revert
```

Migrations are not run by the app on start; run them before it (see `Procfile`,
`startup.relational.*.sh`).

## Auth

Login checks ITPO's `T_USER` (bcrypt). `org_id` null is ITPO staff, set is an organiser. The token has
ITPO's claims (`id`, `role`, `sessionId`, `orgId`), signed with ITPO's `AUTH_JWT_SECRET`; login also
writes `session:<id>` and `roles:<id>` in the Redis ITPO's services use, and the user's row in
`T_AUTH_TOKEN`, so their services accept the token too. One session per user.

## Scripts

`npm test` (unit), `npm run test:e2e` (needs the database and Redis of the environment),
`npm run lint`, `npm run typecheck`, `npm run build`.

Docker: `docker compose up` (Postgres, Redis, Adminer, API); CI: `docker-compose.relational.ci.yaml`.
