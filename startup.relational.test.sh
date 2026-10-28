#!/usr/bin/env bash
set -e

/opt/wait-for-it.sh postgres:5432
/opt/wait-for-it.sh redis:6379
npm install
npm run migration:run
npm run start:dev
