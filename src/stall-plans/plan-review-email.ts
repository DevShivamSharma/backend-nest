import type { MailMessage } from '../mail/mail.service';
import type { OrganisationEntity } from '../organisations/organisation.entity';

/** What every plan approval email says it is about. */
export interface PlanReviewMail {
  to: string[];
  organisation: OrganisationEntity;
  eventName: string;
  organiserName: string | null;
  hallName: string;
  revision: number;
  /** Who sent or answered. */
  byName: string;
  link: string;
}

function message(mail: PlanReviewMail, subject: string, lines: string[]): MailMessage {
  const { organisation } = mail;
  const footer = organisation.config.email.footer;
  return {
    to: mail.to,
    senderName: organisation.config.email.senderName ?? organisation.name,
    replyTo: organisation.config.email.replyTo,
    subject,
    text: [...lines, '', `Open the plan: ${mail.link}`, ...(footer ? ['', '--', footer] : [])].join(
      '\n',
    ),
  };
}

/** To the venue: an organiser sent a plan for approval. */
export function planSubmittedEmail(mail: PlanReviewMail): MailMessage {
  const organiser = mail.organiserName ?? 'The organiser';
  return message(mail, `Stall plan for approval: ${mail.eventName}, ${mail.hallName}`, [
    `${mail.byName} (${organiser}) sent the stall plan of ${mail.hallName} for ${mail.eventName} for approval (revision ${mail.revision}).`,
    '',
    'Open it in the planner to approve it or to send it back with what should change.',
  ]);
}

/** To the organiser: the venue approved the plan; they publish it when ready. */
export function planApprovedEmail(mail: PlanReviewMail): MailMessage {
  return message(mail, `Stall plan approved: ${mail.eventName}, ${mail.hallName}`, [
    `${mail.byName} of ${mail.organisation.name} approved the stall plan of ${mail.hallName} for ${mail.eventName} (revision ${mail.revision}).`,
    '',
    'Publish it from the planner when you are ready.',
  ]);
}

/** To the organiser: the venue sent the plan back. */
export function planRejectedEmail(mail: PlanReviewMail & { note: string }): MailMessage {
  return message(mail, `Stall plan sent back: ${mail.eventName}, ${mail.hallName}`, [
    `${mail.byName} of ${mail.organisation.name} sent back the stall plan of ${mail.hallName} for ${mail.eventName} (revision ${mail.revision}).`,
    '',
    'What to change:',
    mail.note,
    '',
    'Change the plan, save it and send it for approval again.',
  ]);
}
