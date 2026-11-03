import { connectorEntry } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { graphTime, MICROSOFT_TOOLS, valuesToCsv } from '../src/microsoft-tools.ts';
import { inputProblem } from '../src/index.ts';
import { ProviderError, type ApiInit, type ProviderApi } from '../src/oauth/api.ts';
import { PERSON_TOOL_DEFS, personToolDef } from '../src/person-tools.ts';

// P16-04: the pure parts of the Microsoft 365 tools (no database, no network): what each tool's input allows, the requests it makes of Graph, the card an approver reads, and
// the catalog agreeing with the tools. The same tools run end to end against the fake Microsoft in person.test.ts.

interface Call {
  method: string;
  path: string;
  init: ApiInit;
}
/** A provider API that answers from a table of "METHOD path" (or just "path") -> answer, in order for a path used twice, and records every request. */
function stub(answers: Record<string, unknown>, options: { text?: string; failOn?: string } = {}): { api: ProviderApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: ProviderApi = {
    now: () => new Date('2026-11-03T08:00:00Z'),
    async json(path, init = {}) {
      const method = init.method ?? 'GET';
      calls.push({ method, path, init });
      if (options.failOn === `${method} ${path}`) throw new ProviderError(503, 'Microsoft 365 did not answer, so the change may or may not have gone through.');
      // a null answer is a real answer (an empty 202), so look the key up rather than test the value
      const key = `${method} ${path}` in answers ? `${method} ${path}` : path;
      if (!(key in answers)) throw new Error(`unexpected request ${method} ${path}`);
      return answers[key];
    },
    async text(path) {
      calls.push({ method: 'GET', path, init: {} });
      return { text: options.text ?? '', truncated: false };
    },
  };
  return { api, calls };
}
const def = (name: string) => personToolDef(name)!;
const CATEGORIES = { value: [{ displayName: 'Customer', color: 'preset0' }, { displayName: 'Urgent', color: 'preset1' }] };

describe('reading what Graph answers', () => {
  it('turns a UTC time without an offset into an ISO time, and leaves one with an offset alone', () => {
    expect(graphTime({ dateTime: '2026-11-03T09:00:00.0000000', timeZone: 'UTC' })).toBe('2026-11-03T09:00:00.0000000Z');
    expect(graphTime({ dateTime: '2026-11-03T09:00:00.000Z' })).toBe('2026-11-03T09:00:00.000Z');
    expect(graphTime({ dateTime: '2026-11-03T09:00:00+02:00', timeZone: 'UTC' })).toBe('2026-11-03T09:00:00+02:00');
    expect(graphTime({ dateTime: '2026-11-03T09:00:00', timeZone: 'Pacific Standard Time' })).toBe('2026-11-03T09:00:00');
    expect(graphTime(null)).toBeNull();
    expect(Date.parse(graphTime({ dateTime: '2026-11-03T09:00:00.0000000', timeZone: 'UTC' })!)).toBe(Date.parse('2026-11-03T09:00:00Z'));
  });

  it('writes sheet values as CSV: quoted where needed, trailing empty cells and rows left off', () => {
    expect(valuesToCsv([['item', 'cost'], ['servers, big', 420], ['say "hi"', true], ['', ''], ['', '']])).toEqual({ text: 'item,cost\n"servers, big",420\n"say ""hi""",true', rows: 3 });
    expect(valuesToCsv('nonsense')).toEqual({ text: '', rows: 0 });
    expect(valuesToCsv([[{ a: 1 }, null, 'x']]).text).toBe(',,x');
  });
});

describe('what the model may pass', () => {
  const ok = { to: ['a@b.co'], subject: 's', body: 'b' };

  it('outlook.send: ASCII addresses with no whitespace, one-line subject, no bcc or reply-to, at most 10 recipients', () => {
    expect(inputProblem('outlook.send', ok)).toBeNull();
    expect(inputProblem('outlook.send', { ...ok, cc: ['c@d.co'], replyToMessageId: 'AAMkAG-1=' })).toBeNull();
    expect(inputProblem('outlook.send', { ...ok, to: [] })).toMatch(/^to:/);
    expect(inputProblem('outlook.send', { ...ok, to: ['a@b.co\r\nBcc: x@y.co'] })).toMatch(/^to/);
    expect(inputProblem('outlook.send', { ...ok, to: ['a@b.co, x@y.co'] })).toMatch(/^to/);
    expect(inputProblem('outlook.send', { ...ok, to: ['é@b.co'] })).toMatch(/^to/);
    expect(inputProblem('outlook.send', { ...ok, to: ['a@b.c‮'] })).toMatch(/^to/);
    expect(inputProblem('outlook.send', { ...ok, subject: '' })).toMatch(/^subject:/);
    for (const bad of ['a\nb', 'a\rb', 'a\u0000b', 'a\u0085b', 'a b', 'a b', 'a\u007fb']) expect(inputProblem('outlook.send', { ...ok, subject: bad }), JSON.stringify(bad)).toMatch(/^subject:/);
    expect(inputProblem('outlook.send', { ...ok, bcc: ['x@y.co'] })).toMatch(/unexpected field “bcc”/);
    expect(inputProblem('outlook.send', { ...ok, replyTo: ['x@y.co'] })).toMatch(/unexpected field “replyTo”/);
    expect(inputProblem('outlook.send', { ...ok, to: Array.from({ length: 8 }, (_, i) => `a${String(i)}@b.co`), cc: Array.from({ length: 3 }, (_, i) => `c${String(i)}@b.co`) })).toMatch(/at most 10/);
    expect(inputProblem('outlook.send', { ...ok, to: Array.from({ length: 11 }, (_, i) => `a${String(i)}@b.co`) })).toMatch(/^to/);
  });

  it('ids: a short run of safe characters that is not only dots; nothing that could change the address', () => {
    for (const id of ['.', '..', '...', '../x', 'a/b', 'a?b', 'a b', 'a#b', 'a%2e', '']) {
      expect(inputProblem('outlook.read', { messageId: id }), id).toMatch(/^messageId:/);
      expect(inputProblem('outlook_calendar.update_event', { eventId: id, title: 'x' }), id).toMatch(/^eventId:/);
      expect(inputProblem('sharepoint.read', { driveId: 'b!drive', itemId: id }), id).toMatch(/^itemId:/);
      expect(inputProblem('sharepoint.read', { driveId: id, itemId: 'item1' }), id).toMatch(/^driveId:/);
      expect(inputProblem('onedrive.read', { itemId: id }), id).toMatch(/^itemId:/);
    }
    expect(inputProblem('outlook.read', { messageId: 'AAMkAGI2-AAA=' })).toBeNull();
    expect(inputProblem('sharepoint.read', { driveId: 'b!1_2-xyz', itemId: '01ABC!123' })).toBeNull();
    expect(inputProblem('outlook.search', { folder: '../inbox' })).toMatch(/^folder:/);
    expect(inputProblem('outlook.search', { folder: '..' })).toMatch(/^folder:/);
  });

  it('outlook.search: words and/or a filter, never nothing', () => {
    expect(inputProblem('outlook.search', { query: 'invoice' })).toBeNull();
    expect(inputProblem('outlook.search', { from: 'billing@harbourgrain.example', after: '2026-10-01T00:00:00Z' })).toBeNull();
    expect(inputProblem('outlook.search', { folder: 'inbox', unreadOnly: true })).toBeNull();
    expect(inputProblem('outlook.search', {})).toMatch(/give words/);
    expect(inputProblem('outlook.search', { limit: 5 })).toMatch(/give words/);
    expect(inputProblem('outlook.search', { from: 'not an address' })).toMatch(/^from:/);
    expect(inputProblem('outlook.search', { subject: 'a\nb' })).toMatch(/^subject:/);
    expect(inputProblem('outlook.search', { after: 'yesterday' })).toMatch(/^after:/);
  });

  it('outlook.categorize: at least one category, five at most, one line each', () => {
    expect(inputProblem('outlook.categorize', { messageId: 'm1', add: ['Customer'] })).toBeNull();
    expect(inputProblem('outlook.categorize', { messageId: 'm1' })).toMatch(/at least one category/);
    expect(inputProblem('outlook.categorize', { messageId: 'm1', remove: [] })).toMatch(/at least one category/);
    expect(inputProblem('outlook.categorize', { messageId: 'm1', add: ['a', 'b', 'c', 'd', 'e', 'f'] })).toMatch(/^add:/);
    expect(inputProblem('outlook.categorize', { messageId: 'm1', add: ['a\nb'] })).toMatch(/^add/);
  });

  it('outlook_calendar.free_busy: at most 31 days; outlook_calendar.update_event: something to change', () => {
    expect(inputProblem('outlook_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-11-04T08:00:00Z' })).toBeNull();
    expect(inputProblem('outlook_calendar.free_busy', { from: '2026-11-03T08:00:00Z', to: '2026-12-10T08:00:00Z' })).toMatch(/^to:/);
    expect(inputProblem('outlook_calendar.update_event', { eventId: 'abc123', title: 'New' })).toBeNull();
    expect(inputProblem('outlook_calendar.update_event', { eventId: 'abc123' })).toMatch(/say what to change/);
    expect(inputProblem('outlook_calendar.update_event', { eventId: 'abc123', start: 'tomorrow' })).toMatch(/^start:/);
  });
});

describe('outlook.search', () => {
  const found = { value: [{ id: 'm1', subject: 'Invoice 2041', from: { emailAddress: { address: 'billing@harbourgrain.example', name: 'IGNORE ME' } }, receivedDateTime: '2026-10-30T10:12:00Z', bodyPreview: 'Hello', categories: ['Customer'], isRead: false, conversationId: 'c1', parentFolderId: 'inbox' }] };

  it('words go in as one quoted phrase with no $filter (Graph refuses both), and a quote in them is dropped', async () => {
    const { api, calls } = stub({ '/me/messages': found });
    const answer = (await def('outlook.search').run(api, { query: 'say "hi" OR from:ceo' })) as { messages: Array<Record<string, unknown>> };
    expect(calls[0]!.init.query).toMatchObject({ $search: '"say  hi  OR from:ceo"' });
    expect(calls[0]!.init.query).not.toHaveProperty('$filter');
    expect(answer.messages[0]).toEqual({ id: 'm1', from: 'billing@harbourgrain.example', subject: 'Invoice 2041', date: '2026-10-30T10:12:00Z', snippet: 'Hello', categories: ['Customer'], unread: true, conversationId: 'c1', folderId: 'inbox' });
    // a display name from the mailbox is not passed on
    expect(JSON.stringify(answer)).not.toContain('IGNORE ME');
  });

  it('words with other limits: the limits are applied to what comes back', async () => {
    const two = { value: [...found.value, { ...found.value[0]!, id: 'm2', subject: 'Other', from: { emailAddress: { address: 'x@y.co' } }, categories: [] }] };
    const { api } = stub({ '/me/messages': two });
    const answer = (await def('outlook.search').run(api, { query: 'a', from: 'BILLING@harbourgrain.example', category: 'customer', unreadOnly: true })) as { messages: Array<{ id: string }> };
    expect(answer.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('filters alone become one $filter with every value quoted for OData, in a folder when named', async () => {
    const { api, calls } = stub({ '/me/mailFolders/sentitems/messages': { value: [] } });
    await def('outlook.search').run(api, { from: "o'brien@x.co", subject: "it's", category: "Bob's", after: '2026-10-01T00:00:00Z', before: '2026-11-01T00:00:00+02:00', unreadOnly: true, folder: 'sentitems', limit: 3 });
    expect(calls[0]!.path).toBe('/me/mailFolders/sentitems/messages');
    expect(calls[0]!.init.query).toMatchObject({
      $filter: "receivedDateTime gt 2026-10-01T00:00:00.000Z and receivedDateTime lt 2026-10-31T22:00:00.000Z and from/emailAddress/address eq 'o''brien@x.co' and contains(subject,'it''s') and categories/any(c:c eq 'Bob''s') and isRead eq false",
      $top: 3,
    });
    expect(calls[0]!.init.query).not.toHaveProperty('$search');
  });

  it('a folder alone lists it, with no filter at all', async () => {
    const { api, calls } = stub({ '/me/mailFolders/inbox/messages': { value: [] } });
    await def('outlook.search').run(api, { folder: 'inbox' });
    expect(calls[0]!.init.query).not.toHaveProperty('$filter');
  });
});

describe('outlook.categorize', () => {
  it('adds a category with the spelling of the mailbox’s own, keeps the others, and sends the whole list', async () => {
    const { api, calls } = stub({ '/me/outlook/masterCategories': CATEGORIES, '/me/messages/m1': { categories: ['Old', 'Urgent'] } });
    const answer = await def('outlook.categorize').run(api, { messageId: 'm1', add: ['customer'], remove: ['URGENT'] });
    expect(answer).toEqual({ ok: true, id: 'm1', categories: ['Old', 'Customer'] });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe('/me/messages/m1');
    expect(patch.init.body).toEqual({ categories: ['Old', 'Customer'] });
  });

  it('points to outlook.list_categories for a category that does not exist, names none of the mailbox’s, and changes nothing', async () => {
    const { api, calls } = stub({ '/me/outlook/masterCategories': CATEGORIES });
    const answer = (await def('outlook.categorize').run(api, { messageId: 'm1', add: ['Receipts'] })) as { ok: boolean; code: string; message: string };
    expect(answer).toMatchObject({ ok: false, code: 'unknown_category' });
    expect(answer.message).toContain('outlook.list_categories');
    for (const word of ['Customer', 'Urgent', 'Receipts']) expect(answer.message).not.toContain(word);
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('the same category added and removed, or too many on a message, is refused before a change', async () => {
    const { api, calls } = stub({ '/me/outlook/masterCategories': CATEGORIES, '/me/messages/m1': { categories: Array.from({ length: 25 }, (_, i) => `c${String(i)}`) } });
    expect(await def('outlook.categorize').run(api, { messageId: 'm1', add: ['Customer'], remove: ['customer'] })).toMatchObject({ code: 'invalid' });
    expect(await def('outlook.categorize').run(api, { messageId: 'm1', add: ['Customer'] })).toMatchObject({ code: 'invalid' });
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });

  it('removing a category needs no list of the mailbox’s categories', async () => {
    const { api, calls } = stub({ '/me/messages/m1': { categories: ['Gone', 'Keep'] } });
    expect(await def('outlook.categorize').run(api, { messageId: 'm1', remove: ['gone'] })).toMatchObject({ ok: true, categories: ['Keep'] });
    expect(calls.map((c) => c.path)).toEqual(['/me/messages/m1', '/me/messages/m1']);
  });
});

describe('outlook.send', () => {
  const base = { to: ['a@b.co'], cc: ['c@d.co'], subject: 'Plan', body: 'Line one\nLine two' };

  it('a new message goes through sendMail once, with exactly the recipients given and no bcc or reply-to', async () => {
    const { api, calls } = stub({ 'POST /me/sendMail': null });
    expect(await def('outlook.send').run(api, base)).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toEqual({
      message: { subject: 'Plan', body: { contentType: 'Text', content: 'Line one\nLine two' }, toRecipients: [{ emailAddress: { address: 'a@b.co' } }], ccRecipients: [{ emailAddress: { address: 'c@d.co' } }] },
      saveToSentItems: true,
    });
    expect(JSON.stringify(calls[0]!.init.body)).not.toMatch(/bcc|replyTo|internetMessageHeaders/i);
  });

  it('an answer: Outlook makes the reply in the conversation, the draft is set to what the approver read (bcc and reply-to emptied), and only then sent', async () => {
    const { api, calls } = stub({ 'POST /me/messages/m1/createReply': { id: 'draft-9=' }, 'PATCH /me/messages/draft-9%3D': {}, 'POST /me/messages/draft-9%3D/send': null });
    expect(await def('outlook.send').run(api, { ...base, replyToMessageId: 'm1' })).toMatchObject({ ok: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /me/messages/m1/createReply', 'PATCH /me/messages/draft-9%3D', 'POST /me/messages/draft-9%3D/send']);
    expect(calls[1]!.init.body).toEqual({
      subject: 'Plan',
      body: { contentType: 'Text', content: 'Line one\nLine two' },
      toRecipients: [{ emailAddress: { address: 'a@b.co' } }],
      ccRecipients: [{ emailAddress: { address: 'c@d.co' } }],
      bccRecipients: [],
      replyTo: [],
    });
  });

  it('a reply draft whose id is not a plain id is never sent', async () => {
    for (const id of ['..', '../x', 'a b', '', null]) {
      const { api, calls } = stub({ 'POST /me/messages/m1/createReply': { id } });
      expect(await def('outlook.send').run(api, { ...base, replyToMessageId: 'm1' }), String(id)).toMatchObject({ ok: false, code: 'unexpected_answer' });
      expect(calls).toHaveLength(1);
    }
  });

  it('a reply that fails after the draft was made says a draft may be left, and the send is not tried', async () => {
    const { api, calls } = stub({ 'POST /me/messages/m1/createReply': { id: 'd1' }, 'PATCH /me/messages/d1': {}, 'POST /me/messages/d1/send': null }, { failOn: 'PATCH /me/messages/d1' });
    await expect(def('outlook.send').run(api, { ...base, replyToMessageId: 'm1' })).rejects.toThrow(/Drafts folder/);
    expect(calls.some((c) => c.path.endsWith('/send'))).toBe(false);
  });
});

describe('outlook.draft and the calendar', () => {
  it('a draft is saved, not sent', async () => {
    const { api, calls } = stub({ 'POST /me/messages': { id: 'd1' } });
    expect(await def('outlook.draft').run(api, { to: ['a@b.co'], subject: 'S', body: 'B' })).toMatchObject({ ok: true, draftId: 'd1' });
    expect(calls.map((c) => c.path)).toEqual(['/me/messages']);
  });

  it('create and change write the time as UTC without an offset, whatever offset the model used, and change only what was named', async () => {
    const created = stub({ 'POST /me/events': { id: 'e1', webLink: 'https://x/e1' } });
    await def('outlook_calendar.create_event').run(created.api, { title: 'Sync', start: '2026-11-05T12:00:00+02:00', end: '2026-11-05T12:30:00+02:00', attendees: ['a@b.co'] });
    expect(created.calls[0]!.init.body).toEqual({
      subject: 'Sync',
      start: { dateTime: '2026-11-05T10:00:00', timeZone: 'UTC' },
      end: { dateTime: '2026-11-05T10:30:00', timeZone: 'UTC' },
      attendees: [{ emailAddress: { address: 'a@b.co' }, type: 'required' }],
    });
    const patched = stub({ 'PATCH /me/events/e1': { id: 'e1', webLink: 'https://x/e1' } });
    expect(await def('outlook_calendar.update_event').run(patched.api, { eventId: 'e1', title: 'Moved', start: '2026-11-05T11:00:00Z' })).toEqual({ ok: true, id: 'e1', link: 'https://x/e1' });
    expect(patched.calls[0]!.init.body).toEqual({ subject: 'Moved', start: { dateTime: '2026-11-05T11:00:00', timeZone: 'UTC' } });
  });

  it('a listing is asked for in UTC and its times come back as ISO times', async () => {
    const { api, calls } = stub({ '/me/calendarView': { value: [{ id: 'e1', subject: 'Stand-up', start: { dateTime: '2026-11-03T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-03T09:15:00.0000000', timeZone: 'UTC' } }] } });
    const answer = (await def('outlook_calendar.list_events').run(api, {})) as { events: Array<{ start: string }> };
    expect(calls[0]!.init.headers).toEqual({ prefer: 'outlook.timezone="UTC"' });
    expect(answer.events[0]!.start).toBe('2026-11-03T09:00:00.0000000Z');
  });
});

describe('outlook_calendar.free_busy', () => {
  const window = { from: '2026-11-03T08:00:00Z', to: '2026-11-03T12:00:00Z' };
  const schedule = (id: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ scheduleId: id, scheduleItems: items, ...extra });
  const at = (h: number, m = 0) => ({ dateTime: `2026-11-03T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.0000000`, timeZone: 'UTC' });

  it('asks about the person and the people named once each, and answers busy spans only: never a subject, never what an error said', async () => {
    const { api, calls } = stub({
      '/me': { mail: 'Omar@kahf.example', userPrincipalName: 'omar@kahf.onmicrosoft.com' },
      'POST /me/calendar/getSchedule': {
        value: [
          schedule('omar@kahf.example', [
            { status: 'busy', subject: 'SECRET-SUBJECT', start: at(9), end: at(10) },
            { status: 'free', start: at(10), end: at(11) },
            { status: 'workingElsewhere', start: at(11), end: at(12) },
          ]),
          schedule('nadia@kahf.example', [{ status: 'tentative', start: at(9, 30), end: at(11) }]),
          schedule('ghost@kahf.example', [], { error: { message: 'SECRET-MAILBOX-TEXT', responseCode: 'ErrorMailRecipientNotFound' } }),
        ],
      },
    });
    const answer = (await def('outlook_calendar.free_busy').run(api, { ...window, people: ['Nadia@kahf.example', 'nadia@kahf.example', 'OMAR@kahf.example', 'ghost@kahf.example'], minMinutes: 30 })) as {
      calendars: Array<{ who: string; visible: boolean; busy: unknown[] }>;
      free: unknown[];
      freeCoversEveryone: boolean;
    };
    const asked = calls.find((c) => c.path === '/me/calendar/getSchedule')!;
    expect((asked.init.body as { schedules: string[] }).schedules).toEqual(['omar@kahf.example', 'nadia@kahf.example', 'ghost@kahf.example']);
    expect(asked.init.body).toMatchObject({ startTime: { dateTime: '2026-11-03T08:00:00', timeZone: 'UTC' }, endTime: { dateTime: '2026-11-03T12:00:00', timeZone: 'UTC' } });
    expect(answer.calendars.map((c) => [c.who, c.visible])).toEqual([['you', true], ['nadia@kahf.example', true], ['ghost@kahf.example', false]]);
    expect(answer.calendars[0]!.busy).toEqual([{ start: '2026-11-03T09:00:00.000Z', end: '2026-11-03T10:00:00.000Z' }]);
    expect(answer.free).toEqual([
      { start: '2026-11-03T08:00:00.000Z', end: '2026-11-03T09:00:00.000Z' },
      { start: '2026-11-03T11:00:00.000Z', end: '2026-11-03T12:00:00.000Z' },
    ]);
    expect(answer.freeCoversEveryone).toBe(false);
    expect(JSON.stringify(answer)).not.toMatch(/SECRET/);
  });

  it('a schedule the answer leaves out is not visible; an account with no address cannot ask', async () => {
    const left = stub({ '/me': { userPrincipalName: 'omar@kahf.example' }, 'POST /me/calendar/getSchedule': { value: [schedule('omar@kahf.example', [])] } });
    const answer = (await def('outlook_calendar.free_busy').run(left.api, { ...window, people: ['x@y.co'] })) as { calendars: Array<{ visible: boolean }>; free?: unknown };
    expect(answer.calendars.map((c) => c.visible)).toEqual([true, false]);
    expect(answer.free).toBeUndefined();
    const none = stub({ '/me': { mail: null, userPrincipalName: null } });
    expect(await def('outlook_calendar.free_busy').run(none.api, window)).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(none.calls).toHaveLength(1);
  });
});

describe('files', () => {
  const xlsx = { id: 'f1', name: 'Budget.xlsx', file: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, lastModifiedDateTime: '2026-10-20T14:00:00Z' };

  it('a workbook is read as the first sheet in CSV, from the sheet’s id and a fixed range', async () => {
    const sheetId = '{00000000-0001-0000-0000-000000000000}';
    const { api, calls } = stub({
      '/me/drive/items/f1': xlsx,
      '/me/drive/items/f1/workbook/worksheets': { value: [{ id: sheetId, name: 'Sheet1' }] },
      [`/me/drive/items/f1/workbook/worksheets/${encodeURIComponent(sheetId)}/range(address='A1:Z200')`]: { values: [['item', 'cost'], ['servers', 420], ['', '']] },
    });
    expect(await def('onedrive.read').run(api, { itemId: 'f1' })).toMatchObject({ ok: true, type: 'text/csv', sheet: 'Sheet1', text: 'item,cost\nservers,420', truncated: false });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('a sheet id that could change the address is not used', async () => {
    const { api, calls } = stub({ '/me/drive/items/f1': xlsx, '/me/drive/items/f1/workbook/worksheets': { value: [{ id: '../../x', name: 'Sheet1' }] } });
    expect(await def('onedrive.read').run(api, { itemId: 'f1' })).toMatchObject({ ok: false, code: 'not_readable' });
    expect(calls).toHaveLength(2);
  });

  it('SharePoint reads by drive and item, and a file that is neither text nor a workbook is not read', async () => {
    const note = stub({ '/drives/b!d1/items/i1': { id: 'i1', name: 'notes.md', file: { mimeType: 'text/markdown' } } }, { text: '# Notes' });
    expect(await def('sharepoint.read').run(note.api, { driveId: 'b!d1', itemId: 'i1' })).toMatchObject({ ok: true, text: '# Notes' });
    expect(note.calls.map((c) => c.path)).toEqual(['/drives/b!d1/items/i1', '/drives/b!d1/items/i1/content']);
    const photo = stub({ '/drives/b!d1/items/i2': { id: 'i2', name: 'p.png', file: { mimeType: 'image/png' } } });
    expect(await def('sharepoint.read').run(photo.api, { driveId: 'b!d1', itemId: 'i2' })).toMatchObject({ ok: false, code: 'not_readable' });
    expect(photo.calls).toHaveLength(1);
  });

  it('SharePoint search asks the search service for files as one quoted phrase and answers only names, links and ids (never the summary)', async () => {
    const { api, calls } = stub({
      'POST /search/query': { value: [{ hitsContainers: [{ hits: [{ summary: 'SECRET-SUMMARY', resource: { id: 'i1', name: 'Plan.docx', webUrl: 'https://x/plan', lastModifiedDateTime: '2026-10-01T00:00:00Z', parentReference: { driveId: 'b!d1' } } }] }] }] },
    });
    const answer = await def('sharepoint.search').run(api, { query: 'say "hi" AND path:secret', limit: 5 });
    expect(calls[0]!.init.body).toEqual({ requests: [{ entityTypes: ['driveItem'], query: { queryString: '"say  hi  AND path:secret"' }, from: 0, size: 5 }] });
    expect(answer).toEqual({ ok: true, files: [{ driveId: 'b!d1', itemId: 'i1', name: 'Plan.docx', modified: '2026-10-01T00:00:00Z', link: 'https://x/plan' }] });
  });
});

describe('the cards an approver reads', () => {
  const writes = MICROSOFT_TOOLS.filter((t) => t.kind === 'write');

  it('every Microsoft tool that writes has one, and none that reads has', () => {
    expect(writes.map((t) => t.name).sort()).toEqual(['outlook.categorize', 'outlook.draft', 'outlook.send', 'outlook_calendar.create_event', 'outlook_calendar.update_event']);
    for (const t of writes) expect(t.card, t.name).toBeTypeOf('function');
    for (const t of MICROSOFT_TOOLS.filter((x) => x.kind === 'read')) expect(t.card, t.name).toBeUndefined();
  });

  it('a send shows every recipient, the subject, and the first 1,500 characters of the text', () => {
    const card = def('outlook.send').card!({ to: ['a@b.co', 'c@d.co'], cc: ['e@f.co'], subject: 'Plan', body: `${'x'.repeat(1500)}TAIL`, replyToMessageId: 'm1' });
    expect(card.summary).toBe('Send an email to a@b.co, c@d.co (cc e@f.co): Plan');
    expect(card.preview).toMatchObject({ to: ['a@b.co', 'c@d.co'], cc: ['e@f.co'], subject: 'Plan', inReplyTo: 'm1' });
    expect((card.preview['body'] as string).length).toBe(1500);
    expect(card.preview['body']).not.toContain('TAIL');
    expect(def('outlook.send').card!({ to: ['a@b.co'], subject: 'x'.repeat(300), body: 'b' }).summary.length).toBeLessThanOrEqual(300);
  });

  it('a draft, a category change and the events show what will be written', () => {
    expect(def('outlook.draft').card!({ to: ['a@b.co'], subject: 'S', body: 'B' })).toMatchObject({ summary: 'Save a draft to a@b.co: S', preview: { to: ['a@b.co'], subject: 'S', body: 'B' } });
    expect(def('outlook.categorize').card!({ messageId: 'm1', add: ['Customer'] }).summary).toBe('Categorise a message: add Customer, remove nothing');
    const create = def('outlook_calendar.create_event').card!({ title: 'Sync', start: '2026-11-05T10:00:00Z', end: '2026-11-05T11:00:00Z', attendees: ['a@b.co'], description: 'd'.repeat(2000) });
    expect(create.preview).toMatchObject({ guests: ['a@b.co'], note: expect.stringContaining('invitation') });
    expect((create.preview['description'] as string).length).toBe(1500);
    expect(def('outlook_calendar.create_event').card!({ title: 'Solo', start: 'a', end: 'b' }).preview).not.toHaveProperty('note');
    const change = def('outlook_calendar.update_event').card!({ eventId: 'ev1', attendees: ['a@b.co'] });
    expect(change.summary).toBe('Change event ev1: attendees');
    expect(change.preview).toMatchObject({ guests: ['a@b.co'], note: expect.stringContaining('Outlook') });
  });
});

describe('the catalog and the tools agree', () => {
  const entry = connectorEntry('microsoft')!;
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

  it('every Microsoft tool that is built is in the catalog as available, and nothing destructive is built', () => {
    const names = new Set(built.map((t) => t.name));
    for (const d of PERSON_TOOL_DEFS.filter((t) => t.provider === 'microsoft')) expect(names.has(d.name), d.name).toBe(true);
    for (const t of entry.tools.filter((x) => x.destructive)) expect(personToolDef(t.name), t.name).toBeUndefined();
  });

  it('what is not built is not offered: the Teams transcripts (they need the meetings writer, P15-09) and the new-mail trigger', () => {
    expect(entry.services.find((s) => s.id === 'teams_transcripts')?.available).toBe(false);
    expect(entry.tools.some((t) => t.service === 'teams_transcripts')).toBe(false);
    expect(entry.triggers.find((t) => t.id === 'outlook_folder_mail')?.available).toBe(false);
  });

  it('the scopes: sending asks only for Mail.Send, categories for the mailbox settings, free/busy for the basic calendar scope, SharePoint for its own', () => {
    const scopes = (id: string) => entry.services.find((s) => s.id === id)!.scopes;
    expect(scopes('mail_send')).toEqual(['Mail.Send']);
    expect(scopes('mail_categories')).toEqual(['Mail.ReadWrite', 'MailboxSettings.Read']);
    expect(scopes('calendar_free_busy')).toEqual(['Calendars.ReadBasic']);
    expect(scopes('sharepoint')).toEqual(['Sites.Read.All']);
  });
});
