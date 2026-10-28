import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { ErrorResponseBody, GlobalExceptionFilter } from './global-exception.filter';

interface Captured {
  status: number;
  body: ErrorResponseBody;
}

function run(
  exception: unknown,
  path = '/ems/itpo/api/v1/halls',
  realHttpStatus = false,
): Captured {
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
      getRequest: () => ({ method: 'POST', url: path, path }),
    }),
  } as unknown as ArgumentsHost;

  new GlobalExceptionFilter(realHttpStatus).catch(exception, host);

  return captured;
}

describe('GlobalExceptionFilter', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it("should answer HTTP 200 with the real status in the header, as ITPO's services do", () => {
    const { status, body } = run(new UnauthorizedException('Sign in to continue.'));

    expect(status).toBe(200);
    expect(body).toEqual({
      data: null,
      header: { code: 401, error: true, success: false, msg: 'Sign in to continue.' },
    });
  });

  it.each([
    [new BadRequestException('Nothing to change.'), 400, 'Nothing to change.'],
    [
      new ForbiddenException('You do not have access to this.'),
      403,
      'You do not have access to this.',
    ],
    [new NotFoundException('Event not found.'), 404, 'Event not found.'],
    [new HttpException('Too Many Requests', 429), 429, 'Too Many Requests'],
  ])('should carry %s as header.code %i', (exception, code, msg) => {
    const { body } = run(exception);

    expect(body.header).toMatchObject({ code, error: true, success: false, msg });
  });

  it('should send the real HTTP status when ERROR_HTTP_STATUS=real', () => {
    expect(run(new NotFoundException('Event not found.'), undefined, true).status).toBe(404);
  });

  it('should list the refused fields of a request body in data.errors', () => {
    const { body } = run(
      new UnprocessableEntityException({
        status: 422,
        errors: { name: 'name should not be empty' },
      }),
    );

    expect(body.header).toMatchObject({ code: 422, msg: 'Validation failed' });
    expect(body.data).toEqual({ errors: { name: 'name should not be empty' } });
  });

  it('should join several messages of one error', () => {
    const { body } = run(new BadRequestException(['a is wrong', 'b is wrong']));

    expect(body.header.msg).toBe('a is wrong; b is wrong');
  });

  it('should hide the detail of an error that is not an HTTP one (a driver error, a bug)', () => {
    const { body } = run(new Error('relation "T_USER" does not exist: SELECT * FROM secret'));

    expect(body.header).toMatchObject({ code: 500, error: true });
    expect(body.header.msg).not.toContain('relation');
    expect(body.header.msg).not.toContain('secret');
  });

  it('should keep the health checks on their real HTTP status, for the load balancer', () => {
    const { status, body } = run(
      new HttpException('Database is not reachable.', 503),
      '/health/ready',
    );

    expect(status).toBe(503);
    expect(body.header.code).toBe(503);
  });
});
