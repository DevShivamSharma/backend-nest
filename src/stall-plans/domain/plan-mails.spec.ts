import { approvedMail, rejectedMail, reopenedMail, submittedMail } from './plan-mails';

const c = {
  eventName: 'Fair <2027>',
  hallName: 'Hall 11',
  organiserName: 'Acme',
  link: 'https://portal.test/external-events/e1',
};

describe('plan mails', () => {
  it('should carry the event, the hall and a button to open it, in HTML and in text', () => {
    const m = approvedMail(['a@x.test'], c);
    expect(m.subject).toBe('Approved: Hall 11 of Fair <2027>');
    expect(m.html).toContain('href="https://portal.test/external-events/e1"');
    expect(m.text).toContain('Open event: https://portal.test/external-events/e1');
  });

  it('should write nothing of the organiser into the HTML as markup', () => {
    const m = rejectedMail(['a@x.test'], c, '<script>alert(1)</script> fix aisle', 2);
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('Fair &lt;2027&gt;');
    expect(m.text).toContain('2 proof files are attached');
  });

  it('should say who sent a hall to ITPO, and that a reopened hall can change', () => {
    expect(submittedMail(['i@x.test'], c).text).toContain('Acme sent the stall plan of Hall 11');
    expect(reopenedMail(['a@x.test'], c).text).toContain('back to Draft');
  });
});
