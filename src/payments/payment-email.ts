import type { MailMessage } from '../mail/mail.service';
import type { OrganisationEntity } from '../organisations/organisation.entity';

/** What every payment email to an exhibitor says it is about. */
export interface PaymentMail {
  to: string;
  organisation: OrganisationEntity;
  eventName: string;
  stallLabel: string;
  amountPaise: number;
  currency: string;
  /** The gateway's payment id, which the exhibitor quotes to their bank or to us. */
  paymentId: string;
  link: string;
}

/** Paise as the exhibitor reads them, e.g. "₹1,20,000". */
export function money(amountPaise: number, currency: string): string {
  const amount = (amountPaise / 100).toLocaleString('en-IN');
  return currency === 'INR' ? `₹${amount}` : `${currency} ${amount}`;
}

function message(mail: PaymentMail, subject: string, lines: string[]): MailMessage {
  const { organisation } = mail;
  const footer = organisation.config.email.footer;
  return {
    to: mail.to,
    senderName: organisation.config.email.senderName ?? organisation.name,
    replyTo: organisation.config.email.replyTo,
    subject,
    text: [...lines, '', `Your bookings: ${mail.link}`, ...(footer ? ['', '--', footer] : [])].join(
      '\n',
    ),
  };
}

/** To the exhibitor: the payment arrived and the stall is booked. */
export function paymentReceiptEmail(
  mail: PaymentMail & { reckoning: string; paidAt: Date },
): MailMessage {
  const paidAt = mail.paidAt.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: mail.organisation.config.locale.timezone,
  });
  return message(mail, `Stall ${mail.stallLabel} is yours — ${mail.eventName}`, [
    `We received your payment for stall ${mail.stallLabel} at ${mail.eventName}, and the booking is confirmed.`,
    '',
    `Amount paid: ${money(mail.amountPaise, mail.currency)}, excl. GST`,
    `How the price is reckoned: ${mail.reckoning}`,
    `Paid on: ${paidAt}`,
    `Payment id: ${mail.paymentId}`,
  ]);
}

/** To the exhibitor: the payment could not confirm the booking, so it goes back. */
export function paymentRefundedEmail(mail: PaymentMail & { reason: string }): MailMessage {
  return message(mail, `Your payment for stall ${mail.stallLabel} is being refunded`, [
    `Your payment for stall ${mail.stallLabel} at ${mail.eventName} could not confirm the booking:`,
    mail.reason,
    '',
    `We are refunding all of it: ${money(mail.amountPaise, mail.currency)} (payment id ${mail.paymentId}).`,
    'Razorpay returns it to the card or account you paid from, usually within 5–7 working days.',
  ]);
}
