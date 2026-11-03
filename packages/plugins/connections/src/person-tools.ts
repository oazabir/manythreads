import type { ToolSourceTool } from '@manythreads/sdk';
import { z } from 'zod';
import { GOOGLE_TOOLS } from './google-tools.ts';
import { asArray, asRecord, clip, enc, eventFields, draftFields, idOf, limit, listWindow, MAX_PART, odataQuote, Q, query, str, stripHtml, title, untrusted, windowOf, type PersonToolDef } from './person-kit.ts';

// The tools of a person's Microsoft 365 and Notion connections (PLAN P8-02), and the list of every person tool. The shared helpers are in person-kit.ts and Google's tools in google-tools.ts.

// ---- Microsoft ---------------------------------------------------------------------------------------------------------------------------------------

// ---- Microsoft ---------------------------------------------------------------------------------------------------------------------------------------

const MICROSOFT_TOOLS: PersonToolDef[] = [
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
    description: `Read the text of one text file (plain text, Markdown, CSV, JSON) of the asking person's OneDrive by the id a search answered.${untrusted}`,
    input: z.strictObject({ itemId: idOf('file') }),
    async run(api, input) {
      const id = enc(String(input['itemId']));
      const meta = asRecord(await api.json(`/me/drive/items/${id}`, { query: { $select: 'id,name,size,file,webUrl,lastModifiedDateTime' } }));
      const mime = str(asRecord(meta['file'])['mimeType'], 120) ?? '';
      const name = str(meta['name'], 300) ?? '';
      const textual = mime.startsWith('text/') || mime === 'application/json' || /\.(md|txt|csv|json)$/i.test(name);
      if (!textual) return { ok: false, code: 'not_readable', message: 'That file is not plain text and cannot be read here. Its link is in the search result.' };
      const raw = await api.text(`/me/drive/items/${id}/content`);
      const cut = clip(raw.text);
      return { ok: true, id: str(meta['id'], 200), name, type: mime, modified: str(meta['lastModifiedDateTime'], 40), text: cut.text, truncated: cut.truncated || raw.truncated };
    },
  },
  {
    name: 'outlook.search',
    provider: 'microsoft',
    service: 'mail',
    kind: 'read',
    description: `Search the asking person's Outlook mail for the words you give; answers the sender, subject, date and a preview of each match.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      // Graph wants the words inside double quotes; a quote in them is dropped so they cannot close it
      const doc = asRecord(await api.json('/me/messages', { query: { $search: `"${q.replaceAll('"', ' ')}"`, $top: n, $select: 'id,subject,from,receivedDateTime,bodyPreview' } }));
      return {
        ok: true,
        messages: asArray(doc['value']).slice(0, n).map((m) => {
          const r = asRecord(m);
          return { id: str(r['id'], 300), from: str(asRecord(asRecord(r['from'])['emailAddress'])['address'], 320), subject: str(r['subject'], 300), date: str(r['receivedDateTime'], 40), snippet: str(r['bodyPreview'], 300) };
        }),
      };
    },
  },
  {
    name: 'outlook.read',
    provider: 'microsoft',
    service: 'mail',
    kind: 'read',
    description: `Read one Outlook message of the asking person by the id a search answered: sender, recipients, subject, date and the text.${untrusted}`,
    input: z.strictObject({ messageId: idOf('message') }),
    async run(api, input) {
      const doc = asRecord(
        await api.json(`/me/messages/${enc(String(input['messageId']))}`, {
          query: { $select: 'id,subject,from,toRecipients,receivedDateTime,body' },
          headers: { prefer: 'outlook.body-content-type="text"' },
        }),
      );
      const body = asRecord(doc['body']);
      const content = str(body['content'], MAX_PART) ?? '';
      const cut = clip(str(body['contentType'], 20) === 'html' ? stripHtml(content) : content);
      return {
        ok: true,
        id: str(doc['id'], 300),
        from: str(asRecord(asRecord(doc['from'])['emailAddress'])['address'], 320),
        to: asArray(doc['toRecipients']).slice(0, 20).map((t) => str(asRecord(asRecord(t)['emailAddress'])['address'], 320)),
        subject: str(doc['subject'], 300),
        date: str(doc['receivedDateTime'], 40),
        text: cut.text,
        truncated: cut.truncated,
      };
    },
  },
  {
    name: 'outlook.draft',
    provider: 'microsoft',
    service: 'mail_drafts',
    kind: 'write',
    description: "Save a draft message in the asking person's Outlook. It is not sent: the person reads and sends it themselves. Needs the person's approval.",
    input: z.strictObject(draftFields),
    async run(api, input) {
      const i = input as { to: string[]; subject: string; body: string };
      const doc = asRecord(
        await api.json('/me/messages', {
          method: 'POST',
          body: { subject: i.subject, body: { contentType: 'Text', content: i.body }, toRecipients: i.to.map((address) => ({ emailAddress: { address } })) },
        }),
      );
      return { ok: true, draftId: str(doc['id'], 300), note: 'The draft is saved in the person’s Drafts folder; nothing was sent.' };
    },
  },
  {
    name: 'outlook_calendar.list_events',
    provider: 'microsoft',
    service: 'calendar',
    kind: 'read',
    description: `List events on the asking person's Outlook calendar between two times, soonest first.${untrusted}`,
    input: z.strictObject(listWindow),
    async run(api, input) {
      const w = windowOf(api, input as { from?: string; to?: string });
      const n = typeof input['limit'] === 'number' ? input['limit'] : 10;
      const doc = asRecord(
        await api.json('/me/calendarView', {
          query: { startDateTime: w.from, endDateTime: w.to, $top: n, $orderby: 'start/dateTime', $select: 'id,subject,start,end,location,attendees,webLink' },
        }),
      );
      return {
        ok: true,
        events: asArray(doc['value']).slice(0, n).map((e) => {
          const r = asRecord(e);
          return {
            id: str(r['id'], 300),
            title: str(r['subject'], 300),
            start: str(asRecord(r['start'])['dateTime'], 40),
            end: str(asRecord(r['end'])['dateTime'], 40),
            location: str(asRecord(r['location'])['displayName'], 300),
            guests: asArray(r['attendees']).length,
            link: str(r['webLink'], 500),
          };
        }),
      };
    },
  },
  {
    name: 'outlook_calendar.create_event',
    provider: 'microsoft',
    service: 'calendar_write',
    kind: 'write',
    description: "Add an event to the asking person's Outlook calendar. Guests are listed on the event; Outlook may notify them. Needs the person's approval.",
    input: z.strictObject(eventFields),
    async run(api, input) {
      const i = input as { title: string; start: string; end: string; attendees?: string[]; description?: string };
      const doc = asRecord(
        await api.json('/me/events', {
          method: 'POST',
          body: {
            subject: i.title,
            ...(i.description ? { body: { contentType: 'Text', content: i.description } } : {}),
            start: { dateTime: i.start, timeZone: 'UTC' },
            end: { dateTime: i.end, timeZone: 'UTC' },
            ...(i.attendees?.length ? { attendees: i.attendees.map((address) => ({ emailAddress: { address }, type: 'required' })) } : {}),
          },
        }),
      );
      return { ok: true, id: str(doc['id'], 300), link: str(doc['webLink'], 500) };
    },
  },
];

// ---- Notion ------------------------------------------------------------------------------------------------------------------------------------------

const richText = (v: unknown): string =>
  asArray(v)
    .map((t) => str(asRecord(t)['plain_text'], 2000) ?? '')
    .join('');

/** The title of a Notion page or database object: the one property of type `title`. */
function notionTitle(object: unknown): string | null {
  const props = asRecord(asRecord(object)['properties']);
  for (const value of Object.values(props)) {
    const p = asRecord(value);
    if (p['type'] === 'title') return richText(p['title']).slice(0, 300);
  }
  return null;
}

const NOTION_TOOLS: PersonToolDef[] = [
  {
    name: 'notion.search',
    provider: 'notion',
    service: 'notion',
    kind: 'read',
    description: `Search the Notion pages the asking person shared with the connection, by title.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const doc = asRecord(await api.json('/search', { method: 'POST', body: { query: q, page_size: n, filter: { property: 'object', value: 'page' } } }));
      return {
        ok: true,
        pages: asArray(doc['results']).slice(0, n).map((p) => {
          const r = asRecord(p);
          return { id: str(r['id'], 100), title: notionTitle(r), url: str(r['url'], 500), edited: str(r['last_edited_time'], 40) };
        }),
      };
    },
  },
  {
    name: 'notion.read_page',
    provider: 'notion',
    service: 'notion',
    kind: 'read',
    description: `Read one Notion page the asking person shared with the connection, by the id a search answered: its title and the text of its blocks.${untrusted}`,
    input: z.strictObject({ pageId: idOf('page') }),
    async run(api, input) {
      const id = enc(String(input['pageId']));
      const page = asRecord(await api.json(`/pages/${id}`));
      const blocks = asRecord(await api.json(`/blocks/${id}/children`, { query: { page_size: 100 } }));
      const lines: string[] = [];
      for (const b of asArray(blocks['results']).slice(0, 100)) {
        const block = asRecord(b);
        const type = str(block['type'], 40) ?? '';
        const text = richText(asRecord(block[type])['rich_text']);
        if (text === '') continue;
        lines.push(type.startsWith('heading') ? `${'#'.repeat(Number(type.slice(-1)) || 1)} ${text}` : type === 'bulleted_list_item' ? `- ${text}` : text);
      }
      const cut = clip(lines.join('\n'));
      return { ok: true, id: str(page['id'], 100), title: notionTitle(page), url: str(page['url'], 500), text: cut.text, truncated: cut.truncated };
    },
  },
  {
    name: 'notion.create_page',
    provider: 'notion',
    service: 'notion',
    kind: 'write',
    description: "Add a new page with a title and some text under a Notion page the asking person shared with the connection. Needs the person's approval.",
    input: z.strictObject({ parentPageId: idOf('page to add it under'), title, text: z.string().max(20_000).optional() }),
    async run(api, input) {
      const i = input as { parentPageId: string; title: string; text?: string };
      const paragraphs = (i.text ?? '')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p !== '')
        .slice(0, 50)
        .map((p) => ({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: p.slice(0, 2000) } }] } }));
      const doc = asRecord(
        await api.json('/pages', {
          method: 'POST',
          body: { parent: { page_id: i.parentPageId }, properties: { title: { title: [{ type: 'text', text: { content: i.title } }] } }, children: paragraphs },
        }),
      );
      return { ok: true, id: str(doc['id'], 100), url: str(doc['url'], 500) };
    },
  },
];

export const PERSON_TOOL_DEFS: readonly PersonToolDef[] = [...GOOGLE_TOOLS, ...MICROSOFT_TOOLS, ...NOTION_TOOLS];

const BY_NAME: ReadonlyMap<string, PersonToolDef> = new Map(PERSON_TOOL_DEFS.map((t) => [t.name, t]));
export const personToolDef = (name: string): PersonToolDef | undefined => BY_NAME.get(name);

/** What a model is shown for each person tool; the same shape the team connections' tools have. */
export const PERSON_TOOLS: readonly ToolSourceTool[] = PERSON_TOOL_DEFS.map((t) => {
  const schema = z.toJSONSchema(t.input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete schema['$schema'];
  return { name: t.name, description: t.description, inputSchema: schema, kind: t.kind };
});
