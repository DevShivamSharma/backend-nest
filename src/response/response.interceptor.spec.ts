import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';

import { ResponseInterceptor } from './response.interceptor';

function run(
  handlerData: unknown,
  metadata: { custom?: string; raw?: boolean } = {},
  statusCode = 200,
) {
  const reflector = {
    get: () => metadata.custom,
    getAllAndOverride: () => metadata.raw,
  } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getResponse: () => ({ statusCode }) }),
  } as unknown as ExecutionContext;
  const next = { handle: () => of(handlerData) } as CallHandler;

  return lastValueFrom(new ResponseInterceptor(reflector).intercept(context, next));
}

describe('ResponseInterceptor', () => {
  it("should wrap what a route returns in the header and data ITPO's services use", async () => {
    expect(await run({ id: 1 })).toEqual({
      header: { code: 200, error: false, success: true, msg: 'Success' },
      data: { id: 1 },
    });
  });

  it('should carry the status of the response, e.g. 201 for a create', async () => {
    expect(((await run({ id: 1 }, {}, 201)) as { header: { code: number } }).header.code).toBe(201);
  });

  it('should use the message a route sets', async () => {
    const result = (await run(undefined, { custom: 'You have been successfully logged out.' })) as {
      header: { msg: string };
    };

    expect(result.header.msg).toBe('You have been successfully logged out.');
  });

  it('should answer data: null when a route returns nothing', async () => {
    expect(((await run(undefined)) as { data: unknown }).data).toBeNull();
  });

  it('should leave a raw route (the health checks) as it is', async () => {
    expect(await run({ status: 'ok' }, { raw: true })).toEqual({ status: 'ok' });
  });
});
