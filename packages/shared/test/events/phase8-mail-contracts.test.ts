import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { BotFrontmatter, DeliverMailRequest, DeliverMailResponse, MailAddress, MailDirection, MailMessageRef, eventRegistry, parseEvent } from '../../src/index.ts';
import { uuid } from '../fixtures.ts';

// Contracts of P8-29/P8-30 (`pnpm test:events`): the one mail event (ids only: never an address, a subject or a word of a mail), the delivery door's bodies, and the `channel`
// of the `inbox` trigger.

const AT = '2026-11-02T08:00:00.000Z';
const failsAt = (payload: unknown): string[] => {
  try {
    parseEvent(payload);
  } catch (e) {
    if (e instanceof ZodError) return e.issues.map((i) => i.path.join('.'));
    throw e;
  }
  return [];
};

describe('connections.inbox.claimed', () => {
  const claimed = {
    type: 'connections.inbox.claimed',
    schemaVersion: 1,
    workspaceId: uuid(1),
    teamId: uuid(2),
    connectionId: uuid(3),
    botId: uuid(4),
    claimId: uuid(5),
    mailId: uuid(6),
    at: AT,
  } as const;

  it('is registered at version 1 and round-trips', () => {
    expect(Object.keys(eventRegistry['connections.inbox.claimed'])).toEqual(['1']);
    expect(parseEvent(claimed)).toEqual(claimed);
  });

  it.each(['connectionId', 'botId', 'claimId', 'mailId'] as const)('refuses a %s that is not an id', (field) => {
    expect(failsAt({ ...claimed, [field]: 'x' })).toContain(field);
  });

  it('carries ids only: it has no field for an address, a subject or a text, and one offered is not kept', () => {
    expect(Object.keys(claimed).filter((k) => /from|subject|body|text|address|name/i.test(k))).toEqual([]);
    expect(parseEvent({ ...claimed, subject: 'Refund', from: 'customer@example.com', body: 'Please refund.' })).toEqual(claimed);
  });
});

describe('the delivery door', () => {
  const mail = { from: 'customer@example.com', to: 'support@example.com', subject: 'Refund', body: 'Please refund.' };

  it('takes a mail with an optional message id, parent and folder, and nothing else', () => {
    expect(DeliverMailRequest.parse(mail)).toEqual(mail);
    expect(DeliverMailRequest.parse({ ...mail, messageRef: '<a@b.co>', inReplyTo: '<c@d.co>', folder: 'INBOX' })).toMatchObject({ messageRef: '<a@b.co>' });
    expect(DeliverMailRequest.safeParse({ ...mail, direction: 'out' }).success).toBe(false);
    expect(DeliverMailRequest.safeParse({ ...mail, from: 'nobody' }).success).toBe(false);
    expect(DeliverMailRequest.safeParse({ ...mail, body: 'x'.repeat(40_001) }).success).toBe(false);
    expect(DeliverMailRequest.safeParse({ ...mail, messageRef: 'has a space' }).success).toBe(false);
  });

  it('answers with ids and the thread, and says whether the mail was already there', () => {
    const answer = { mail: { id: uuid(1), connectionId: uuid(2), threadKey: '<a@b.co>', messageRef: '<a@b.co>', duplicate: false } };
    expect(DeliverMailResponse.parse(answer)).toEqual(answer);
    expect(DeliverMailResponse.safeParse({ mail: { ...answer.mail, body: 'text' } }).success).toBe(false);
  });

  it('names the direction of a mail as in, out or draft, and an address as an address', () => {
    expect(MailDirection.options).toEqual(['in', 'out', 'draft']);
    expect(MailAddress.safeParse('customer@example.com').success).toBe(true);
    expect(MailAddress.safeParse('customer').success).toBe(false);
    expect(MailMessageRef.safeParse('<x@y.co>').success).toBe(true);
    expect(MailMessageRef.safeParse('').success).toBe(false);
  });
});

describe('the inbox trigger in a BOT.md', () => {
  const base = { schema: 1, name: 'Mailer', role: 'Answers mail', kind: 'agent', runtime: 'hermes', model: { aliases: ['smart'] } };

  it('may name the channel its post about a new mail thread goes to; a name that is not a channel reference is refused', () => {
    const ok = BotFrontmatter.safeParse({ ...base, triggers: [{ type: 'inbox', connection: 'support-mail', channel: '#support' }] });
    expect(ok.success, JSON.stringify(ok.error?.issues)).toBe(true);
    expect(BotFrontmatter.safeParse({ ...base, triggers: [{ type: 'inbox' }] }).success).toBe(true);
    expect(BotFrontmatter.safeParse({ ...base, triggers: [{ type: 'inbox', channel: 'support' }] }).success).toBe(false);
  });
});
