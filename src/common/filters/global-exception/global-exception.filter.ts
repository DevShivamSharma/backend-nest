import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { RESPONSE_MESSAGES } from '../../constants/response-messages.constant';

/** Every error response has this shape, as ITPO's own services answer. */
export interface ErrorResponseBody {
  data: unknown;
  header: { code: number; error: true; success: false; msg: string };
}

/** The paths a load balancer reads by status code; they keep real statuses and a plain body. */
const RAW_PATHS = ['/health', '/health/ready'];

/**
 * The single place that turns a thrown error into an HTTP response.
 *
 * Like ITPO's services, the answer is HTTP 200 with the real status in `header.code` and
 * `header.error: true` (their front ends read the header, not the HTTP status). Set
 * ERROR_HTTP_STATUS=real to send the real HTTP status instead. The health checks always use the
 * real one.
 *
 * Services throw Nest's built-in HTTP exceptions with a sentence meant for the user. Anything
 * else is a bug or an outage: its detail goes to the log and the client gets a fixed message, so
 * driver errors (SQL, table and column names) never reach the browser.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  constructor(private readonly realHttpStatus = process.env.ERROR_HTTP_STATUS === 'real') {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR as number;
    let message: string = RESPONSE_MESSAGES.INTERNAL_SERVER_ERROR;
    let data: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as string | Record<string, unknown>;

      if (typeof body === 'object' && body !== null && 'errors' in body) {
        // A refused request body: the fields and what is wrong with each.
        message = RESPONSE_MESSAGES.VALIDATION_FAILED;
        data = { errors: body.errors };
      } else if (typeof body === 'object' && body !== null && 'message' in body) {
        message = Array.isArray(body.message) ? body.message.join('; ') : String(body.message);
      } else {
        message = typeof body === 'string' ? body : exception.message;
      }

      if (status >= 500) {
        this.logger.error(`${request.method} ${request.url} -> ${status}: ${message}`);
      }
    } else {
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`${request.method} ${request.url} -> 500`, error.stack);
    }

    const isRaw = RAW_PATHS.includes(request.path ?? '');
    const body: ErrorResponseBody = {
      data,
      header: { code: status, error: true, success: false, msg: message },
    };

    response.status(isRaw || this.realHttpStatus ? status : HttpStatus.OK).json(body);
  }
}
