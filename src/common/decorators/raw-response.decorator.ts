import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/**
 * Opts a route out of the `{ header, data }` envelope and of "errors are HTTP 200", for the
 * routes a load balancer reads by status code (the health checks).
 */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
