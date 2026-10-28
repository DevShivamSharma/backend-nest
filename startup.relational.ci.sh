#!/usr/bin/env bash
set -e

/opt/wait-for-it.sh postgres:5432
npm run migration:run
npm run start:prod > prod.log 2>&1 &
/opt/wait-for-it.sh redis:6379
/opt/wait-for-it.sh localhost:3010
npm run lint
npm run test:e2e -- --runInBand
