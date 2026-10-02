import nodemailer from 'nodemailer';
import { describe, expect, it } from 'vitest';
import {
  createMemoryMailer,
  createSmtpMailer,
  createUnconfiguredMailer,
  inviteMail,
  mailerFromEnv,
  renderMail,
  resetPasswordMail,
  verifyEmailMail,
} from '../src/index.ts';

describe('mail templates', () => {
  const url = 'https://manythreads.example/reset-password/abc_DEF-123';

  it('every template has a subject, plain text and HTML that both carry the link', () => {
    const mails = [
      verifyEmailMail({ name: 'Nadia', url }),
      resetPasswordMail({ name: 'Nadia', url }),
      inviteMail({ inviterName: 'Omar', workspaceName: 'Kahf Software', teamName: 'Engineering', url }),
    ];
    for (const m of mails) {
      expect(m.subject.length).toBeGreaterThan(5);
      expect(m.text).toContain(url);
      expect(m.html).toContain(`href="${url}"`);
      expect(m.html.startsWith('<!doctype html>')).toBe(true);
    }
    expect(mails[2]?.text).toContain('the Engineering team in Kahf Software');
    expect(inviteMail({ inviterName: 'Omar', workspaceName: 'Kahf Software', teamName: null, url }).text).toContain('join Kahf Software');
  });

  it('escapes HTML in names so a display name cannot inject markup', () => {
    const m = resetPasswordMail({ name: '<img src=x onerror=alert(1)>', url });
    expect(m.html).not.toContain('<img');
    expect(m.html).toContain('&lt;img');
    expect(m.text).toContain('<img');
  });

  it('never uses the old product name and mentions manythreads', () => {
    expect(verifyEmailMail({ name: 'x', url }).text).toContain('manythreads');
  });

  it('renderMail addresses the message', () => {
    const m = renderMail({ template: 'reset', to: 'nadia@kahf.example', name: 'Nadia', url });
    expect(m.to).toBe('nadia@kahf.example');
    expect(m.subject).toBe('Reset your password');
  });
});

describe('mailers', () => {
  it('the memory mailer keeps what was sent and looks it up by address', async () => {
    const mailer = createMemoryMailer();
    await mailer.send(renderMail({ template: 'verify', to: 'A@Kahf.example', name: 'A', url: 'https://x.example/v/1' }));
    await mailer.send(renderMail({ template: 'reset', to: 'b@kahf.example', name: 'B', url: 'https://x.example/r/1' }));
    expect(mailer.sent).toHaveLength(2);
    expect(mailer.to('a@kahf.example')).toHaveLength(1);
    expect(mailer.last('b@kahf.example')?.subject).toBe('Reset your password');
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
  });

  it('the SMTP mailer hands text, html, from and to to the transport', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const mailer = createSmtpMailer({ url: 'smtp://localhost:1025', from: 'manythreads <hi@kahf.example>', transport });
    const sent: unknown[] = [];
    const original = transport.sendMail.bind(transport);
    transport.sendMail = ((message: unknown) => {
      sent.push(message);
      return original(message as never);
    }) as typeof transport.sendMail;
    await mailer.send(renderMail({ template: 'reset', to: 'nadia@kahf.example', name: 'Nadia', url: 'https://x.example/r/1' }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'manythreads <hi@kahf.example>', to: 'nadia@kahf.example', subject: 'Reset your password' });
    expect((sent[0] as { text: string; html: string }).text).toContain('https://x.example/r/1');
    expect((sent[0] as { text: string; html: string }).html).toContain('<a href=');
  });

  it('a failed SMTP send rejects so the caller decides what the person learns', async () => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    transport.sendMail = (() => Promise.reject(new Error('connection refused'))) as typeof transport.sendMail;
    const mailer = createSmtpMailer({ url: 'smtp://localhost:1', transport });
    await expect(mailer.send({ to: 'a@b.example', subject: 's', text: 't', html: 'h' })).rejects.toThrow('connection refused');
  });

  it('without MANYTHREADS_SMTP_URL nothing is sent and the operator is told, without the link', async () => {
    const lines: string[] = [];
    const mailer = mailerFromEnv({}, (l) => lines.push(l));
    await mailer.send(renderMail({ template: 'reset', to: 'nadia@kahf.example', name: 'Nadia', url: 'https://x.example/secret-link' }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MANYTHREADS_SMTP_URL');
    expect(lines[0]).not.toContain('secret-link');
    expect(createUnconfiguredMailer(() => undefined)).toBeDefined();
  });

  it('with MANYTHREADS_SMTP_URL set it builds an SMTP mailer', () => {
    expect(mailerFromEnv({ MANYTHREADS_SMTP_URL: 'smtp://localhost:1025', MANYTHREADS_MAIL_FROM: 'x@y.example' })).toHaveProperty('send');
  });
});
