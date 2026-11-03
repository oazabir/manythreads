import { z } from 'zod';
import { ProviderError, type ProviderApi } from './oauth/api.ts';
import {
  address,
  asArray,
  asRecord,
  cardOf,
  clip,
  draftFields,
  enc,
  eventFields,
  freeBusyInput,
  freeGaps,
  idOf,
  limit,
  listWindow,
  MAX_PART,
  mergeBusy,
  names,
  odataQuote,
  oneLine,
  query,
  Q,
  str,
  stripHtml,
  untrusted,
  when,
  windowOf,
  type PersonToolDef,
  type Span,
} from './person-kit.ts';

// The tools of a person's Microsoft 365 connection (PLAN P8-02, in depth in P16-04): OneDrive and SharePoint files (read), Outlook mail (folders, categories, search, read,
// categorise, draft, send and reply) and the Outlook calendar (list, free/busy, add, change). They are written the way google-tools.ts is, from the shared helpers of
// person-kit.ts. What the rules of that file say holds here:
//
//   * Every tool that writes carries a `card`: the approver reads every recipient, the subject and the first 1,500 characters of the text before anything goes out.
//   * There is no `bcc` and no `replyTo` field in any input, no header is ever taken from the model (Graph takes a message as JSON, so there is no raw header to inject
//     into), addresses are ASCII with no space, an id is a short run of safe characters that is not only dots.
//   * An answer or an error never repeats text from the person's mailbox or files: an error message is ours (a provider's own text never reaches the model), and where a
//     tool refuses because of something the mailbox holds (an unknown category) it says what to call, not what the mailbox contains.
//   * Nothing here deletes, moves to the bin or shares anything.

// ---- shared pieces ------------------------------------------------------------------------------------------------------------------------------------------

/** A time as Graph answers it: UTC without an offset (`2026-11-03T09:00:00.0000000`) becomes an ISO time with `Z`; one that already carries an offset is left as it is. */
export const graphTime = (t: unknown): string | null => {
  const r = asRecord(t);
  const raw = str(r['dateTime'], 40);
  if (raw === null || raw === '') return null;
  if (/(?:Z|[+-]\d\d:\d\d)$/.test(raw)) return raw;
  const zone = str(r['timeZone'], 40);
  return zone === null || zone === 'UTC' ? `${raw}Z` : raw;
};
/** A time as Graph is sent it: the instant in UTC, written without an offset (the offset of the model's time would be read differently by Outlook). */
const graphLocal = (iso: string): { dateTime: string; timeZone: 'UTC' } => ({ dateTime: new Date(iso).toISOString().slice(0, 19), timeZone: 'UTC' });
const UTC_HEADER = { prefer: 'outlook.timezone="UTC"' };

const recipients = (list: readonly string[]): Array<{ emailAddress: { address: string } }> => list.map((a) => ({ emailAddress: { address: a } }));
const addressOf = (v: unknown): string | null => str(asRecord(asRecord(v)['emailAddress'])['address'], 320);

/** A line of text with no control or line-break characters at all (the subject of a mail, the name of a category). */
function plainLine(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return false;
  }
  return true;
}
const subjectLine = z.string().min(1).max(300).refine(plainLine, 'one line');
const categoryWord = z.string().min(1).max(100).refine(plainLine, 'one line').describe('A category by its name, as outlook.list_categories shows it.');
const folderWord = z
  .string()
  .regex(/^[A-Za-z0-9_=-]{1,300}$/, 'not a folder')
  .describe('A mail folder: inbox, sentitems, drafts, deleteditems, archive, junkemail, or the id outlook.list_folders answered.');
/** The id of a draft Outlook made, before it is placed in an address. */
const MADE_ID = /^[A-Za-z0-9_=-]{1,300}$/;

const MAIL_SELECT = 'id,subject,from,receivedDateTime,bodyPreview,categories,isRead,conversationId,parentFolderId';
const mailSummary = (m: unknown): Record<string, unknown> => {
  const r = asRecord(m);
  return {
    id: str(r['id'], 300),
    from: addressOf(r['from']),
    subject: str(r['subject'], 300),
    date: str(r['receivedDateTime'], 40),
    snippet: str(r['bodyPreview'], 300),
    categories: asArray(r['categories']).slice(0, 25).flatMap((c) => (typeof c === 'string' ? [c.slice(0, 100)] : [])),
    unread: r['isRead'] === false,
    conversationId: str(r['conversationId'], 300),
    folderId: str(r['parentFolderId'], 300),
  };
};

// ---- files: OneDrive and SharePoint ------------------------------------------------------------------------------------------------------------------------

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** The most rows and columns of a workbook's first sheet that are read as CSV. */
const SHEET_RANGE = 'A1:Z200';
const SHEET_ID = /^[A-Za-z0-9{}_-]{1,100}$/;

const csvCell = (v: unknown): string => {
  const s = typeof v === 'string' ? v.slice(0, 1000) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
/** The values of a sheet range as CSV: trailing empty cells and rows left off. */
export function valuesToCsv(values: unknown): { text: string; rows: number } {
  const rows = asArray(values)
    .slice(0, 200)
    .map((row) => {
      const cells = asArray(row).slice(0, 26).map(csvCell);
      while (cells.length > 0 && cells.at(-1) === '') cells.pop();
      return cells.join(',');
    });
  while (rows.length > 0 && rows.at(-1) === '') rows.pop();
  return { text: rows.join('\n'), rows: rows.length };
}

/** Reads one drive item (`base` is `/me/drive/items/<id>` or `/drives/<drive>/items/<id>`, ids already encoded): plain text as it is, a workbook's first sheet as CSV. */
async function readDriveItem(api: ProviderApi, base: string): Promise<unknown> {
  const meta = asRecord(await api.json(base, { query: { $select: 'id,name,size,file,webUrl,lastModifiedDateTime' } }));
  const mime = str(asRecord(meta['file'])['mimeType'], 120) ?? '';
  const name = str(meta['name'], 300) ?? '';
  const common = { id: str(meta['id'], 200), name, modified: str(meta['lastModifiedDateTime'], 40) };
  if (mime === XLSX_MIME || /\.xlsx$/i.test(name)) {
    const sheets = asRecord(await api.json(`${base}/workbook/worksheets`, { query: { $select: 'id,name', $top: 1 } }));
    const first = asRecord(asArray(sheets['value'])[0]);
    const sheetId = str(first['id'], 100);
    if (sheetId === null || !SHEET_ID.test(sheetId)) return { ok: false, code: 'not_readable', message: 'That workbook has no sheet that can be read here. Its link is in the search result.' };
    const range = asRecord(await api.json(`${base}/workbook/worksheets/${enc(sheetId)}/range(address='${SHEET_RANGE}')`, { query: { $select: 'values' } }));
    const csv = valuesToCsv(range['values']);
    const cut = clip(csv.text);
    return { ok: true, ...common, type: 'text/csv', sheet: str(first['name'], 100), text: cut.text, truncated: cut.truncated || csv.rows >= 200, note: 'The first sheet, up to 200 rows and columns A to Z, as CSV.' };
  }
  const textual = mime.startsWith('text/') || mime === 'application/json' || /\.(md|txt|csv|json)$/i.test(name);
  if (!textual) return { ok: false, code: 'not_readable', message: 'That file is not plain text or a spreadsheet and cannot be read here. Its link is in the search result.' };
  const raw = await api.text(`${base}/content`);
  const cut = clip(raw.text);
  return { ok: true, ...common, type: mime, text: cut.text, truncated: cut.truncated || raw.truncated };
}

// ---- the tools ------------------------------------------------------------------------------------------------------------------------------------------------

const mailSearchInput = z
  .strictObject({
    query: query.optional(),
    from: address.describe('Only mail from this address.').optional(),
    subject: z.string().min(1).max(200).refine(plainLine, 'one line').describe('Only mail whose subject has these words in it.').optional(),
    after: when.describe('Only mail received after this time.').optional(),
    before: when.describe('Only mail received before this time.').optional(),
    folder: folderWord.optional(),
    category: categoryWord.optional(),
    unreadOnly: z.boolean().describe('Only mail that has not been read.').optional(),
    limit,
  })
  .refine((v) => ['query', 'from', 'subject', 'after', 'before', 'folder', 'category', 'unreadOnly'].some((k) => (v as Record<string, unknown>)[k] !== undefined), {
    message: 'give words to look for or at least one filter (from, subject, after, before, folder, category or unreadOnly)',
    path: ['query'],
  });

const sendFields = {
  // at most 10 in all: the approval card keeps ten items of a list and says "… N more" for the rest, and an approver must read every address
  to: z.array(address).min(1).max(10),
  cc: z.array(address).max(10).optional(),
  subject: subjectLine,
  body: draftFields.body,
  replyToMessageId: idOf('message this answers').describe('Set it to answer a message: the reply stays in that message’s conversation. Needs the Outlook drafts permission too.').optional(),
};

const eventPatch = z
  .strictObject({
    eventId: idOf('event'),
    title: eventFields.title.optional(),
    start: eventFields.start.optional(),
    end: eventFields.end.optional(),
    attendees: z.array(address).max(20).describe('The whole list of guests after the change (it replaces the list). Outlook tells the guests about the change.').optional(),
    description: z.string().max(4000).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'eventId'), { message: 'say what to change as well (title, start, end, attendees or description)', path: ['eventId'] });

const eventBody = (i: { title?: string; start?: string; end?: string; attendees?: string[]; description?: string }): Record<string, unknown> => ({
  ...(i.title !== undefined ? { subject: i.title } : {}),
  ...(i.description !== undefined ? { body: { contentType: 'Text', content: i.description } } : {}),
  ...(i.start !== undefined ? { start: graphLocal(i.start) } : {}),
  ...(i.end !== undefined ? { end: graphLocal(i.end) } : {}),
  ...(i.attendees !== undefined ? { attendees: i.attendees.map((a) => ({ emailAddress: { address: a }, type: 'required' })) } : {}),
});

/** What Outlook does that the person should know when they approve: guests of an event are told by Outlook itself. */
const GUESTS_NOTE = 'Outlook emails an invitation or update to every guest.';

interface Category {
  name: string;
  color: string | null;
}
async function masterCategories(api: ProviderApi): Promise<Category[]> {
  const doc = asRecord(await api.json('/me/outlook/masterCategories'));
  return asArray(doc['value'])
    .slice(0, 250)
    .flatMap((c) => {
      const r = asRecord(c);
      const name = str(r['displayName'], 100);
      return name ? [{ name, color: str(r['color'], 20) }] : [];
    });
}

export const MICROSOFT_TOOLS: PersonToolDef[] = [
  // ---- OneDrive and SharePoint
  {
    name: 'onedrive.search',
    provider: 'microsoft',
    service: 'onedrive',
    kind: 'read',
    description: `Search the asking person's OneDrive for files whose name or text holds the words you give.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const doc = asRecord(await api.json(`/me/drive/root/search(q='${enc(odataQuote(q))}')`, { query: { $top: n, $select: 'id,name,file,lastModifiedDateTime,webUrl' } }));
      return {
        ok: true,
        files: asArray(doc['value']).slice(0, n).map((f) => {
          const r = asRecord(f);
          return { id: str(r['id'], 200), name: str(r['name'], 300), type: str(asRecord(r['file'])['mimeType'], 100), modified: str(r['lastModifiedDateTime'], 40), link: str(r['webUrl'], 500) };
        }),
      };
    },
  },
  {
    name: 'onedrive.read',
    provider: 'microsoft',
    service: 'onedrive',
    kind: 'read',
    description: `Read the text of one file of the asking person's OneDrive by the id a search answered: a plain text, Markdown, CSV or JSON file as it is, or the first sheet of an Excel workbook as CSV (up to 200 rows, columns A to Z).${untrusted}`,
    input: z.strictObject({ itemId: idOf('file') }),
    run: (api, input) => readDriveItem(api, `/me/drive/items/${enc(String(input['itemId']))}`),
  },
  {
    name: 'sharepoint.search',
    provider: 'microsoft',
    service: 'sharepoint',
    kind: 'read',
    description: `Search the files in the SharePoint sites and the OneDrive that the asking person can open, by the words you give; answers each file's name, link and the ids sharepoint.read needs.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      // the words go in as one quoted phrase; a quote in them is dropped so they cannot close it and add search operators
      const doc = asRecord(await api.json('/search/query', { method: 'POST', body: { requests: [{ entityTypes: ['driveItem'], query: { queryString: `"${q.replaceAll('"', ' ')}"` }, from: 0, size: n }] } }));
      const container = asRecord(asArray(asRecord(asArray(doc['value'])[0])['hitsContainers'])[0]);
      return {
        ok: true,
        files: asArray(container['hits'])
          .slice(0, n)
          .map((h) => {
            const r = asRecord(asRecord(h)['resource']);
            const parent = asRecord(r['parentReference']);
            return {
              driveId: str(parent['driveId'], 200),
              itemId: str(r['id'], 200),
              name: str(r['name'], 300),
              modified: str(r['lastModifiedDateTime'], 40),
              link: str(r['webUrl'], 500),
            };
          }),
      };
    },
  },
  {
    name: 'sharepoint.read',
    provider: 'microsoft',
    service: 'sharepoint',
    kind: 'read',
    description: `Read the text of one SharePoint (or OneDrive) file the asking person can open, by the driveId and itemId a sharepoint.search answered: a text, Markdown, CSV or JSON file as it is, or the first sheet of an Excel workbook as CSV.${untrusted}`,
    input: z.strictObject({ driveId: idOf('drive'), itemId: idOf('file') }),
    run: (api, input) => readDriveItem(api, `/drives/${enc(String(input['driveId']))}/items/${enc(String(input['itemId']))}`),
  },

  // ---- mail: read
  {
    name: 'outlook.list_folders',
    provider: 'microsoft',
    service: 'mail',
    kind: 'read',
    description: `List the mail folders of the asking person's Outlook (Inbox, Sent Items and the rest of the top level) with the id of each and how many messages are unread. The names inbox, sentitems, drafts, deleteditems, archive and junkemail work in place of an id.${untrusted}`,
    input: z.strictObject({}),
    async run(api) {
      const doc = asRecord(await api.json('/me/mailFolders', { query: { $top: 50, $select: 'id,displayName,unreadItemCount,totalItemCount' } }));
      return {
        ok: true,
        folders: asArray(doc['value'])
          .slice(0, 50)
          .map((f) => {
            const r = asRecord(f);
            return { id: str(r['id'], 300), name: str(r['displayName'], 200), unread: typeof r['unreadItemCount'] === 'number' ? r['unreadItemCount'] : null, total: typeof r['totalItemCount'] === 'number' ? r['totalItemCount'] : null };
          }),
      };
    },
  },
  {
    name: 'outlook.search',
    provider: 'microsoft',
    service: 'mail',
    kind: 'read',
    description: `Search the asking person's Outlook mail, newest first, by words and/or by sender, subject words, dates, folder, category or unread; answers the sender, subject, date, categories and a preview of each match.${untrusted}`,
    input: mailSearchInput,
    async run(api, input) {
      const i = input as { query?: string; from?: string; subject?: string; after?: string; before?: string; folder?: string; category?: string; unreadOnly?: boolean; limit?: number };
      const n = i.limit ?? 10;
      const base = i.folder ? `/me/mailFolders/${enc(i.folder)}/messages` : '/me/messages';
      const after = i.after ? new Date(i.after) : null;
      const before = i.before ? new Date(i.before) : null;
      let found: unknown[];
      if (i.query) {
        // Graph does not allow $filter together with $search, so the words are searched and the other limits are applied to the page that comes back
        const doc = asRecord(await api.json(base, { query: { $search: `"${i.query.replaceAll('"', ' ')}"`, $top: 50, $select: MAIL_SELECT } }));
        found = asArray(doc['value']).filter((m) => {
          const r = asRecord(m);
          const received = Date.parse(str(r['receivedDateTime'], 40) ?? '');
          if (i.from && addressOf(r['from'])?.toLowerCase() !== i.from.toLowerCase()) return false;
          if (i.subject && !(str(r['subject'], 300) ?? '').toLowerCase().includes(i.subject.toLowerCase())) return false;
          if (after && !(received > after.getTime())) return false;
          if (before && !(received < before.getTime())) return false;
          if (i.category && !asArray(r['categories']).some((c) => typeof c === 'string' && c.toLowerCase() === i.category!.toLowerCase())) return false;
          if (i.unreadOnly && r['isRead'] !== false) return false;
          return true;
        });
      } else {
        const clauses = [
          ...(after ? [`receivedDateTime gt ${after.toISOString()}`] : []),
          ...(before ? [`receivedDateTime lt ${before.toISOString()}`] : []),
          ...(i.from ? [`from/emailAddress/address eq '${odataQuote(i.from)}'`] : []),
          ...(i.subject ? [`contains(subject,'${odataQuote(i.subject)}')`] : []),
          ...(i.category ? [`categories/any(c:c eq '${odataQuote(i.category)}')`] : []),
          ...(i.unreadOnly ? ['isRead eq false'] : []),
        ];
        const doc = asRecord(await api.json(base, { query: { ...(clauses.length > 0 ? { $filter: clauses.join(' and ') } : {}), $top: n, $select: MAIL_SELECT } }));
        found = asArray(doc['value']);
      }
      return { ok: true, messages: found.slice(0, n).map(mailSummary) };
    },
  },
  {
    name: 'outlook.read',
    provider: 'microsoft',
    service: 'mail',
    kind: 'read',
    description: `Read one Outlook message of the asking person by the id a search answered: sender, recipients, subject, date, categories and the text.${untrusted}`,
    input: z.strictObject({ messageId: idOf('message') }),
    async run(api, input) {
      const doc = asRecord(
        await api.json(`/me/messages/${enc(String(input['messageId']))}`, {
          query: { $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,categories,isRead,conversationId,parentFolderId' },
          headers: { prefer: 'outlook.body-content-type="text"' },
        }),
      );
      const body = asRecord(doc['body']);
      const content = str(body['content'], MAX_PART) ?? '';
      const cut = clip(str(body['contentType'], 20) === 'html' ? stripHtml(content) : content);
      const summary = mailSummary(doc);
      return {
        ok: true,
        id: summary['id'],
        from: summary['from'],
        subject: summary['subject'],
        date: summary['date'],
        categories: summary['categories'],
        unread: summary['unread'],
        conversationId: summary['conversationId'],
        folderId: summary['folderId'],
        to: asArray(doc['toRecipients']).slice(0, 20).map(addressOf),
        cc: asArray(doc['ccRecipients']).slice(0, 20).map(addressOf),
        text: cut.text,
        truncated: cut.truncated,
      };
    },
  },
  {
    name: 'outlook.list_categories',
    provider: 'microsoft',
    service: 'mail_categories',
    kind: 'read',
    description: `List the colour categories of the asking person's Outlook (the names outlook.categorize accepts).${untrusted}`,
    input: z.strictObject({}),
    async run(api) {
      return { ok: true, categories: (await masterCategories(api)).map((c) => ({ name: c.name, color: c.color })) };
    },
  },

  // ---- mail: write
  {
    name: 'outlook.categorize',
    provider: 'microsoft',
    service: 'mail_categories',
    kind: 'write',
    description:
      "Put colour categories on one Outlook message of the asking person, or take categories off it, to sort their mail. The categories must already exist (outlook.list_categories); it never makes one, moves a message or deletes it. Needs the person's approval.",
    input: z
      .strictObject({ messageId: idOf('message'), add: z.array(categoryWord).max(5).optional(), remove: z.array(categoryWord).max(5).optional() })
      .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: 'name at least one category to add or remove', path: ['add'] }),
    card: (i) => cardOf(`Categorise a message: add ${names(i['add']).join(', ') || 'nothing'}, remove ${names(i['remove']).join(', ') || 'nothing'}`, { messageId: i['messageId'], add: names(i['add']), remove: names(i['remove']) }),
    async run(api, input) {
      const i = input as { messageId: string; add?: string[]; remove?: string[] };
      const lower = (s: string): string => s.toLowerCase();
      const adding = new Set((i.add ?? []).map(lower));
      if ((i.remove ?? []).some((c) => adding.has(lower(c)))) return { ok: false, code: 'invalid', message: 'The same category cannot be added and removed in one call.' };
      const own = i.add?.length ? await masterCategories(api) : [];
      const toAdd: string[] = [];
      for (const word of i.add ?? []) {
        const found = own.find((c) => lower(c.name) === lower(word));
        // the answer names no category of the mailbox: the model is pointed at the tool that lists them
        if (!found) return { ok: false, code: 'unknown_category', message: 'One of the categories to add is not one of this person’s categories. Call outlook.list_categories to see the ones that exist.' };
        if (!toAdd.includes(found.name)) toAdd.push(found.name);
      }
      const id = enc(i.messageId);
      const current = asArray(asRecord(await api.json(`/me/messages/${id}`, { query: { $select: 'categories' } }))['categories']).flatMap((c) => (typeof c === 'string' ? [c.slice(0, 100)] : []));
      const removing = new Set((i.remove ?? []).map(lower));
      const next = current.filter((c) => !removing.has(lower(c)));
      for (const c of toAdd) if (!next.some((x) => lower(x) === lower(c))) next.push(c);
      if (next.length > 25) return { ok: false, code: 'invalid', message: 'A message can carry at most 25 categories here.' };
      await api.json(`/me/messages/${id}`, { method: 'PATCH', body: { categories: next } });
      return { ok: true, id: i.messageId, categories: next };
    },
  },
  {
    name: 'outlook.draft',
    provider: 'microsoft',
    service: 'mail_drafts',
    kind: 'write',
    description: "Save a draft message in the asking person's Outlook. It is not sent: the person reads and sends it themselves. Needs the person's approval.",
    input: z.strictObject(draftFields),
    card: (i) => cardOf(`Save a draft to ${names(i['to']).join(', ')}: ${oneLine(i['subject'])}`, { to: names(i['to']), subject: oneLine(i['subject'], 300), body: String(i['body'] ?? '').slice(0, 1500) }),
    async run(api, input) {
      const i = input as { to: string[]; subject: string; body: string };
      const doc = asRecord(await api.json('/me/messages', { method: 'POST', body: { subject: i.subject, body: { contentType: 'Text', content: i.body }, toRecipients: recipients(i.to) } }));
      return { ok: true, draftId: str(doc['id'], 300), note: 'The draft is saved in the person’s Drafts folder; nothing was sent.' };
    },
  },
  {
    name: 'outlook.send',
    provider: 'microsoft',
    service: 'mail_send',
    kind: 'write',
    description:
      "Send a message from the asking person's Outlook, to the addresses you give, in plain text. It really is sent, so the person reads the recipients and the text and approves each one first. Set replyToMessageId to answer a message in its conversation (that needs the Outlook drafts permission too). There is no way to blind-copy anyone, and at most 10 recipients in all. Needs the person's approval.",
    input: z.strictObject(sendFields).refine((v) => v.to.length + (v.cc?.length ?? 0) <= 10, { message: 'at most 10 recipients in all', path: ['to'] }),
    card: (i) =>
      cardOf(`Send an email to ${names(i['to']).join(', ')}${Array.isArray(i['cc']) && i['cc'].length > 0 ? ` (cc ${names(i['cc']).join(', ')})` : ''}: ${oneLine(i['subject'])}`, {
        to: names(i['to']),
        cc: names(i['cc']),
        subject: oneLine(i['subject'], 300),
        body: String(i['body'] ?? '').slice(0, 1500),
        ...(typeof i['replyToMessageId'] === 'string' ? { inReplyTo: i['replyToMessageId'] } : {}),
      }),
    async run(api, input) {
      const i = input as { to: string[]; cc?: string[]; subject: string; body: string; replyToMessageId?: string };
      const fields = { subject: i.subject, body: { contentType: 'Text', content: i.body }, toRecipients: recipients(i.to), ccRecipients: recipients(i.cc ?? []) };
      if (!i.replyToMessageId) {
        await api.json('/me/sendMail', { method: 'POST', body: { message: fields, saveToSentItems: true } });
        return { ok: true, note: 'The message was sent.' };
      }
      // an answer: Outlook makes the reply draft in the conversation, the draft is set to exactly what the approver read (recipients, subject, text; nobody in bcc, no reply-to
      // address) and only then sent
      const made = asRecord(await api.json(`/me/messages/${enc(i.replyToMessageId)}/createReply`, { method: 'POST', body: {} }));
      const draftId = str(made['id'], 300);
      if (draftId === null || !MADE_ID.test(draftId)) return { ok: false, code: 'unexpected_answer', message: 'Outlook did not say which reply it prepared, so nothing was sent.' };
      try {
        await api.json(`/me/messages/${enc(draftId)}`, { method: 'PATCH', body: { ...fields, bccRecipients: [], replyTo: [] } });
        await api.json(`/me/messages/${enc(draftId)}/send`, { method: 'POST' });
      } catch (err) {
        if (err instanceof ProviderError) throw new ProviderError(err.status, `${err.message} A reply draft may have been left in the person’s Drafts folder.`);
        throw err;
      }
      return { ok: true, note: 'The reply was sent in its conversation.' };
    },
  },

  // ---- calendar
  {
    name: 'outlook_calendar.list_events',
    provider: 'microsoft',
    service: 'calendar',
    kind: 'read',
    description: `List events on the asking person's Outlook calendar between two times, soonest first. Times are UTC.${untrusted}`,
    input: z.strictObject(listWindow),
    async run(api, input) {
      const w = windowOf(api, input as { from?: string; to?: string });
      const n = typeof input['limit'] === 'number' ? input['limit'] : 10;
      const doc = asRecord(
        await api.json('/me/calendarView', {
          query: { startDateTime: w.from, endDateTime: w.to, $top: n, $orderby: 'start/dateTime', $select: 'id,subject,start,end,location,attendees,webLink' },
          headers: UTC_HEADER,
        }),
      );
      return {
        ok: true,
        events: asArray(doc['value']).slice(0, n).map((e) => {
          const r = asRecord(e);
          return {
            id: str(r['id'], 300),
            title: str(r['subject'], 300),
            start: graphTime(r['start']),
            end: graphTime(r['end']),
            location: str(asRecord(r['location'])['displayName'], 300),
            guests: asArray(r['attendees']).length,
            link: str(r['webLink'], 500),
          };
        }),
      };
    },
  },
  {
    name: 'outlook_calendar.free_busy',
    provider: 'microsoft',
    service: 'calendar_free_busy',
    kind: 'read',
    description: `Show when the asking person, and the people whose addresses you give, are busy between two times (never why), and, if asked, the stretches in which everyone is free. A calendar its owner has not shared shows as not visible. Work and school accounts only.${untrusted}`,
    input: freeBusyInput,
    async run(api, input) {
      const i = input as { from: string; to: string; people?: string[]; minMinutes?: number };
      const window = { start: new Date(i.from).toISOString(), end: new Date(i.to).toISOString() };
      const me = asRecord(await api.json('/me', { query: { $select: 'mail,userPrincipalName' } }));
      const mine = (str(me['mail'], 320) || str(me['userPrincipalName'], 320) || '').toLowerCase();
      if (!address.safeParse(mine).success) return { ok: false, code: 'unknown_account', message: 'Outlook did not give this account’s address, so free and busy cannot be asked.' };
      const people = [...new Set((i.people ?? []).map((p) => p.toLowerCase()))].filter((p) => p !== mine);
      const ids = [mine, ...people];
      const doc = asRecord(
        await api.json('/me/calendar/getSchedule', {
          method: 'POST',
          headers: UTC_HEADER,
          body: { schedules: ids, startTime: { dateTime: window.start.slice(0, 19), timeZone: 'UTC' }, endTime: { dateTime: window.end.slice(0, 19), timeZone: 'UTC' }, availabilityViewInterval: 30 },
        }),
      );
      const answered = new Map<string, Record<string, unknown>>();
      for (const entry of asArray(doc['value']).slice(0, 25)) {
        const r = asRecord(entry);
        const id = str(r['scheduleId'], 320);
        if (id) answered.set(id.toLowerCase(), r);
      }
      const everyone: Span[] = [];
      let all = true;
      const calendars = ids.map((id) => {
        const entry = answered.get(id);
        const visible = entry !== undefined && entry['error'] === undefined && Array.isArray(entry['scheduleItems']);
        const spans: Span[] = visible
          ? asArray(entry['scheduleItems'])
              .slice(0, 500)
              // free and "working elsewhere" are not busy; the subject and place of an item are never read
              .filter((s) => !['free', 'workingElsewhere'].includes(String(asRecord(s)['status'])))
              .map((s) => ({ start: graphTime(asRecord(s)['start']) ?? '', end: graphTime(asRecord(s)['end']) ?? '' }))
          : [];
        const busy = mergeBusy(spans);
        if (!visible) all = false;
        everyone.push(...busy);
        return { who: id === mine ? 'you' : id, visible, busy };
      });
      return { ok: true, window, calendars, ...(i.minMinutes ? { free: freeGaps(everyone, window, i.minMinutes), freeCoversEveryone: all } : {}) };
    },
  },
  {
    name: 'outlook_calendar.create_event',
    provider: 'microsoft',
    service: 'calendar_write',
    kind: 'write',
    description: "Add an event to the asking person's Outlook calendar. Outlook emails an invitation to every guest you list. Needs the person's approval.",
    input: z.strictObject(eventFields),
    card: (i) =>
      cardOf(`Add “${oneLine(i['title'], 80)}” to the calendar on ${oneLine(i['start'], 30)}`, {
        title: oneLine(i['title'], 300),
        start: i['start'],
        end: i['end'],
        guests: names(i['attendees']),
        description: String(i['description'] ?? '').slice(0, 1500),
        ...(Array.isArray(i['attendees']) && i['attendees'].length > 0 ? { note: GUESTS_NOTE } : {}),
      }),
    async run(api, input) {
      const i = input as { title: string; start: string; end: string; attendees?: string[]; description?: string };
      const doc = asRecord(await api.json('/me/events', { method: 'POST', body: eventBody(i) }));
      return { ok: true, id: str(doc['id'], 300), link: str(doc['webLink'], 500) };
    },
  },
  {
    name: 'outlook_calendar.update_event',
    provider: 'microsoft',
    service: 'calendar_write',
    kind: 'write',
    description:
      "Change an event on the asking person's Outlook calendar by the id a listing answered: its title, times, description or the whole list of guests. Only what you give is changed. Outlook tells the guests of the event about the change. Needs the person's approval.",
    input: eventPatch,
    card: (i) => {
      const fields = ['title', 'start', 'end', 'attendees', 'description'].filter((k) => i[k] !== undefined);
      return cardOf(`Change event ${oneLine(i['eventId'], 40)}: ${fields.join(', ')}`, {
        eventId: i['eventId'],
        ...(i['title'] !== undefined ? { title: oneLine(i['title'], 300) } : {}),
        ...(i['start'] !== undefined ? { start: i['start'] } : {}),
        ...(i['end'] !== undefined ? { end: i['end'] } : {}),
        ...(i['attendees'] !== undefined ? { guests: names(i['attendees']) } : {}),
        ...(i['description'] !== undefined ? { description: String(i['description']).slice(0, 1500) } : {}),
        note: GUESTS_NOTE,
      });
    },
    async run(api, input) {
      const i = input as { eventId: string; title?: string; start?: string; end?: string; attendees?: string[]; description?: string };
      const doc = asRecord(await api.json(`/me/events/${enc(i.eventId)}`, { method: 'PATCH', body: eventBody(i) }));
      return { ok: true, id: str(doc['id'], 300) ?? i.eventId, link: str(doc['webLink'], 500) };
    },
  },
];
