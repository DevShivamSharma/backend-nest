import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig, MailConfig } from '../config/configuration';
import { Environment, MailTransport } from '../config/env.validation';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** Display name of the sender, usually the organisation's. */
  senderName?: string | null;
  replyTo?: string | null;
}

/**
 * Outgoing email. The `log` transport writes each message to the server log, which is how links
 * reach a developer before an email provider is connected.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly mail: MailConfig;
  private readonly app: AppConfig;

  constructor(config: ConfigService) {
    this.mail = config.getOrThrow<MailConfig>('mail');
    this.app = config.getOrThrow<AppConfig>('app');
  }

  onModuleInit(): void {
    if (this.mail.transport === MailTransport.Log && this.app.env === Environment.Production) {
      this.logger.warn('MAIL_TRANSPORT=log in production: emails are written to the log only.');
    }
  }

  /** True while no real email is sent, so admins are shown the links to pass on themselves. */
  get deliversToLog(): boolean {
    return this.mail.transport === MailTransport.Log;
  }

  /** Builds an absolute link into the web app. */
  link(path: string, query: Record<string, string> = {}): string {
    const url = new URL(path.replace(/^\/?/, '/'), this.app.publicUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async send(message: MailMessage): Promise<void> {
    // Only the log transport exists; a provider (SMTP, SES) plugs in here.
    if (this.app.env !== Environment.Test) {
      this.logger.log(
        `Email to ${message.to} from ${message.senderName ?? 'the platform'}\n` +
          `Subject: ${message.subject}\n\n${message.text}`,
      );
    }
    await Promise.resolve();
  }
}
