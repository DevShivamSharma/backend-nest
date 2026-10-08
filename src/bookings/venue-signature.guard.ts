import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
  RawBodyRequest,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { IntegrationsConfig } from '../config/configuration';
import { signatureProblem } from './venue-signature';

/**
 * Lets a venue system's status report through only when it is signed with the shared secret and
 * fresh. Without a configured secret the callback does not exist (404). Guards run before
 * validation, so an unsigned report is refused before its body is looked at.
 */
@Injectable()
export class VenueSignatureGuard implements CanActivate {
  private readonly secret: string | null;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<IntegrationsConfig>('integrations').venueWebhookSecret;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.secret) {
      throw new NotFoundException();
    }
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    const problem = signatureProblem(
      this.secret,
      request.get('x-venue-timestamp'),
      request.get('x-venue-signature'),
      request.rawBody,
    );
    if (problem) {
      throw new UnauthorizedException(problem);
    }
    return true;
  }
}
