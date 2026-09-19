import 'reflect-metadata';

import { DataSource } from 'typeorm';

import { configuration } from '../config/configuration';
import { validateEnv } from '../config/env.validation';
import { buildDataSourceOptions } from './data-source-options';

/**
 * Entry point for the TypeORM CLI only (npm run migration:run / migration:revert).
 * The environment is loaded by `node --env-file=.env` in the npm script and validated here with
 * the same validator the application uses.
 */
validateEnv(process.env);

export default new DataSource(buildDataSourceOptions(configuration().database));
