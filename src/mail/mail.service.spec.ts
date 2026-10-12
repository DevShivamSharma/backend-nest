import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';

import type { MailConfig } from '../config/configuration';
import { Environment, MailTransport } from '../config/env.validation';
import { MailService } from './mail.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('MailService', () => {
  const sendMail = jest.fn().mockResolvedValue({});
  const smtp = {
    host: 'smtp.example.test',
    port: 465,
    secure: true,
    user: 'mailer',
    password: 'secret',
    from: 'noreply@example.test',
  };

  function service(mail: Partial<MailConfig>, env = Environment.Development): MailService {
    const config = {
      getOrThrow: (key: string) =>
        key === 'mail'
          ? { transport: MailTransport.Smtp, smtp, redirectTo: [], ...mail }
          : { env, publicUrl: 'http://localhost:4200' },
    } as unknown as ConfigService;
    return new MailService(config);
  }

  beforeEach(() => {
    sendMail.mockClear();
    (createTransport as jest.Mock).mockReturnValue({ sendMail });
  });

  it('sends through the SMTP server, from its address, to everyone named', async () => {
    await service({}).send({
      to: ['a@expo.test', 'b@expo.test'],
      subject: 'Stall plan approved',
      text: 'Approved.',
      senderName: 'ITPO',
      replyTo: 'help@itpo.test',
    });
    expect(createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'mailer', pass: 'secret' },
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: { name: 'ITPO', address: 'noreply@example.test' },
      to: ['a@expo.test', 'b@expo.test'],
      replyTo: 'help@itpo.test',
      subject: 'Stall plan approved',
      text: 'Approved.',
    });
  });

  it('sends to the developers instead while MAIL_REDIRECT_TO is set, naming who it was for', async () => {
    await service({ redirectTo: ['dev@cms.test'] }).send({
      to: 'organiser@expo.test',
      subject: 'Stall plan sent back',
      text: 'Change it.',
    });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ['dev@cms.test'],
        subject: 'Stall plan sent back [for organiser@expo.test]',
      }),
    );
  });

  it('writes to the log, sending nothing, with the log transport', async () => {
    await service({ transport: MailTransport.Log, smtp: null }, Environment.Test).send({
      to: 'a@expo.test',
      subject: 'x',
      text: 'y',
    });
    expect(sendMail).not.toHaveBeenCalled();
  });
});
