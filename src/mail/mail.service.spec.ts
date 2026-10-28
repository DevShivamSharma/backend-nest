import { ConfigService } from '@nestjs/config';

import { MailService } from './mail.service';

const service = (env: Record<string, string>) =>
  new MailService({ get: (k: string) => env[k] } as unknown as ConfigService);
const mail = { to: ['org@x.test'], subject: 'S', html: '<p>h</p>', text: 'h' };

describe('MailService', () => {
  it('should only log a mail while the transport is not smtp, and send nothing without a recipient', async () => {
    const s = service({});
    const log = jest
      .spyOn((s as never as { logger: { log: () => void } }).logger, 'log')
      .mockImplementation();
    await s.send(mail);
    await s.send({ ...mail, to: [] });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('should send to the redirect addresses instead, outside production, and say who it was for', async () => {
    const s = service({ MAIL_TRANSPORT: 'smtp', MAIL_REDIRECT_TO: 'me@x.test' });
    const sendMail = jest.fn(() => Promise.resolve());
    (s as never as { transporter: unknown }).transporter = { sendMail };
    await s.send(mail);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: ['me@x.test'], subject: '[to org@x.test] S' }),
    );
  });

  it('should not redirect in production, and should not throw when sending fails', async () => {
    const s = service({
      MAIL_TRANSPORT: 'smtp',
      MAIL_REDIRECT_TO: 'me@x.test',
      NODE_ENV: 'production',
    });
    const sendMail = jest.fn(() => Promise.reject(new Error('refused')));
    (s as never as { transporter: unknown }).transporter = { sendMail };
    await expect(s.send(mail)).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: ['org@x.test'] }));
  });
});
