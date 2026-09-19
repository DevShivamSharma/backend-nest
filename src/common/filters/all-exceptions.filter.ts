import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import { BadRequestDomainError, DataIntegrityDomainError } from '../errors/domain.errors';

/**
 * Error body, byte-identical to the Java `GlobalExceptionHandler.response()` shape:
 * a LinkedHashMap of success, status, message — in that key order
 * (GlobalExceptionHandler.java:45-51).
 */
export interface ErrorResponseBody {
  success: false;
  status: number;
  message: string;
}

interface ResolvedError {
  status: number;
  message: string;
}

/**
 * Global exception filter — the counterpart of `GlobalExceptionHandler`.
 *
 * Branch parity with the Java, plus two deliberate improvements:
 *
 *  - The Java 500 branch walked the exception chain and returned the *deepest root cause message*
 *    to the client (GlobalExceptionHandler.java:31-42). For a JDBC failure that is a driver
 *    string containing SQL, table and column names. Here the detail goes to the log and the
 *    client gets a fixed message (docs/06-authentication.md S-05, ADR-007).
 *
 *  - The Java called `ex.printStackTrace()` in all three handlers, writing unstructured output
 *    to System.err and bypassing the logging framework entirely. Here everything goes through
 *    the Nest logger.
 *
 * Malformed JSON and non-numeric path parameters arrive as `HttpException` (400) rather than
 * falling into the catch-all. In the Java they hit `@ExceptionHandler(Exception.class)` and
 * produced 500. That divergence is intentional and logged as ADR-014.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  /** The Java fallback literal, reused for every non-specific failure. */
  static readonly INTERNAL_MESSAGE = 'Internal server error while processing layout.';

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { status, message } = this.resolve(exception);

    const context = `${request.method} ${request.url} -> ${status}`;

    if (status >= 500) {
      // Full detail is logged, never returned.
      this.logger.error(context, exception instanceof Error ? exception.stack : String(exception));
    } else {
      this.logger.warn(`${context}: ${message}`);
    }

    const body: ErrorResponseBody = { success: false, status, message };
    response.status(status).json(body);
  }

  private resolve(exception: unknown): ResolvedError {
    // 1. IllegalArgumentException equivalent -> 400, message verbatim.
    if (exception instanceof BadRequestDomainError) {
      return { status: 400, message: exception.message };
    }

    // 2. DataIntegrityViolationException equivalent -> 409, fixed message.
    if (exception instanceof DataIntegrityDomainError) {
      return { status: 409, message: exception.message };
    }

    // 3. A raw PostgreSQL integrity violation that never got wrapped. SQLSTATE class 23 covers
    //    not-null, foreign key, unique and check violations — the same family Spring folded into
    //    DataIntegrityViolationException.
    if (AllExceptionsFilter.isIntegrityViolation(exception)) {
      return { status: 409, message: DataIntegrityDomainError.DEFAULT_MESSAGE };
    }

    // 4. Anything Nest itself raised: validation failures, unknown routes, payload too large.
    if (exception instanceof HttpException) {
      return {
        status: exception.getStatus(),
        message: AllExceptionsFilter.extractHttpMessage(exception),
      };
    }

    // 5. Unknown. Detail is logged above; the client learns nothing about internals.
    return { status: 500, message: AllExceptionsFilter.INTERNAL_MESSAGE };
  }

  /**
   * `ValidationPipe` puts an array of violations in `message`. The Java contract is a single
   * string (the frontend renders it directly), so the first violation is used and the rest are
   * dropped — which also matches the Java validator's first-failure-wins behaviour
   * (docs/04-business-rules.md, Part A preamble).
   */
  private static extractHttpMessage(exception: HttpException): string {
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return response;
    }

    if (typeof response === 'object' && response !== null && 'message' in response) {
      const { message } = response as { message: unknown };

      if (Array.isArray(message)) {
        return message.length > 0 ? String(message[0]) : exception.message;
      }

      if (typeof message === 'string') {
        return message;
      }
    }

    return exception.message;
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
