import type { Mail } from '../../mail/mail.service';

export interface PlanMailContext {
  eventName: string;
  hallName: string;
  organiserName: string | null;
  /** Where the event is opened in the portal. */
  link: string;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The layout of every mail: ITPO's name, the event, what happened, and a button to open it. */
function layout(c: PlanMailContext, heading: string, lines: string[], button: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center" style="padding:24px">
<table width="560" cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#c8283f;color:#fff;padding:18px 24px;font-size:18px;font-weight:bold">ITPO · Stall Planning Portal</td></tr>
<tr><td style="padding:24px">
<p style="margin:0 0 4px;color:#6b6b76;font-size:13px">${esc(c.eventName)} · ${esc(c.hallName)}</p>
<h1 style="margin:0 0 16px;font-size:20px">${esc(heading)}</h1>
${lines.map((l) => `<p style="margin:0 0 12px;line-height:1.5">${l}</p>`).join('\n')}
<p style="margin:24px 0 0"><a href="${esc(c.link)}" style="display:inline-block;background:#c8283f;color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-weight:bold">${esc(button)}</a></p>
</td></tr></table></td></tr></table></body></html>`;
}

function mail(
  to: string[],
  subject: string,
  c: PlanMailContext,
  heading: string,
  lines: string[],
  button: string,
): Mail {
  return {
    to,
    subject,
    html: layout(c, heading, lines.map(esc), button),
    text: `${heading}\n${c.eventName} · ${c.hallName}\n\n${lines.join('\n\n')}\n\n${button}: ${c.link}`,
  };
}

export function approvedMail(to: string[], c: PlanMailContext): Mail {
  return mail(
    to,
    `Approved: ${c.hallName} of ${c.eventName}`,
    c,
    'Your hall plan is approved',
    [`ITPO approved the stall plan of ${c.hallName}. You can publish it from the planner.`],
    'Open event',
  );
}

export function rejectedMail(
  to: string[],
  c: PlanMailContext,
  note: string,
  proofCount: number,
): Mail {
  const lines = [`ITPO sent the stall plan of ${c.hallName} back. What must change:`, note];
  if (proofCount) {
    lines.push(
      `${proofCount} proof file${proofCount === 1 ? ' is' : 's are'} attached to the hall: open the event to download ${proofCount === 1 ? 'it' : 'them'}.`,
    );
  }
  lines.push('Change the plan and send it for approval again.');
  return mail(
    to,
    `Sent back: ${c.hallName} of ${c.eventName}`,
    c,
    'Your hall plan needs changes',
    lines,
    'Open event',
  );
}

export function reopenedMail(to: string[], c: PlanMailContext): Mail {
  return mail(
    to,
    `Reopened: ${c.hallName} of ${c.eventName}`,
    c,
    'Your hall plan was reopened',
    [
      `ITPO took the approved plan of ${c.hallName} back to Draft. You can change it; send it for approval again when it is ready.`,
    ],
    'Open event',
  );
}

export function submittedMail(to: string[], c: PlanMailContext): Mail {
  return mail(
    to,
    `Plan sent for approval: ${c.hallName} of ${c.eventName}`,
    c,
    'A hall plan waits for approval',
    [`${c.organiserName ?? 'An organiser'} sent the stall plan of ${c.hallName} for approval.`],
    'Open hall',
  );
}

export function withdrawnMail(to: string[], c: PlanMailContext): Mail {
  return mail(
    to,
    `Plan withdrawn: ${c.hallName} of ${c.eventName}`,
    c,
    'A hall plan was withdrawn',
    [
      `${c.organiserName ?? 'An organiser'} took the stall plan of ${c.hallName} back from approval.`,
    ],
    'Open hall',
  );
}
