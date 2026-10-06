import type { OrganisationEntity } from '../organisations/organisation.entity';
import type { MailMessage } from '../mail/mail.service';

export function invitationEmail(input: {
  to: string;
  organisation: OrganisationEntity;
  roleName: string;
  inviterName: string;
  link: string;
  expiresAt: Date;
}): MailMessage {
  const { organisation } = input;
  const expires = input.expiresAt.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: organisation.config.locale.timezone,
  });
  const footer = organisation.config.email.footer;

  return {
    to: input.to,
    senderName: organisation.config.email.senderName ?? organisation.name,
    replyTo: organisation.config.email.replyTo,
    subject: `You are invited to ${organisation.name}`,
    text: [
      `${input.inviterName} invited you to join ${organisation.name} as ${input.roleName}.`,
      '',
      `Accept the invitation: ${input.link}`,
      '',
      `The link works once and expires on ${expires}.`,
      ...(footer ? ['', '--', footer] : []),
    ].join('\n'),
  };
}
