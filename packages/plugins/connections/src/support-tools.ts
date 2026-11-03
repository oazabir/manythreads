import { z } from 'zod';
import { address, asArray, asRecord, cardOf, clip, enc, limit, Q, str, stripHtml, untrusted, type PersonToolDef } from './person-kit.ts';
import { htmlOf, idStr, noteText, numericId, searchWords, textCard, unexpected, wordId, zendeskPhrase } from './support-kit.ts';

// The tools of a person's Zendesk and Intercom connection (PLAN P16-07): search and read a ticket or a conversation, look up the customer, and, each behind an approval card
// with exactly the text that will go out, add an internal note, reply to the customer, and change the status. They are written the way google-tools.ts and
// microsoft-tools.ts are, from the shared helpers of person-kit.ts and support-kit.ts. Nothing here deletes anything, and nothing here can reach another address than the
// provider's own: a tool passes a path, and an id in a path is a short run of digits or letters, encoded.

const SNIPPET = 300;
const COMMENT_TEXT = 2000;
const MAX_COMMENTS = 30;

/** An address-or-words lookup of a person: an address is looked for as it is, words as a phrase. */
const customerQuery = searchWords.describe('An email address, or words from the customer’s name.');

// ---- Zendesk ------------------------------------------------------------------------------------------------------------------------------------------

const ZD_STATUSES = ['new', 'open', 'pending', 'hold', 'solved'] as const;
/** The statuses a tool may set: `new` is only what a ticket starts as, and `closed` cannot be set through the API at all. */
const ZD_SETTABLE = ['open', 'pending', 'hold', 'solved'] as const;

const zdTicketLine = (t: unknown): Record<string, unknown> => {
  const r = asRecord(t);
  return {
    id: idStr(r['id']),
    subject: str(r['subject'], 300),
    status: str(r['status'], 20),
    priority: str(r['priority'], 20),
    requesterId: idStr(r['requester_id']),
    updated: str(r['updated_at'], 40),
    snippet: str(r['description'], SNIPPET),
  };
};

/** The ticket numbers a Zendesk answer holds that can safely go in a path (digits only). */
const safeUserId = (v: unknown): string | null => {
  const id = idStr(v);
  return id !== null && /^[1-9][0-9]{0,14}$/.test(id) ? id : null;
};

const ZENDESK_TOOLS: PersonToolDef[] = [
  {
    name: 'zendesk.search_tickets',
    provider: 'zendesk',
    service: 'tickets',
    kind: 'read',
    description: `Search the Zendesk tickets the asking person can see, by words, and optionally by status or by the requester's address. Newest first.${untrusted}`,
    input: z.strictObject({ query: searchWords, status: z.enum(ZD_STATUSES).optional(), requester: address.optional(), limit }),
    async run(api, input) {
      const i = input as { query: string; status?: string; requester?: string };
      const { limit: n } = Q(input);
      const q = ['type:ticket', ...(i.status ? [`status:${i.status}`] : []), ...(i.requester ? [`requester:${i.requester}`] : []), zendeskPhrase(i.query)].join(' ');
      const doc = asRecord(await api.json('/search.json', { query: { query: q, per_page: n, sort_by: 'updated_at', sort_order: 'desc' } }));
      return { ok: true, tickets: asArray(doc['results']).slice(0, n).map(zdTicketLine) };
    },
  },
  {
    name: 'zendesk.read_ticket',
    provider: 'zendesk',
    service: 'tickets',
    kind: 'read',
    description: `Read one Zendesk ticket by the id a search answered: its details and its latest comments, internal notes included (each says whether the customer sees it).${untrusted}`,
    input: z.strictObject({ ticketId: numericId('ticket') }),
    async run(api, input) {
      const id = enc(String(input['ticketId']));
      const ticket = asRecord(asRecord(await api.json(`/tickets/${id}.json`))['ticket']);
      const comments = asRecord(await api.json(`/tickets/${id}/comments.json`, { query: { per_page: MAX_COMMENTS, sort_order: 'desc' } }));
      const list = asArray(comments['comments'])
        .slice(0, MAX_COMMENTS)
        .map((c) => {
          const r = asRecord(c);
          return { id: idStr(r['id']), authorId: idStr(r['author_id']), public: r['public'] === true, created: str(r['created_at'], 40), text: clip(str(r['plain_body'], 40_000) ?? str(r['body'], 40_000) ?? '', COMMENT_TEXT).text };
        })
        .reverse();
      return {
        ok: true,
        ticket: {
          ...zdTicketLine(ticket),
          snippet: undefined,
          assigneeId: idStr(ticket['assignee_id']),
          created: str(ticket['created_at'], 40),
          tags: asArray(ticket['tags']).slice(0, 20).flatMap((t) => (typeof t === 'string' ? [t.slice(0, 40)] : [])),
        },
        comments: list,
      };
    },
  },
  {
    name: 'zendesk.find_customer',
    provider: 'zendesk',
    service: 'tickets',
    kind: 'read',
    description: `Look up a customer in Zendesk by email address or name: who they are and their most recent tickets.${untrusted}`,
    input: z.strictObject({ query: customerQuery, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const doc = asRecord(await api.json('/users/search.json', { query: { query: zendeskPhrase(q), per_page: n } }));
      const users = asArray(doc['users']).slice(0, n).map((u) => {
        const r = asRecord(u);
        return { id: idStr(r['id']), name: str(r['name'], 200), email: str(r['email'], 320), role: str(r['role'], 20), organizationId: idStr(r['organization_id']), created: str(r['created_at'], 40) };
      });
      // the first match's latest tickets: the id goes in a path, so it is used only when it is plain digits
      const first = safeUserId(users[0]?.id);
      let recent: unknown[] = [];
      if (first !== null) {
        const tickets = asRecord(await api.json(`/users/${enc(first)}/tickets/requested.json`, { query: { per_page: 5, sort_by: 'updated_at', sort_order: 'desc' } }));
        recent = asArray(tickets['tickets']).slice(0, 5).map((t) => {
          const z = zdTicketLine(t);
          return { id: z['id'], subject: z['subject'], status: z['status'], updated: z['updated'] };
        });
      }
      return { ok: true, customers: users, recentTicketsOfFirst: recent };
    },
  },
  {
    name: 'zendesk.add_note',
    provider: 'zendesk',
    service: 'tickets_write',
    kind: 'write',
    description: "Add an internal note to a Zendesk ticket: only the agents see it, the customer does not. Needs the person's approval.",
    input: z.strictObject({ ticketId: numericId('ticket'), body: noteText('The text of the note.') }),
    card: (i) => textCard(`Add an internal note to Zendesk ticket ${String(i['ticketId'])}`, String(i['body']), { ticket: String(i['ticketId']), visibility: 'Internal note: the customer does not see it' }),
    async run(api, input) {
      const i = input as { ticketId: string; body: string };
      const doc = asRecord(await api.json(`/tickets/${enc(i.ticketId)}.json`, { method: 'PUT', body: { ticket: { comment: { body: i.body, public: false } } } }));
      return { ok: true, ticketId: i.ticketId, status: str(asRecord(doc['ticket'])['status'], 20) };
    },
  },
  {
    name: 'zendesk.reply',
    provider: 'zendesk',
    service: 'tickets_write',
    kind: 'write',
    description: "Reply to the customer on a Zendesk ticket: a public comment that Zendesk emails to them. It cannot be taken back. Needs the person's approval.",
    input: z.strictObject({ ticketId: numericId('ticket'), body: noteText('The text of the reply, as the customer will read it.') }),
    card: (i) => textCard(`Reply to the customer on Zendesk ticket ${String(i['ticketId'])}`, String(i['body']), { ticket: String(i['ticketId']), visibility: 'Public reply: the customer is emailed this text' }),
    async run(api, input) {
      const i = input as { ticketId: string; body: string };
      const doc = asRecord(await api.json(`/tickets/${enc(i.ticketId)}.json`, { method: 'PUT', body: { ticket: { comment: { body: i.body, public: true } } } }));
      return { ok: true, ticketId: i.ticketId, status: str(asRecord(doc['ticket'])['status'], 20) };
    },
  },
  {
    name: 'zendesk.set_status',
    provider: 'zendesk',
    service: 'tickets_write',
    kind: 'write',
    description: "Change the status of a Zendesk ticket to open, pending, hold or solved. Zendesk's own rules may tell the customer when a ticket is solved. Needs the person's approval.",
    input: z.strictObject({ ticketId: numericId('ticket'), status: z.enum(ZD_SETTABLE) }),
    card: (i) =>
      cardOf(`Set Zendesk ticket ${String(i['ticketId'])} to ${String(i['status'])}`, {
        ticket: String(i['ticketId']),
        status: String(i['status']),
        ...(i['status'] === 'solved' ? { note: 'Zendesk may email the customer that the ticket is solved.' } : {}),
      }),
    async run(api, input) {
      const i = input as { ticketId: string; status: string };
      const doc = asRecord(await api.json(`/tickets/${enc(i.ticketId)}.json`, { method: 'PUT', body: { ticket: { status: i.status } } }));
      return { ok: true, ticketId: i.ticketId, status: str(asRecord(doc['ticket'])['status'], 20) ?? i.status };
    },
  },
];

// ---- Intercom -----------------------------------------------------------------------------------------------------------------------------------------

const IC_STATES = ['open', 'closed', 'snoozed'] as const;

/** The id of the signed-in admin: Intercom wants it on every reply, note and state change. Digits or letters only, so it can only be what it should be. */
async function adminId(api: { json(path: string): Promise<unknown> }): Promise<string> {
  const id = idStr(asRecord(await api.json('/me'))['id']);
  if (id === null || !/^[A-Za-z0-9]{1,40}$/.test(id)) throw unexpected('Intercom');
  return id;
}

const icConversationLine = (c: unknown): Record<string, unknown> => {
  const r = asRecord(c);
  const source = asRecord(r['source']);
  const author = asRecord(source['author']);
  return {
    id: idStr(r['id']),
    state: str(r['state'], 20),
    created: typeof r['created_at'] === 'number' ? new Date(r['created_at'] * 1000).toISOString() : null,
    updated: typeof r['updated_at'] === 'number' ? new Date(r['updated_at'] * 1000).toISOString() : null,
    subject: str(source['subject'], 300),
    snippet: stripHtml(str(source['body'], 4000) ?? '').slice(0, SNIPPET),
    startedBy: { type: str(author['type'], 20), id: idStr(author['id']) },
  };
};

const INTERCOM_TOOLS: PersonToolDef[] = [
  {
    name: 'intercom.search_conversations',
    provider: 'intercom',
    service: 'conversations',
    kind: 'read',
    description: `Search the Intercom conversations by words in the first message, and optionally by state.${untrusted}`,
    input: z.strictObject({ query: searchWords, state: z.enum(IC_STATES).optional(), limit }),
    async run(api, input) {
      const i = input as { query: string; state?: string };
      const { limit: n } = Q(input);
      const filters = [{ field: 'source.body', operator: '~', value: i.query }, ...(i.state ? [{ field: 'state', operator: '=', value: i.state }] : [])];
      const doc = asRecord(await api.json('/conversations/search', { method: 'POST', body: { query: { operator: 'AND', value: filters }, pagination: { per_page: n } } }));
      return { ok: true, conversations: asArray(doc['conversations']).slice(0, n).map(icConversationLine) };
    },
  },
  {
    name: 'intercom.read_conversation',
    provider: 'intercom',
    service: 'conversations',
    kind: 'read',
    description: `Read one Intercom conversation by the id a search answered: its first message and the latest parts, internal notes included (each part says what kind it is).${untrusted}`,
    input: z.strictObject({ conversationId: wordId('conversation') }),
    async run(api, input) {
      const doc = asRecord(await api.json(`/conversations/${enc(String(input['conversationId']))}`, { query: { display_as: 'plaintext' } }));
      const parts = asArray(asRecord(doc['conversation_parts'])['conversation_parts'])
        .slice(-MAX_COMMENTS)
        .map((p) => {
          const r = asRecord(p);
          const author = asRecord(r['author']);
          return {
            id: idStr(r['id']),
            kind: str(r['part_type'], 40),
            author: { type: str(author['type'], 20), id: idStr(author['id']) },
            created: typeof r['created_at'] === 'number' ? new Date(r['created_at'] * 1000).toISOString() : null,
            text: clip(stripHtml(str(r['body'], 40_000) ?? ''), COMMENT_TEXT).text,
          };
        });
      const first = icConversationLine(doc);
      return {
        ok: true,
        conversation: { ...first, snippet: undefined, firstMessage: clip(stripHtml(str(asRecord(doc['source'])['body'], 40_000) ?? ''), COMMENT_TEXT).text, assigneeId: idStr(doc['admin_assignee_id']) },
        parts,
      };
    },
  },
  {
    name: 'intercom.find_customer',
    provider: 'intercom',
    service: 'conversations',
    kind: 'read',
    description: `Look up a customer (a contact) in Intercom by email address or by name.${untrusted}`,
    input: z.strictObject({ email: address.optional(), name: z.string().min(1).max(100).optional() }).refine((v) => (v.email === undefined) !== (v.name === undefined), { message: 'give an email or a name, not both' }),
    async run(api, input) {
      const i = input as { email?: string; name?: string };
      const field = i.email !== undefined ? { field: 'email', operator: '=', value: i.email } : { field: 'name', operator: '~', value: i.name };
      const doc = asRecord(await api.json('/contacts/search', { method: 'POST', body: { query: field, pagination: { per_page: 5 } } }));
      return {
        ok: true,
        customers: asArray(doc['data']).slice(0, 5).map((c) => {
          const r = asRecord(c);
          return {
            id: idStr(r['id']),
            role: str(r['role'], 20),
            name: str(r['name'], 200),
            email: str(r['email'], 320),
            created: typeof r['created_at'] === 'number' ? new Date(r['created_at'] * 1000).toISOString() : null,
            lastSeen: typeof r['last_seen_at'] === 'number' ? new Date(r['last_seen_at'] * 1000).toISOString() : null,
          };
        }),
      };
    },
  },
  {
    name: 'intercom.add_note',
    provider: 'intercom',
    service: 'conversations_write',
    kind: 'write',
    description: "Add an internal note to an Intercom conversation: only the team sees it, the customer does not. Needs the person's approval.",
    input: z.strictObject({ conversationId: wordId('conversation'), body: noteText('The text of the note.') }),
    card: (i) => textCard(`Add an internal note to Intercom conversation ${String(i['conversationId'])}`, String(i['body']), { conversation: String(i['conversationId']), visibility: 'Internal note: the customer does not see it' }),
    async run(api, input) {
      const i = input as { conversationId: string; body: string };
      const admin = await adminId(api);
      await api.json(`/conversations/${enc(i.conversationId)}/reply`, { method: 'POST', body: { message_type: 'note', type: 'admin', admin_id: admin, body: htmlOf(i.body) } });
      return { ok: true, conversationId: i.conversationId };
    },
  },
  {
    name: 'intercom.reply',
    provider: 'intercom',
    service: 'conversations_write',
    kind: 'write',
    description: "Reply to the customer in an Intercom conversation: the customer is shown this text. It cannot be taken back. Needs the person's approval.",
    input: z.strictObject({ conversationId: wordId('conversation'), body: noteText('The text of the reply, as the customer will read it.') }),
    card: (i) => textCard(`Reply to the customer in Intercom conversation ${String(i['conversationId'])}`, String(i['body']), { conversation: String(i['conversationId']), visibility: 'Public reply: the customer sees this text' }),
    async run(api, input) {
      const i = input as { conversationId: string; body: string };
      const admin = await adminId(api);
      await api.json(`/conversations/${enc(i.conversationId)}/reply`, { method: 'POST', body: { message_type: 'comment', type: 'admin', admin_id: admin, body: htmlOf(i.body) } });
      return { ok: true, conversationId: i.conversationId };
    },
  },
  {
    name: 'intercom.set_state',
    provider: 'intercom',
    service: 'conversations_write',
    kind: 'write',
    description: "Close an Intercom conversation, or open a closed one again. Needs the person's approval.",
    input: z.strictObject({ conversationId: wordId('conversation'), state: z.enum(['open', 'closed']) }),
    card: (i) => cardOf(`${i['state'] === 'closed' ? 'Close' : 'Reopen'} Intercom conversation ${String(i['conversationId'])}`, { conversation: String(i['conversationId']), state: String(i['state']) }),
    async run(api, input) {
      const i = input as { conversationId: string; state: 'open' | 'closed' };
      const admin = await adminId(api);
      await api.json(`/conversations/${enc(i.conversationId)}/parts`, { method: 'POST', body: { message_type: i.state === 'closed' ? 'close' : 'open', type: 'admin', admin_id: admin } });
      return { ok: true, conversationId: i.conversationId, state: i.state };
    },
  },
];

export const SUPPORT_TOOLS: PersonToolDef[] = [...ZENDESK_TOOLS, ...INTERCOM_TOOLS];
