import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

/** Every error response has this shape. */
export interface ErrorResponseBody {
  status: number;
  /** One readable sentence the UI can show as is. */
  message: string;
  /** Every validation message, when there was more than one. */
  details?: string[];
}

/**
 * The single place that turns a thrown error into an HTTP response.
 *
 * Services throw Nest's built-in HTTP exceptions with a sentence meant for the user. Anything
 * else is a bug or an outage: its detail goes to the log and the client gets a fixed message,
 * so driver errors (SQL, table and column names) never reach the browser.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  static readonly INTERNAL_MESSAGE = 'Something went wrong on our side. Please try again.';
  static readonly CONFLICT_MESSAGE = 'This conflicts with existing data. Refresh and try again.';

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const body = this.resolve(exception);
    const context = `${request.method} ${request.originalUrl ?? request.url} -> ${body.status}`;

    if (body.status >= 500) {
      this.logger.error(context, exception instanceof Error ? exception.stack : String(exception));
    } else if (body.status !== 401 && body.status !== 404) {
      this.logger.warn(`${context}: ${body.message}`);
    }

    response.status(body.status).json(body);
  }

  private resolve(exception: unknown): ErrorResponseBody {
    if (exception instanceof HttpException) {
      return AllExceptionsFilter.fromHttpException(exception);
    }

    // A PostgreSQL integrity violation that a service did not anticipate (SQLSTATE class 23:
    // unique, foreign key, not-null, check). Usually a race between two writers.
    if (AllExceptionsFilter.isIntegrityViolation(exception)) {
      return { status: 409, message: AllExceptionsFilter.CONFLICT_MESSAGE };
    }

    return { status: 500, message: AllExceptionsFilter.INTERNAL_MESSAGE };
  }

  /** `ValidationPipe` reports an array of messages; the first leads, all go in `details`. */
  private static fromHttpException(exception: HttpException): ErrorResponseBody {
    const status = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { status, message: payload };
    }

    if (typeof payload === 'object' && payload !== null && 'message' in payload) {
      const { message } = payload as { message: unknown };

      if (Array.isArray(message) && message.length > 0) {
        const details = message.map(String);
        return details.length > 1
          ? { status, message: details[0], details }
          : { status, message: details[0] };
      }

      if (typeof message === 'string' && message.length > 0) {
        return { status, message };
      }
    }

    return { status, message: exception.message };
  }

  private static isIntegrityViolation(exception: unknown): boolean {
    if (typeof exception !== 'object' || exception === null) {
      return false;
    }

    const candidate = exception as { code?: unknown; driverError?: { code?: unknown } };
    const code = candidate.code ?? candidate.driverError?.code;

    return typeof code === 'string' && code.startsWith('23');
  }
}
