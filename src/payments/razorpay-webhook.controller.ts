import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { Public } from '../common/decorators/public.decorator';
import type { PaymentsConfig } from '../config/configuration';
import { webhookSignatureValid } from './payment-signature';
import { PaymentsService } from './payments.service';
import type { RazorpayWebhook } from './razorpay-gateway';

/**
 * Razorpay's webhook (docs/15 §6.3). Public: Razorpay signs the raw body with the webhook
 * secret, and that signature is the only authentication. Absent (404) until the secret is set.
 * Not throttled: Razorpay sends bursts from a few addresses, and a 429 would only delay a
 * payment's settlement (or, after enough of them, get the webhook disabled at Razorpay).
 */
@Public()
@SkipThrottle()
@Controller('integrations/razorpay')
export class RazorpayWebhookController {
  private readonly secret: string | null;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService,
  ) {
    this.secret = config.getOrThrow<PaymentsConfig>('payments').webhookSecret;
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
  ): Promise<{ ok: true; outcome: string }> {
    if (!this.secret) throw new NotFoundException();
    const raw = request.rawBody;
    // Checked over the bytes Razorpay sent, before anything is parsed or trusted.
    if (!raw || !signature || !webhookSignatureValid(raw, signature, this.secret)) {
      throw new BadRequestException('The signature does not match.');
    }
    if (!eventId || eventId.length > 80) {
      throw new BadRequestException('The x-razorpay-event-id header is missing.');
    }
    const body = JSON.parse(raw.toString('utf8')) as RazorpayWebhook;
    return { ok: true, outcome: await this.payments.handleWebhook(eventId, body) };
  }
}
