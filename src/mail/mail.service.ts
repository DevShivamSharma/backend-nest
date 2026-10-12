import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

import type { AppConfig, MailConfig } from '../config/configuration';
import { Environment, MailTransport } from '../config/env.validation';

export interface MailMessage {
  /** One address, or several who all see each other. */
  to: string | string[];
  subject: string;
  text: string;
  /** Display name of the sender, usually the organisation's. */
  senderName?: string | null;
  replyTo?: string | null;
}

/**
 * Outgoing email. The `log` transport writes each message to the server log, which is how links
 * reach a developer before an email provider is connected; `smtp` sends it. Outside production,
 * MAIL_REDIRECT_TO sends every message to the developers instead of the people it names.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private readonly mail: MailConfig;
  private readonly app: AppConfig;
  private readonly transporter: Transporter | null;

  constructor(config: ConfigService) {
    this.mail = config.getOrThrow<MailConfig>('mail');
    this.app = config.getOrThrow<AppConfig>('app');
    const smtp = this.mail.smtp;
    this.transporter = smtp
      ? createTransport({
          host: smtp.host,
          port: smtp.port,
          secure: smtp.secure,
          auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
        })
      : null;
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
    const addressed = [message.to].flat().filter(Boolean);
    const to = this.mail.redirectTo.length ? this.mail.redirectTo : addressed;
    if (!to.length) return;
    const subject = this.mail.redirectTo.length
      ? `${message.subject} [for ${addressed.join(', ')}]`
      : message.subject;
    if (this.transporter && this.mail.smtp) {
      await this.transporter.sendMail({
        from: { name: message.senderName ?? 'Venue platform', address: this.mail.smtp.from },
        to,
        replyTo: message.replyTo ?? undefined,
        subject,
        text: message.text,
      });
      return;
    }
    if (this.app.env !== Environment.Test) {
      this.logger.log(
        `Email to ${to.join(', ')} from ${message.senderName ?? 'the platform'}\n` +
          `Subject: ${subject}\n\n${message.text}`,
      );
    }
  }
}
