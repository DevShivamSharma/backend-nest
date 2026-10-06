import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AllExceptionsFilter, ErrorResponseBody } from './all-exceptions.filter';

interface Captured {
  status: number;
  body: ErrorResponseBody;
}

function run(exception: unknown): Captured {
  const captured = {} as Captured;

  const response = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: ErrorResponseBody) {
      captured.body = body;
      return this;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/admin/organisations' }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);

  return captured;
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('passes an HTTP exception through with its status and message', () => {
    const { status, body } = run(
      new ForbiddenException('You do not have access to this organisation.'),
    );

    expect(status).toBe(403);
    expect(body).toEqual({ status: 403, message: 'You do not have access to this organisation.' });
  });

  it('leads with the first validation message and lists them all', () => {
    const { status, body } = run(new BadRequestException(['slug is invalid', 'name is required']));

    expect(status).toBe(400);
    expect(body.message).toBe('slug is invalid');
    expect(body.details).toEqual(['slug is invalid', 'name is required']);
  });

  it('omits details for a single validation message', () => {
    const { body } = run(new BadRequestException(['slug is invalid']));

    expect(body).toEqual({ status: 400, message: 'slug is invalid' });
  });

  it('handles a string payload', () => {
    const { status, body } = run(new HttpException('Payload Too Large', 413));

    expect(status).toBe(413);
    expect(body.message).toBe('Payload Too Large');
  });

  it('keeps an unknown route at 404', () => {
    expect(run(new NotFoundException()).status).toBe(404);
  });

  it.each(['23505', '23503', '23502'])('maps SQLSTATE %s to 409', (code) => {
    const { status, body } = run(Object.assign(new Error('insert failed'), { code }));

    expect(status).toBe(409);
    expect(body.message).toBe(AllExceptionsFilter.CONFLICT_MESSAGE);
  });

  it('reads the SQLSTATE from a TypeORM driverError wrapper', () => {
    const { status } = run(Object.assign(new Error('failed'), { driverError: { code: '23505' } }));

    expect(status).toBe(409);
  });

  it('returns a fixed 500 message and never the cause', () => {
    const { status, body } = run(new Error('relation "users" does not exist'));

    expect(status).toBe(500);
    expect(body.message).toBe(AllExceptionsFilter.INTERNAL_MESSAGE);
    expect(body.message).not.toContain('users');
  });

  it('handles a non-Error throwable', () => {
    expect(run('a thrown string').status).toBe(500);
  });
});
