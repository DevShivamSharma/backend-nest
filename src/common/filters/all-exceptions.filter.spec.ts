import {
  ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { BadRequestDomainError, DataIntegrityDomainError } from '../errors/domain.errors';
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
      getRequest: () => ({ method: 'POST', url: '/api/layout/save' }),
    }),
  } as unknown as ArgumentsHost;

  new AllExceptionsFilter().catch(exception, host);

  return captured;
}

describe('AllExceptionsFilter', () => {
  beforeAll(() => {
    // The filter logs every failure through the Nest logger, which writes to stdout directly
    // rather than through console. Silence it at the Logger so test output stays readable.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('always uses the Java body shape: success, status, message', () => {
    const { body } = run(new BadRequestDomainError('Hall name is required.'));

    expect(Object.keys(body)).toEqual(['success', 'status', 'message']);
    expect(body.success).toBe(false);
  });

  describe('branch 1 — IllegalArgumentException equivalent', () => {
    it('maps to 400 with the message passed through verbatim', () => {
      const { status, body } = run(new BadRequestDomainError('Hall name is required.'));

      expect(status).toBe(400);
      expect(body.status).toBe(400);
      expect(body.message).toBe('Hall name is required.');
    });

    it('keeps "not found" on 400, matching the Java (ADR-003)', () => {
      const { status, body } = run(new BadRequestDomainError('Layout not found: 42'));

      expect(status).toBe(400);
      expect(body.message).toBe('Layout not found: 42');
    });
  });

  describe('branch 2 — DataIntegrityViolationException equivalent', () => {
    it('maps to 409 with the fixed Java message', () => {
      const { status, body } = run(new DataIntegrityDomainError());

      expect(status).toBe(409);
      expect(body.message).toBe(
        'Database constraint error. Check the existing database schema and required columns.',
      );
    });
  });

  describe('branch 3 — raw PostgreSQL integrity violation', () => {
    it.each([
      ['23503', 'foreign key violation'],
      ['23505', 'unique violation'],
      ['23502', 'not-null violation'],
    ])('maps SQLSTATE %s (%s) to 409', (code) => {
      const { status, body } = run(Object.assign(new Error('insert failed'), { code }));

      expect(status).toBe(409);
      expect(body.message).toBe(DataIntegrityDomainError.DEFAULT_MESSAGE);
    });

    it('also reads the code from a TypeORM driverError wrapper', () => {
      const { status } = run(
        Object.assign(new Error('query failed'), { driverError: { code: '23503' } }),
      );

      expect(status).toBe(409);
    });

    it('does not treat an unrelated SQLSTATE class as an integrity violation', () => {
      const { status } = run(Object.assign(new Error('connection failure'), { code: '08006' }));

      expect(status).toBe(500);
    });
  });

  describe('branch 4 — HttpException', () => {
    it('maps a ValidationPipe failure to 400 with the first violation only', () => {
      const exception = new BadRequestException(['stalls must be an array', 'name must be a string']);

      const { status, body } = run(exception);

      expect(status).toBe(400);
      expect(body.message).toBe('stalls must be an array');
    });

    it('handles a string response payload', () => {
      const { status, body } = run(new HttpException('Payload Too Large', 413));

      expect(status).toBe(413);
      expect(body.message).toBe('Payload Too Large');
    });

    it('lets an unknown route stay 404', () => {
      const { status } = run(new NotFoundException());

      expect(status).toBe(404);
    });
  });

  describe('branch 5 — unknown errors', () => {
    it('returns 500 with the fixed Java fallback message', () => {
      const { status, body } = run(new Error('boom'));

      expect(status).toBe(500);
      expect(body.message).toBe('Internal server error while processing layout.');
    });

    it('does NOT leak the root cause, unlike the Java (S-05)', () => {
      const leaky = new Error(
        'ERROR: column "posx" of relation "stalls" does not exist at character 42',
      );

      const { body } = run(leaky);

      expect(body.message).not.toContain('posx');
      expect(body.message).not.toContain('stalls');
      expect(body.message).toBe(AllExceptionsFilter.INTERNAL_MESSAGE);
    });

    it('handles a non-Error throwable', () => {
      const { status, body } = run('a thrown string');

      expect(status).toBe(500);
      expect(body.message).toBe(AllExceptionsFilter.INTERNAL_MESSAGE);
    });
  });
});
