import { connectorEntry } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { CRM_TOOLS } from '../src/crm-tools.ts';
import { inputProblem } from '../src/index.ts';
import { ProviderError, type ApiInit, type ProviderApi } from '../src/oauth/api.ts';
import { endpointsFor, instanceLabel, instanceOf, instanceReady, InstanceError } from '../src/oauth/providers.ts';
import { PERSON_TOOL_DEFS, personToolDef } from '../src/person-tools.ts';
import { htmlOf, MAX_NOTE, pieces, soqlString, zendeskPhrase } from '../src/support-kit.ts';
import { SUPPORT_TOOLS } from '../src/support-tools.ts';

// P16-07: the pure parts of the Zendesk, Intercom, HubSpot and Salesforce tools (no database, no network): what each tool's input allows, the address a subdomain makes, the
// requests the tools make, the cards an approver reads, and the catalog agreeing with the tools. The same tools run end to end against the fake provider in support.test.ts.

interface Call {
  method: string;
  path: string;
  init: ApiInit;
}
/** A provider API that answers from a table of "METHOD path" (or just "path") -> answer and records every request. */
function stub(answers: Record<string, unknown>): { api: ProviderApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: ProviderApi = {
    now: () => new Date('2026-11-03T08:00:00Z'),
    async json(path, init = {}) {
      const method = init.method ?? 'GET';
      calls.push({ method, path, init });
      const key = `${method} ${path}` in answers ? `${method} ${path}` : path;
      if (!(key in answers)) throw new Error(`unexpected request ${method} ${path}`);
      return answers[key];
    },
    async text(path) {
      calls.push({ method: 'GET', path, init: {} });
      return { text: '', truncated: false };
    },
  };
  return { api, calls };
}
const def = (name: string) => personToolDef(name)!;

describe('the subdomain of an account', () => {
  it('accepts one plain label and lower-cases it', () => {
    expect(instanceLabel('acme')).toBe('acme');
    expect(instanceLabel('  Acme-Support9 ')).toBe('acme-support9');
    expect(instanceLabel('a')).toBe('a');
  });

  it('refuses anything that could change the host: dots, slashes, at signs, ports, schemes, spaces, double hyphens, edges, length, other types', () => {
    for (const bad of ['acme.evil.example', 'acme.zendesk.com', 'evil.example/', 'acme/x', 'user@evil.example', 'acme:8080', 'https://acme', '//acme', 'acme evil', 'acme\nevil', 'ac--me', '-acme', 'acme-', '', ' ', 'a'.repeat(64), 'ünï', 'acme%2eevil', 'acme\\evil', 'acme?x', 'acme#x']) {
      expect(instanceLabel(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const bad of [null, undefined, 5, {}, ['acme']]) expect(instanceLabel(bad)).toBeNull();
  });

  it('builds the address from the label and the provider’s own domain, and nothing else', () => {
    expect(endpointsFor('zendesk', {}, 'acme')).toMatchObject({ authorizeUrl: 'https://acme.zendesk.com/oauth/authorizations/new', tokenUrl: 'https://acme.zendesk.com/oauth/tokens', apiBase: 'https://acme.zendesk.com/api/v2' });
    expect(endpointsFor('salesforce', {}, 'acme')).toMatchObject({
      authorizeUrl: 'https://acme.my.salesforce.com/services/oauth2/authorize',
      tokenUrl: 'https://acme.my.salesforce.com/services/oauth2/token',
      revokeUrl: 'https://acme.my.salesforce.com/services/oauth2/revoke',
      apiBase: 'https://acme.my.salesforce.com/services/data/v62.0',
    });
    // a hostile setting is refused, not used: nothing is built from it
    for (const bad of ['evil.example/x', 'acme.evil.example', 'a@evil.example', 'acme:1']) {
      expect(() => endpointsFor('zendesk', {}, bad), bad).toThrow(InstanceError);
      expect(() => endpointsFor('salesforce', {}, bad), bad).toThrow(InstanceError);
    }
    expect(() => endpointsFor('zendesk', {}, null)).toThrow(/subdomain/);
  });

  it('falls back to the server’s setting only when the workspace has none, and only if that is a plain label too', () => {
    expect(instanceOf('zendesk', { MANYTHREADS_OAUTH_ZENDESK_INSTANCE: 'fromenv' })).toBe('fromenv');
    expect(instanceOf('zendesk', { MANYTHREADS_OAUTH_ZENDESK_INSTANCE: 'fromenv' }, 'fromapp')).toBe('fromapp');
    expect(instanceOf('zendesk', { MANYTHREADS_OAUTH_ZENDESK_INSTANCE: 'a.b' })).toBeNull();
    expect(instanceReady('zendesk', {})).toBe(false);
    expect(instanceReady('zendesk', {}, 'acme')).toBe(true);
    expect(instanceReady('salesforce', {})).toBe(false);
    // the providers with one address need no subdomain
    expect(instanceOf('hubspot', {}, 'acme')).toBeNull();
    expect(instanceReady('hubspot', {})).toBe(true);
    expect(instanceReady('intercom', {})).toBe(true);
    expect(endpointsFor('hubspot', {}).apiBase).toBe('https://api.hubapi.com');
    expect(endpointsFor('intercom', {}).apiBase).toBe('https://api.intercom.io');
  });

  it('a fake base is used outside production only, and without a path', () => {
    const fake = { MANYTHREADS_OAUTH_ZENDESK_FAKE_BASE: 'http://127.0.0.1:4000' };
    expect(endpointsFor('zendesk', fake).apiBase).toBe('http://127.0.0.1:4000/api/v2');
    expect(instanceReady('zendesk', fake)).toBe(true);
    expect(() => endpointsFor('zendesk', { ...fake, NODE_ENV: 'production' }, 'acme')).not.toThrow();
    expect(endpointsFor('zendesk', { ...fake, NODE_ENV: 'production' }, 'acme').apiBase).toBe('https://acme.zendesk.com/api/v2');
    expect(instanceReady('zendesk', { ...fake, NODE_ENV: 'production' })).toBe(false);
    expect(instanceReady('zendesk', { MANYTHREADS_OAUTH_ZENDESK_FAKE_BASE: 'http://127.0.0.1:4000/evil' })).toBe(false);
  });
});

describe('quoting for the search languages', () => {
  it('a Zendesk phrase is one quoted phrase: a quote, a backslash or a line break can never start a filter of its own', () => {
    expect(zendeskPhrase('invoice 2041')).toBe('"invoice 2041"');
    expect(zendeskPhrase('x" status:closed "')).toBe('"x status:closed"');
    expect(zendeskPhrase('a\\b\nc\u0000d')).toBe('"a b c d"');
    expect(zendeskPhrase('"')).toBe('""');
  });

  it('a SOQL literal escapes the quote and the backslash, and a LIKE word escapes the wildcards as well', () => {
    expect(soqlString("o'brien")).toBe("'o\\'brien'");
    expect(soqlString("x' OR Name != '")).toBe("'x\\' OR Name != \\''");
    expect(soqlString('a\\b')).toBe("'a\\\\b'");
    expect(soqlString('50%_off', true)).toBe("'50\\%\\_off'");
    expect(soqlString('50%_off')).toBe("'50%_off'");
    expect(soqlString('a\nb')).toBe("'a b'");
  });

  it('HTML for a provider that renders it: markup is escaped and a line break kept', () => {
    expect(htmlOf('<script>alert(1)</script> & "x"\nnext\r\nlast')).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;<br>next<br>last');
  });

  it('the pieces of a text put back together are the text, none longer than 250 characters, none splitting a pair', () => {
    const text = `${'a'.repeat(249)}😀${'b'.repeat(600)}`;
    const parts = pieces(text);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(250);
    expect(parts.every((p) => !/[\ud800-\udbff]$/.test(p) && !/^[\udc00-\udfff]/.test(p))).toBe(true);
    expect(pieces('')).toEqual([]);
  });
});

describe('what the model may pass', () => {
  it('ids: the form each provider’s ids have, nothing that could change a path', () => {
    for (const id of ['.', '..', '../4101', '4101/comments', '4101?x', '4101 ', '04101', '-1', '1.5', '', '1'.repeat(16), '4101%2e']) {
      expect(inputProblem('zendesk.read_ticket', { ticketId: id }), id).toMatch(/^ticketId:/);
      expect(inputProblem('zendesk.add_note', { ticketId: id, body: 'x' }), id).toMatch(/^ticketId:/);
      expect(inputProblem('hubspot.read_contact', { contactId: id }), id).toMatch(/^contactId:/);
    }
    for (const id of ['.', '..', 'a/b', 'a?b', 'a b', 'a.b', 'a%2e', '', 'x'.repeat(41)]) expect(inputProblem('intercom.read_conversation', { conversationId: id }), id).toMatch(/^conversationId:/);
    for (const id of ['500AB000003ijklQAA', '500AB000003ijkl']) expect(inputProblem('salesforce.read_case', { caseId: id })).toBeNull();
    for (const id of ['500AB', '500AB000003ijkl/../x', '500AB000003ijk.', '500AB000003ijklQA', '..', '']) expect(inputProblem('salesforce.read_case', { caseId: id }), id).toMatch(/^caseId:/);
    expect(inputProblem('zendesk.read_ticket', { ticketId: '4101' })).toBeNull();
    expect(inputProblem('intercom.read_conversation', { conversationId: '215472581234' })).toBeNull();
    expect(inputProblem('hubspot.read_contact', { contactId: '501' })).toBeNull();
  });

  it('a note or a reply: plain text, not empty, 2,000 characters at most; no field the tool does not have (no private flag, no recipient, no author)', () => {
    expect(inputProblem('zendesk.add_note', { ticketId: '4101', body: 'ok\nsecond line' })).toBeNull();
    expect(inputProblem('zendesk.add_note', { ticketId: '4101', body: 'x'.repeat(MAX_NOTE) })).toBeNull();
    expect(inputProblem('zendesk.add_note', { ticketId: '4101', body: 'x'.repeat(MAX_NOTE + 1) })).toMatch(/^body:/);
    for (const bad of ['', '   ', 'a\u0000b', 'a‮b', 'a​b', 'a﻿b', 'a\u2028b']) expect(inputProblem('zendesk.reply', { ticketId: '4101', body: bad }), JSON.stringify(bad)).toMatch(/^body:/);
    expect(inputProblem('zendesk.reply', { ticketId: '4101', body: 'x', public: false })).toMatch(/unexpected field “public”/);
    expect(inputProblem('zendesk.reply', { ticketId: '4101', body: 'x', requesterEmail: 'a@b.co' })).toMatch(/unexpected field/);
    expect(inputProblem('zendesk.add_note', { ticketId: '4101', body: 'x', private_note: true })).toMatch(/unexpected field/);
    expect(inputProblem('intercom.reply', { conversationId: 'c1', body: 'x', adminId: '1' })).toMatch(/unexpected field/);
    expect(inputProblem('salesforce.add_case_note', { caseId: '500AB000003ijkl', body: 'x', IsPublished: true })).toMatch(/unexpected field/);
    expect(inputProblem('hubspot.add_note', { contactId: '501', body: 'x', ownerId: '1' })).toMatch(/unexpected field/);
  });

  it('a status: only the values the tool can set', () => {
    expect(inputProblem('zendesk.set_status', { ticketId: '4101', status: 'solved' })).toBeNull();
    for (const bad of ['closed', 'new', 'deleted', 'SOLVED', '']) expect(inputProblem('zendesk.set_status', { ticketId: '4101', status: bad }), bad).toMatch(/^status:/);
    expect(inputProblem('intercom.set_state', { conversationId: 'c1', state: 'closed' })).toBeNull();
    expect(inputProblem('intercom.set_state', { conversationId: 'c1', state: 'snoozed' })).toMatch(/^state:/);
    expect(inputProblem('hubspot.set_lead_status', { contactId: '501', status: 'CONNECTED' })).toBeNull();
    expect(inputProblem('hubspot.set_lead_status', { contactId: '501', status: 'connected' })).toMatch(/^status:/);
    expect(inputProblem('hubspot.set_lead_status', { contactId: '501', status: 'LIFECYCLE' })).toMatch(/^status:/);
    expect(inputProblem('salesforce.set_case_status', { caseId: '500AB000003ijkl', status: 'Closed' })).toBeNull();
    for (const bad of ["Closed' --", 'Closed;', 'A'.repeat(41), '', '1']) expect(inputProblem('salesforce.set_case_status', { caseId: '500AB000003ijkl', status: bad }), bad).toMatch(/^status:/);
  });

  it('searches: words are required and plain; an Intercom customer is looked up by an address or a name, not both', () => {
    expect(inputProblem('zendesk.search_tickets', { query: 'invoice' })).toBeNull();
    expect(inputProblem('zendesk.search_tickets', { query: '' })).toMatch(/^query:/);
    expect(inputProblem('zendesk.search_tickets', { query: 'a\u0000b' })).toMatch(/^query:/);
    expect(inputProblem('zendesk.search_tickets', { query: 'a', status: 'closed-ish' })).toMatch(/^status:/);
    expect(inputProblem('zendesk.search_tickets', { query: 'a', requester: 'not an address' })).toMatch(/^requester:/);
    expect(inputProblem('salesforce.search_cases', { query: 'a', status: "x'" })).toMatch(/^status:/);
    expect(inputProblem('intercom.find_customer', { email: 'hana@harbourgrain.example' })).toBeNull();
    expect(inputProblem('intercom.find_customer', { name: 'Hana' })).toBeNull();
    expect(inputProblem('intercom.find_customer', { email: 'hana@harbourgrain.example', name: 'Hana' })).toMatch(/not both/);
    expect(inputProblem('intercom.find_customer', {})).toMatch(/not both/);
  });
});

describe('the requests the tools make', () => {
  it('zendesk.search_tickets: type, status, requester and the phrase in one query; a quote in the words cannot add a filter', async () => {
    const { api, calls } = stub({ '/search.json': { results: [{ id: 4101, subject: 'S', status: 'open', priority: 'high', requester_id: 101, updated_at: 'u', description: 'D'.repeat(500) }] } });
    const answer = (await def('zendesk.search_tickets').run(api, { query: 'x" status:closed', status: 'open', requester: 'hana@harbourgrain.example', limit: 3 })) as { tickets: Array<Record<string, unknown>> };
    expect(calls[0]!.init.query).toMatchObject({ query: 'type:ticket status:open requester:hana@harbourgrain.example "x status:closed"', per_page: 3 });
    expect(answer.tickets[0]).toMatchObject({ id: '4101', status: 'open', requesterId: '101' });
    expect((answer.tickets[0]!['snippet'] as string).length).toBeLessThanOrEqual(300);
  });

  it('zendesk.read_ticket: the ticket and its comments, internal ones marked, oldest first, each cut', async () => {
    const { api, calls } = stub({
      '/tickets/4101.json': { ticket: { id: 4101, subject: 'S', status: 'open', requester_id: 101, assignee_id: 102, tags: ['a', 5, 'b'], created_at: 'c' } },
      '/tickets/4101/comments.json': { comments: [{ id: 2, author_id: 102, public: false, plain_body: 'x'.repeat(5000), created_at: 'n' }, { id: 1, author_id: 101, public: true, plain_body: 'first', created_at: 'o' }] },
    });
    const answer = (await def('zendesk.read_ticket').run(api, { ticketId: '4101' })) as { ticket: Record<string, unknown>; comments: Array<{ id: string; public: boolean; text: string }> };
    expect(calls.map((c) => c.path)).toEqual(['/tickets/4101.json', '/tickets/4101/comments.json']);
    expect(answer.comments.map((c) => [c.id, c.public])).toEqual([['1', true], ['2', false]]);
    expect(answer.comments[1]!.text.length).toBeLessThanOrEqual(2000);
    expect(answer.ticket).toMatchObject({ id: '4101', assigneeId: '102', tags: ['a', 'b'] });
  });

  it('zendesk.find_customer: looks the first match’s tickets up only by a digits-only id', async () => {
    const { api, calls } = stub({ '/users/search.json': { users: [{ id: '../../x', name: 'N', email: 'e@x.co' }] } });
    const answer = (await def('zendesk.find_customer').run(api, { query: 'hana' })) as { recentTicketsOfFirst: unknown[] };
    expect(calls.map((c) => c.path)).toEqual(['/users/search.json']);
    expect(answer.recentTicketsOfFirst).toEqual([]);
  });

  it('zendesk writes: a PUT of one comment, public only for a reply; or a status', async () => {
    const put = { ticket: { id: 4101, status: 'open' } };
    const a = stub({ 'PUT /tickets/4101.json': put });
    await def('zendesk.add_note').run(a.api, { ticketId: '4101', body: 'Checked' });
    expect(a.calls[0]).toMatchObject({ method: 'PUT', path: '/tickets/4101.json', init: { body: { ticket: { comment: { body: 'Checked', public: false } } } } });
    const r = stub({ 'PUT /tickets/4101.json': put });
    await def('zendesk.reply').run(r.api, { ticketId: '4101', body: 'Hello' });
    expect(r.calls[0]!.init.body).toEqual({ ticket: { comment: { body: 'Hello', public: true } } });
    const s = stub({ 'PUT /tickets/4101.json': { ticket: { id: 4101, status: 'solved' } } });
    expect(await def('zendesk.set_status').run(s.api, { ticketId: '4101', status: 'solved' })).toEqual({ ok: true, ticketId: '4101', status: 'solved' });
    expect(s.calls[0]!.init.body).toEqual({ ticket: { status: 'solved' } });
  });

  it('intercom writes: the admin id first, then a note or a comment with the text escaped, or a close/open part', async () => {
    const answers = { '/me': { id: '991267' }, 'POST /conversations/c1/reply': {}, 'POST /conversations/c1/parts': {} };
    const n = stub(answers);
    await def('intercom.add_note').run(n.api, { conversationId: 'c1', body: '<b>hi</b>\nthere' });
    expect(n.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /me', 'POST /conversations/c1/reply']);
    expect(n.calls[1]!.init.body).toEqual({ message_type: 'note', type: 'admin', admin_id: '991267', body: '&lt;b&gt;hi&lt;/b&gt;<br>there' });
    const r = stub(answers);
    await def('intercom.reply').run(r.api, { conversationId: 'c1', body: 'Hello' });
    expect(r.calls[1]!.init.body).toMatchObject({ message_type: 'comment', admin_id: '991267' });
    const s = stub(answers);
    await def('intercom.set_state').run(s.api, { conversationId: 'c1', state: 'closed' });
    expect(s.calls[1]).toMatchObject({ path: '/conversations/c1/parts', init: { body: { message_type: 'close', type: 'admin', admin_id: '991267' } } });
    await def('intercom.set_state').run(s.api, { conversationId: 'c1', state: 'open' });
    expect(s.calls.at(-1)!.init.body).toMatchObject({ message_type: 'open' });
  });

  it('intercom: an admin id that is not plain letters and digits stops the write before it is sent, with our words only', async () => {
    const { api, calls } = stub({ '/me': { id: '../x', email: 'SECRET@x.co' } });
    const failure = await def('intercom.reply').run(api, { conversationId: 'c1', body: 'Hello' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as Error).message).toBe('Intercom answered in a way that cannot be used, so nothing was changed.');
    expect(calls).toHaveLength(1);
  });

  it('hubspot: a search, a note tied to the contact with the text escaped, and a lead status', async () => {
    const search = stub({ 'POST /crm/v3/objects/contacts/search': { results: [{ id: 501, properties: { firstname: 'Hana', lastname: 'Okafor', email: 'h@x.co', hs_lead_status: 'NEW' } }] } });
    expect(await def('hubspot.find_contact').run(search.api, { query: 'hana' })).toMatchObject({ contacts: [{ id: '501', name: 'Hana Okafor', email: 'h@x.co', leadStatus: 'NEW' }] });
    expect(search.calls[0]!.init.body).toMatchObject({ query: 'hana', limit: 10 });
    const note = stub({ 'POST /crm/v3/objects/notes': { id: '88' } });
    expect(await def('hubspot.add_note').run(note.api, { contactId: '501', body: 'a<b' })).toEqual({ ok: true, contactId: '501', noteId: '88' });
    expect(note.calls[0]!.init.body).toEqual({
      properties: { hs_timestamp: '2026-11-03T08:00:00.000Z', hs_note_body: 'a&lt;b' },
      associations: [{ to: { id: '501' }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
    });
    const lead = stub({ 'PATCH /crm/v3/objects/contacts/501': {} });
    await def('hubspot.set_lead_status').run(lead.api, { contactId: '501', status: 'CONNECTED' });
    expect(lead.calls[0]!.init.body).toEqual({ properties: { hs_lead_status: 'CONNECTED' } });
  });

  it('salesforce: words go into the query quoted for SOQL; a note is never published; a status is a PATCH of that field only', async () => {
    const { api, calls } = stub({ '/query': { records: [] } });
    await def('salesforce.find_customer').run(api, { query: "x' OR Name != '" });
    for (const c of calls) expect(String(c.init.query!['q'])).toContain("LIKE '%x\\' OR Name != \\'%'");
    const cases = stub({ '/query': { records: [] } });
    await def('salesforce.search_cases').run(cases.api, { query: '00001234', status: "Working" });
    expect(String(cases.calls[0]!.init.query!['q'])).toMatch(/FROM Case WHERE \(Subject LIKE '%00001234%' OR CaseNumber = '00001234'\) AND Status = 'Working' ORDER BY LastModifiedDate DESC LIMIT 10$/);
    const note = stub({ 'POST /sobjects/CaseComment': { id: '00aAB000004mnopQAA', success: true } });
    await def('salesforce.add_case_note').run(note.api, { caseId: '500AB000003ijkl', body: 'Internal' });
    expect(note.calls[0]!.init.body).toEqual({ ParentId: '500AB000003ijkl', CommentBody: 'Internal', IsPublished: false });
    const status = stub({ 'PATCH /sobjects/Case/500AB000003ijkl': null });
    await def('salesforce.set_case_status').run(status.api, { caseId: '500AB000003ijkl', status: 'Closed' });
    expect(status.calls[0]!.init.body).toEqual({ Status: 'Closed' });
  });
});

describe('the cards an approver reads', () => {
  const writes = [...SUPPORT_TOOLS, ...CRM_TOOLS].filter((t) => t.kind === 'write');
  const textual = ['zendesk.add_note', 'zendesk.reply', 'intercom.add_note', 'intercom.reply', 'hubspot.add_note', 'salesforce.add_case_note'];

  it('every tool that writes has one, and none that reads has', () => {
    expect(writes.map((t) => t.name).sort()).toEqual(['hubspot.add_note', 'hubspot.set_lead_status', 'intercom.add_note', 'intercom.reply', 'intercom.set_state', 'salesforce.add_case_note', 'salesforce.set_case_status', 'zendesk.add_note', 'zendesk.reply', 'zendesk.set_status']);
    for (const t of writes) expect(t.card, t.name).toBeTypeOf('function');
    for (const t of [...SUPPORT_TOOLS, ...CRM_TOOLS].filter((x) => x.kind === 'read')) expect(t.card, t.name).toBeUndefined();
  });

  const args = (name: string, body: string): Record<string, unknown> => {
    const id = name.startsWith('zendesk') ? '4101' : name.startsWith('intercom') ? 'c1' : name.startsWith('hubspot') ? '501' : '500AB000003ijkl';
    return name.startsWith('intercom') ? { conversationId: id, body } : name.startsWith('salesforce') ? { caseId: id, body } : name.startsWith('hubspot') ? { contactId: id, body } : { ticketId: id, body };
  };

  it('a note or a reply: the summary leads with the act and the target and stays under 300; the whole text is on the card, in pieces of 250 or fewer', () => {
    const text = `${'The invoice was charged twice. '.repeat(70)}END`.slice(0, MAX_NOTE - 3) + 'END';
    expect(text.length).toBe(MAX_NOTE);
    for (const name of textual) {
      const card = def(name).card!(args(name, text));
      expect(card.summary.length, name).toBeLessThanOrEqual(300);
      expect(card.summary, name).toMatch(/^(Add an? |Reply to the customer)/);
      const parts = card.preview['text'] as string[];
      expect(parts.join(''), name).toBe(text);
      expect(parts.length, name).toBeLessThanOrEqual(10);
      for (const p of parts) expect(p.length, name).toBeLessThanOrEqual(250);
      expect(card.preview['visibility'], name).toEqual(expect.any(String));
    }
  });

  it('says whether the customer will see it', () => {
    expect(def('zendesk.reply').card!(args('zendesk.reply', 'Hello')).preview['visibility']).toMatch(/customer is emailed/);
    expect(def('zendesk.add_note').card!(args('zendesk.add_note', 'Hello')).preview['visibility']).toMatch(/customer does not see/);
    expect(def('intercom.reply').card!(args('intercom.reply', 'Hello')).preview['visibility']).toMatch(/customer sees/);
    expect(def('salesforce.add_case_note').card!(args('salesforce.add_case_note', 'Hello')).preview['visibility']).toMatch(/not published/);
    expect(def('zendesk.set_status').card!({ ticketId: '4101', status: 'solved' }).preview['note']).toMatch(/may email the customer/);
    expect(def('zendesk.set_status').card!({ ticketId: '4101', status: 'open' }).preview).not.toHaveProperty('note');
  });

  it('a status change names the target and the new value', () => {
    expect(def('zendesk.set_status').card!({ ticketId: '4101', status: 'pending' }).summary).toBe('Set Zendesk ticket 4101 to pending');
    expect(def('intercom.set_state').card!({ conversationId: 'c1', state: 'closed' }).summary).toBe('Close Intercom conversation c1');
    expect(def('intercom.set_state').card!({ conversationId: 'c1', state: 'open' }).summary).toBe('Reopen Intercom conversation c1');
    expect(def('hubspot.set_lead_status').card!({ contactId: '501', status: 'CONNECTED' }).summary).toBe('Set the lead status of HubSpot contact 501 to CONNECTED');
    expect(def('salesforce.set_case_status').card!({ caseId: '500AB000003ijkl', status: 'Closed' }).summary).toBe('Set Salesforce case 500AB000003ijkl to “Closed”');
  });
});

describe('the catalog and the tools agree', () => {
  const ids = ['zendesk', 'intercom', 'hubspot', 'salesforce'] as const;

  it('every tool the catalog offers is built, under its service, with the access the catalog says; every built tool is in the catalog', () => {
    for (const id of ids) {
      const entry = connectorEntry(id)!;
      expect(entry, id).toBeDefined();
      const built = entry.tools.filter((t) => t.available);
      for (const t of built) {
        const d = personToolDef(t.name);
        expect(d, t.name).toBeDefined();
        expect(d!.provider, t.name).toBe(id);
        expect(d!.kind, t.name).toBe(t.access);
        expect(d!.service, t.name).toBe(t.service);
        expect(entry.services.find((s) => s.id === t.service)?.available, t.name).toBe(true);
      }
      const names = new Set(built.map((t) => t.name));
      for (const d of PERSON_TOOL_DEFS.filter((t) => t.provider === id)) expect(names.has(d.name), d.name).toBe(true);
      for (const t of entry.tools.filter((x) => x.destructive)) expect(personToolDef(t.name), t.name).toBeUndefined();
    }
  });

  it('triggers are listed but not available; Freshdesk is still planned', () => {
    for (const id of ids) for (const t of connectorEntry(id)!.triggers) expect(t.available, `${id}:${t.id}`).toBe(false);
    expect(connectorEntry('freshdesk')).toMatchObject({ status: 'planned' });
  });

  it('the scopes: the read service asks only to read, the write service for the write scope; Salesforce asks for the one scope it has', () => {
    const scopes = (id: string, svc: string) => connectorEntry(id)!.services.find((s) => s.id === svc)!.scopes;
    expect(scopes('zendesk', 'tickets')).toEqual(['read']);
    expect(scopes('zendesk', 'tickets_write')).toEqual(['tickets:write']);
    expect(scopes('hubspot', 'contacts')).toEqual(['crm.objects.contacts.read']);
    expect(scopes('hubspot', 'contacts_write')).toEqual(['crm.objects.contacts.write']);
    expect(scopes('salesforce', 'records')).toEqual(['api']);
  });
});
