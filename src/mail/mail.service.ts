import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';

export interface Mail {
  to: string[];
  subject: string;
  html: string;
  text: string;
}

/**
 * Sends the portal's emails. `MAIL_TRANSPORT=log` (the default) prints them in the server log;
 * `smtp` sends them through ITPO's SMTP account (the SMTP_* names ITPO's admin service uses).
 * Outside production, `MAIL_REDIRECT_TO` sends every mail to those addresses instead, so testing
 * never mails real people. Sending never fails the action that caused it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | null = null;

  constructor(private readonly config: ConfigService) {}

  async send(mail: Mail): Promise<void> {
    const redirect = this.redirect();
    const to = redirect.length
      ? redirect
      : [...new Set(mail.to.map((a) => a.trim()).filter(Boolean))];
    if (!to.length) return;
    const subject = redirect.length
      ? `[to ${mail.to.join(', ') || 'nobody'}] ${mail.subject}`
      : mail.subject;
    try {
      if (this.config.get<string>('MAIL_TRANSPORT')?.toLowerCase() !== 'smtp') {
        this.logger.log(
          `Mail (not sent, MAIL_TRANSPORT is not smtp) to ${to.join(', ')}: ${subject}\n${mail.text}`,
        );
        return;
      }
      await this.smtp().sendMail({
        from: this.config.get<string>('SMTP_FROM_EMAIL'),
        to,
        subject,
        html: mail.html,
        text: mail.text,
      });
      this.logger.log(`Mail sent to ${to.length} recipient(s): ${subject}`);
    } catch (error) {
      this.logger.warn(
        `Mail "${subject}" was not sent: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** The address list every mail goes to instead, outside production. */
  private redirect(): string[] {
    if (this.config.get<string>('NODE_ENV') === 'production') return [];
    return (this.config.get<string>('MAIL_REDIRECT_TO') ?? '')
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
  }

  private smtp(): Transporter {
    this.transporter ??= createTransport({
      host: this.config.get<string>('SMTP_HOST_NAME'),
      port: Number(this.config.get<string>('SMTP_PORT') ?? 465),
      secure: Number(this.config.get<string>('SMTP_PORT') ?? 465) === 465,
      auth: {
        user: this.config.get<string>('SMTP_AUTH_USER'),
        pass: this.config.get<string>('SMTP_AUTH_PASSWORD'),
      },
    });
    return this.transporter;
  }
}
