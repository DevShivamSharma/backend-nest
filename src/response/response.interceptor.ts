import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, Observable } from 'rxjs';

import { RESPONSE_MESSAGES } from '../common/constants/response-messages.constant';
import { CUSTOM_MESSAGE_KEY } from '../common/decorators/custom-message.decorator';
import { RAW_RESPONSE_KEY } from '../common/decorators/raw-response.decorator';

/** What every successful response looks like, as ITPO's own services answer. */
export interface ResponseEnvelope<T> {
  header: { code: number; error: false; success: true; msg: string };
  data: T | null;
}

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ResponseEnvelope<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ResponseEnvelope<T> | T> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw) {
      return next.handle();
    }

    const customMessage = this.reflector.get<string | undefined>(
      CUSTOM_MESSAGE_KEY,
      context.getHandler(),
    );
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => ({
        header: {
          code: response.statusCode,
          error: false as const,
          success: true as const,
          msg: customMessage || RESPONSE_MESSAGES.SUCCESS,
        },
        // A route with nothing to return still answers `data: null`, not a missing key.
        data: data ?? null,
      })),
    );
  }
}
