import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import type { SessionUser } from '../../auth/domain/session-user';
import { EmailRecipientsService } from '../../email-recipients/services/email-recipients.service';
import { MailService } from '../../mail/mail.service';
import {
  approvedMail,
  PlanMailContext,
  reopenedMail,
  rejectedMail,
  submittedMail,
  withdrawnMail,
} from '../domain/plan-mails';
import type { PlanEventHall } from './plan-context.service';

/**
 * The emails of the approval: the organiser is told when ITPO approves, sends back or reopens a
 * hall's plan; ITPO is told (the staff on the "plan-submitted" or "plan-withdrawn" list of the email recipients master) when an organiser sends or
 * withdraws one. A mail that fails never fails the step.
 */
@Injectable()
export class PlanNotificationsService {
  private readonly logger = new Logger(PlanNotificationsService.name);

  constructor(
    private readonly mail: MailService,
    private readonly recipients: EmailRecipientsService,
    private readonly config: ConfigService,
    private readonly db: DataSource,
  ) {}

  async submitted(hall: PlanEventHall, user: SessionUser): Promise<void> {
    await this.toItpo('plan-submitted', hall, user, submittedMail);
  }

  async withdrawn(hall: PlanEventHall, user: SessionUser): Promise<void> {
    await this.toItpo('plan-withdrawn', hall, user, withdrawnMail);
  }

  async approved(hall: PlanEventHall): Promise<void> {
    await this.toOrganiser(hall, (to, c) => approvedMail(to, c));
  }

  async rejected(hall: PlanEventHall, note: string, proofCount: number): Promise<void> {
    await this.toOrganiser(hall, (to, c) => rejectedMail(to, c, note, proofCount));
  }

  async reopened(hall: PlanEventHall): Promise<void> {
    await this.toOrganiser(hall, (to, c) => reopenedMail(to, c));
  }

  private context(hall: PlanEventHall, organiserName: string | null): PlanMailContext {
    const base = (
      this.config.get<string>('FRONTEND_DOMAIN') ??
      this.config.get<string>('APP_WEB_URL') ??
      ''
    ).replace(/\/$/, '');
    return {
      eventName: hall.eventName,
      hallName: hall.hallName,
      organiserName,
      link: `${base}/external-events/${hall.eventId}`,
    };
  }

  /** The staff on the recipient list of this slug; `ITPO_NOTIFY_EMAILS` serves while the list is empty. */
  private async toItpo(
    slug: string,
    hall: PlanEventHall,
    user: SessionUser,
    make: (to: string[], c: PlanMailContext) => ReturnType<typeof submittedMail>,
  ): Promise<void> {
    try {
      let to = await this.recipients.resolve(slug);
      if (!to.length) {
        to = (this.config.get<string>('ITPO_NOTIFY_EMAILS') ?? '')
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean);
      }
      if (!to.length) return;
      await this.mail.send(make(to, this.context(hall, hall.organiserName ?? user.name)));
    } catch (error) {
      this.logger.warn(
        `Mail to ITPO failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  /** The organisation's users who plan this event: those who can sign in under its organisation. */
  private async toOrganiser(
    hall: PlanEventHall,
    make: (to: string[], c: PlanMailContext) => ReturnType<typeof approvedMail>,
  ): Promise<void> {
    try {
      if (!hall.orgId) return;
      const rows = await this.db.query<Array<{ email: string | null }>>(
        `SELECT email FROM idp."T_USER"
          WHERE org_id = $1 AND "isActive" = true AND "deletedAt" IS NULL AND email IS NOT NULL`,
        [hall.orgId],
      );
      const to = rows.map((r) => r.email!).filter(Boolean);
      await this.mail.send(make(to, this.context(hall, hall.organiserName)));
    } catch (error) {
      this.logger.warn(
        `Mail to the organiser failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
