import { connectorEntry } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { GOOGLE_TOOLS, freeGaps, mergeBusy } from '../src/google-tools.ts';
import { inputProblem } from '../src/index.ts';
import type { ApiInit, ProviderApi } from '../src/oauth/api.ts';
import { rfc822 } from '../src/person-kit.ts';
import { PERSON_TOOL_DEFS, personToolDef } from '../src/person-tools.ts';

// P16-03: the pure parts of the Google tools (no database, no network): the shape of each tool's input, the requests it makes of Gmail and Calendar, the card an approver
// reads, and the catalog agreeing with the tools. The same tools run end to end against the fake Google in person.test.ts.

interface Call {
  path: string;
  init: ApiInit;
}
/** A provider API that answers from a table of path -> answer and records every request. A path not in the table is a failure of the test. */
function stub(answers: Record<string, unknown>): { api: ProviderApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: ProviderApi = {
    now: () => new Date('2026-11-03T08:00:00Z'),
    async json(path, init = {}) {
      calls.push({ path, init });
      if (!(path in answers)) throw new Error(`unexpected request to ${path}`);
      return answers[path];
    },
    async text() {
      throw new Error('not used');
    },
  };
  return { api, calls };
}
const def = (name: string) => personToolDef(name)!;
const LABELS = { labels: [{ id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'TRASH', name: 'TRASH', type: 'system' }, { id: 'SENT', name: 'SENT', type: 'system' }, { id: 'Label_1', name: 'Invoices', type: 'user' }] };

describe('free and busy arithmetic', () => {
  it('merges spans that overlap or touch, puts them in order, and drops what cannot be read', () => {
    expect(
      mergeBusy([
        { start: '2026-11-03T10:00:00Z', end: '2026-11-03T11:00:00Z' },
        { start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' },
        { start: '2026-11-03T09:30:00Z', end: '2026-11-03T09:45:00Z' },
        { start: 'not a time', end: '2026-11-03T12:00:00Z' },
        { start: '2026-11-03T13:00:00Z', end: '2026-11-03T12:00:00Z' },
      ]),
    ).toEqual([{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T11:00:00.000Z' }]);
  });

  it('finds the gaps of the asked length inside the window, and no more than the cap', () => {
    const window = { start: '2026-11-03T08:00:00Z', end: '2026-11-03T12:00:00Z' };
    const busy = [
      { start: '2026-11-03T07:00:00Z', end: '2026-11-03T08:30:00Z' }, // starts before the window
      { start: '2026-11-03T09:00:00Z', end: '2026-11-03T09:15:00Z' },
      { start: '2026-11-03T11:50:00Z', end: '2026-11-03T13:00:00Z' }, // runs past the window
    ];
    expect(freeGaps(busy, window, 30)).toEqual([{ start: '2026-11-03T08:30:00.000Z', end: '2026-11-03T09:00:00.000Z' }, { start: '2026-11-03T09:15:00.000Z', end: '2026-11-03T11:50:00.000Z' }]);
    expect(freeGaps(busy, window, 31)).toEqual([{ start: '2026-11-03T09:15:00.000Z', end: '2026-11-03T11:50:00.000Z' }]);
    expect(freeGaps([], window, 60, 1)).toEqual([{ start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T12:00:00.000Z' }]);
    expect(freeGaps([{ start: '2026-11-03T08:00:00Z', end: '2026-11-03T12:00:00Z' }], window, 5)).toEqual([]);
  });
});

describe('the message a send builds', () => {
  const mime = (o: Parameters<typeof rfc822>[0]): string => rfc822(o);
  it('carries Cc and the reply headers only in the forms that cannot add a header', () => {
    const m = mime({ to: ['a@b.co'], cc: ['c@d.co'], subject: 'Hi', body: 'x', inReplyTo: '<abc@mail.example>' });
    expect(m).toContain('Cc: c@d.co');
    expect(m).toContain('In-Reply-To: <abc@mail.example>');
    expect(m).toContain('References: <abc@mail.example>');
    const evil = mime({ to: ['a@b.co'], subject: 'Hi', body: 'x', inReplyTo: '<a@b>\r\nBcc: spy@evil.example' });
    expect(evil).not.toContain('Bcc');
    expect(evil).not.toContain('In-Reply-To');
    expect(mime({ to: ['a@b.co'], subject: 'Hi', body: 'x' })).not.toContain('Cc:');
  });
});

describe('what the model may pass', () => {
  it('gmail.send: addresses without whitespace, one-line subject, no hidden recipients, at most 25 in all', () => {
    const ok = { to: ['a@b.co'], subject: 's', body: 'b' };
    expect(inputProblem('gmail.send', ok)).toBeNull();
    expect(inputProblem('gmail.send', { ...ok, cc: ['c@d.co'], replyToMessageId: 'mail-1' })).toBeNull();
    expect(inputProblem('gmail.send', { ...ok, to: [] })).toMatch(/^to:/);
    expect(inputProblem('gmail.send', { ...ok, to: ['a@b.co\r\nBcc: x@y.co'] })).toMatch(/^to/);
    expect(inputProblem('gmail.send', { ...ok, subject: 'a\nb' })).toMatch(/^subject:/);
    expect(inputProblem('gmail.send', { ...ok, bcc: ['x@y.co'] })).toMatch(/unexpected field “bcc”/);
    expect(inputProblem('gmail.send', { ...ok, to: Array.from({ length: 20 }, (_, i) => `a${String(i)}@b.co`), cc: Array.from({ length: 6 }, (_, i) => `c${String(i)}@b.co`) })).toMatch(/at most 25/);
  });

  it('gmail.label: at least one label, at most five each, names on one line', () => {
    expect(inputProblem('gmail.label', { messageId: 'm1', add: ['Invoices'] })).toBeNull();
    expect(inputProblem('gmail.label', { messageId: 'm1' })).toMatch(/at least one label/);
    expect(inputProblem('gmail.label', { messageId: 'm1', add: [] })).toMatch(/at least one label/);
    expect(inputProblem('gmail.label', { messageId: 'm1', add: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatch(/^add:/);
    expect(inputProblem('gmail.label', { messageId: 'm1', add: ['a\nb'] })).toMatch(/^add/);
    expect(inputProblem('gmail.label', { messageId: '../../etc', add: ['a'] })).toMatch(/^messageId:/);
    expect(inputProblem('gmail.label', { messageId: '..', add: ['a'] })).toMatch(/^messageId:/);
    expect(inputProblem('google_calendar.update_event', { eventId: '.', title: 'x' })).toMatch(/^eventId:/);
    expect(inputProblem('gmail.send', { to: ['a@b.c\u202e'], subject: 's', body: 'b' })).toMatch(/^to/);
  });

  it('google_calendar.free_busy: a period of at most 31 days; google_calendar.update_event: something to change', () => {
    expect(inputProblem('google_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-04T08:00:00Z' })).toBeNull();
    expect(inputProblem('google_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-12-10T08:00:00Z' })).toMatch(/^to:/);
    expect(inputProblem('google_calendar.free_busy', { from: '2026-11-04T08:00:00Z', to: '2026-11-03T08:00:00Z' })).toMatch(/^to:/);
    expect(inputProblem('google_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-04T08:00:00Z', minMinutes: 1 })).toMatch(/^minMinutes:/);
    expect(inputProblem('google_calendar.update_event', { eventId: 'abc123', title: 'New' })).toBeNull();
    expect(inputProblem('google_calendar.update_event', { eventId: 'abc123' })).toMatch(/say what to change/);
    expect(inputProblem('google_calendar.update_event', { eventId: 'a/b', title: 'x' })).toMatch(/^eventId:/);
    expect(inputProblem('google_calendar.update_event', { eventId: 'abc123', start: 'tomorrow' })).toMatch(/^start:/);
  });
});

describe('gmail.label', () => {
  it('finds labels by name in any case or by id, and sends the ids', async () => {
    const { api, calls } = stub({ '/gmail/v1/users/me/labels': LABELS, '/gmail/v1/users/me/messages/m1/modify': { id: 'm1', labelIds: ['Label_1'] } });
    expect(await def('gmail.label').run(api, { messageId: 'm1', add: ['invoices'], remove: ['INBOX'] })).toEqual({ ok: true, id: 'm1', labels: ['Label_1'] });
    expect(calls[1]).toMatchObject({ path: '/gmail/v1/users/me/messages/m1/modify', init: { method: 'POST', body: { addLabelIds: ['Label_1'], removeLabelIds: ['INBOX'] } } });
  });

  it('points to gmail.list_labels when a label does not exist, without naming the mailbox labels, and never creates one', async () => {
    const { api, calls } = stub({ '/gmail/v1/users/me/labels': LABELS });
    const answer = (await def('gmail.label').run(api, { messageId: 'm1', add: ['Receipts'] })) as { ok: boolean; code: string; message: string };
    expect(answer).toMatchObject({ ok: false, code: 'unknown_label' });
    expect(answer.message).toContain('gmail.list_labels');
    expect(answer.message).not.toContain('Invoices');
    expect(calls.map((c) => c.path)).toEqual(['/gmail/v1/users/me/labels']);
  });

  it('will not put mail in the bin or spam, claim it was sent, or add and remove the same label', async () => {
    for (const add of ['TRASH', 'trash', 'SENT']) {
      const { api, calls } = stub({ '/gmail/v1/users/me/labels': LABELS });
      expect(await def('gmail.label').run(api, { messageId: 'm1', add: [add] }), add).toMatchObject({ ok: false, code: 'label_not_allowed' });
      expect(calls).toHaveLength(1);
    }
    const { api } = stub({ '/gmail/v1/users/me/labels': LABELS });
    expect(await def('gmail.label').run(api, { messageId: 'm1', add: ['Invoices'], remove: ['Label_1'] })).toMatchObject({ ok: false, code: 'invalid' });
    // taking TRASH off (rescuing a message) is allowed; taking SENT off is not
    const rescue = stub({ '/gmail/v1/users/me/labels': LABELS, '/gmail/v1/users/me/messages/m1/modify': { id: 'm1', labelIds: [] } });
    expect(await def('gmail.label').run(rescue.api, { messageId: 'm1', remove: ['TRASH'] })).toMatchObject({ ok: true });
    expect(await def('gmail.label').run(stub({ '/gmail/v1/users/me/labels': LABELS }).api, { messageId: 'm1', remove: ['SENT'] })).toMatchObject({ code: 'label_not_allowed' });
  });
});

describe('gmail.send', () => {
  it('sends the raw message once, with the conversation of the message it answers', async () => {
    const { api, calls } = stub({
      '/gmail/v1/users/me/messages/m1': { threadId: 't9', payload: { headers: [{ name: 'Message-ID', value: '<m1@mail.example>' }] } },
      '/gmail/v1/users/me/messages/send': { id: 'sent1', threadId: 't9' },
    });
    const answer = await def('gmail.send').run(api, { to: ['a@b.co'], subject: 'Re: hi', body: 'Thanks', replyToMessageId: 'm1' });
    expect(answer).toMatchObject({ ok: true, id: 'sent1', threadId: 't9' });
    const sendCall = calls.find((c) => c.path.endsWith('/messages/send'))!;
    expect(sendCall.init.method).toBe('POST');
    const body = sendCall.init.body as { raw: string; threadId: string };
    expect(body.threadId).toBe('t9');
    const mime = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(mime).toContain('To: a@b.co');
    expect(mime).toContain('In-Reply-To: <m1@mail.example>');
    expect(calls.filter((c) => c.path.endsWith('/messages/send'))).toHaveLength(1);
    // the original is asked for its Message-ID header only
    expect(calls[0]!.init.query).toMatchObject({ format: 'metadata', metadataHeaders: ['Message-ID'] });
  });

  it('a message without a reply target is a plain new message', async () => {
    const { api, calls } = stub({ '/gmail/v1/users/me/messages/send': { id: 's2' } });
    await def('gmail.send').run(api, { to: ['a@b.co'], subject: 'New', body: 'Hello' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).not.toHaveProperty('threadId');
  });
});

describe('google_calendar.free_busy', () => {
  it('asks for the person and the people named once each, and answers busy spans only', async () => {
    const { api, calls } = stub({
      '/calendar/v3/freeBusy': {
        calendars: {
          primary: { busy: [{ start: '2026-11-03T09:00:00Z', end: '2026-11-03T10:00:00Z' }] },
          'nadia@kahf.example': { busy: [{ start: '2026-11-03T09:30:00Z', end: '2026-11-03T11:00:00Z' }] },
          'ghost@kahf.example': { busy: [], errors: [{ reason: 'notFound' }] },
        },
      },
    });
    const answer = (await def('google_calendar.free_busy').run(api, {
      from: '2026-11-03T08:00:00Z',
      to: '2026-11-03T12:00:00Z',
      people: ['Nadia@kahf.example', 'nadia@kahf.example', 'ghost@kahf.example'],
      minMinutes: 30,
    })) as { calendars: Array<{ who: string; visible: boolean }>; free: unknown[]; freeCoversEveryone: boolean };
    expect((calls[0]!.init.body as { items: unknown[] }).items).toEqual([{ id: 'primary' }, { id: 'nadia@kahf.example' }, { id: 'ghost@kahf.example' }]);
    expect(answer.calendars.map((c) => [c.who, c.visible])).toEqual([['you', true], ['nadia@kahf.example', true], ['ghost@kahf.example', false]]);
    expect(answer.free).toEqual([
      { start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z' },
      { start: '2026-11-03T11:00:00.000Z', end: '2026-11-03T12:00:00.000Z' },
    ]);
    expect(answer.freeCoversEveryone).toBe(false);
  });

  it('a calendar the answer leaves out is not visible', async () => {
    const { api } = stub({ '/calendar/v3/freeBusy': { calendars: { primary: { busy: [] } } } });
    const answer = (await def('google_calendar.free_busy').run(api, { from: '2026-11-03T08:00:00Z', to: '2026-11-03T12:00:00Z', people: ['x@y.co'] })) as { calendars: Array<{ visible: boolean }>; free?: unknown };
    expect(answer.calendars.map((c) => c.visible)).toEqual([true, false]);
    expect(answer.free).toBeUndefined();
  });
});

describe('google_calendar.update_event', () => {
  it('patches only the fields named and tells Google not to email the guests', async () => {
    const { api, calls } = stub({ '/calendar/v3/calendars/primary/events/ev1': { id: 'ev1', htmlLink: 'https://x/ev1' } });
    expect(await def('google_calendar.update_event').run(api, { eventId: 'ev1', title: 'Moved', attendees: ['a@b.co'] })).toEqual({ ok: true, id: 'ev1', link: 'https://x/ev1' });
    expect(calls[0]!.init).toMatchObject({ method: 'PATCH', query: { sendUpdates: 'none' }, body: { summary: 'Moved', attendees: [{ email: 'a@b.co' }] } });
    expect(calls[0]!.init.body).not.toHaveProperty('start');
  });
});

describe('the cards an approver reads', () => {
  it('every Google tool that writes has one, built from the arguments, with the recipients and the text of a send', () => {
    for (const tool of GOOGLE_TOOLS.filter((t) => t.kind === 'write')) expect(tool.card, tool.name).toBeTypeOf('function');
    for (const tool of GOOGLE_TOOLS.filter((t) => t.kind === 'read')) expect(tool.card, tool.name).toBeUndefined();
    const card = def('gmail.send').card!({ to: ['a@b.co', 'c@d.co'], cc: ['e@f.co'], subject: 'Plan', body: 'Line one\nLine two' });
    expect(card.summary).toBe('Send an email to a@b.co, c@d.co: Plan');
    expect(card.preview).toMatchObject({ to: ['a@b.co', 'c@d.co'], cc: ['e@f.co'], subject: 'Plan', body: 'Line one\nLine two' });
    expect(def('google_calendar.update_event').card!({ eventId: 'ev1', attendees: ['a@b.co'] }).summary).toBe('Change event ev1: attendees');
  });

  it('a summary never runs past what the inbox allows', () => {
    const card = def('gmail.send').card!({ to: ['a@b.co'], subject: 'x'.repeat(300), body: 'b' });
    expect(card.summary.length).toBeLessThanOrEqual(300);
  });
});

describe('the catalog and the tools agree', () => {
  const entry = connectorEntry('google')!;
  const built = entry.tools.filter((t) => t.available);

  it('every tool the catalog offers is built, under its service, with the access the catalog says', () => {
    for (const t of built) {
      const d = personToolDef(t.name);
      expect(d, t.name).toBeDefined();
      expect(d!.kind, t.name).toBe(t.access);
      expect(d!.service, t.name).toBe(t.service);
      expect(entry.services.find((s) => s.id === t.service)?.available, t.name).toBe(true);
    }
  });

  it('every Google tool that is built is in the catalog as available, and nothing destructive is built', () => {
    const names = new Set(built.map((t) => t.name));
    for (const d of PERSON_TOOL_DEFS.filter((t) => t.provider === 'google')) expect(names.has(d.name), d.name).toBe(true);
    for (const t of entry.tools.filter((x) => x.destructive)) expect(personToolDef(t.name), t.name).toBeUndefined();
  });

  it('what is not built is not offered: the Meet transcripts and the new-mail trigger', () => {
    expect(entry.services.find((s) => s.id === 'meet')?.available).toBe(false);
    expect(entry.triggers.find((t) => t.id === 'gmail_label_mail')?.available).toBe(false);
  });
});
