import { z } from 'zod';
import type { ProviderApi } from './oauth/api.ts';
import { address, asArray, asRecord, cardOf, clip, draftFields, driveQuote, enc, eventFields, freeBusyInput, freeGaps, gmailText, headerOf, idOf, limit, listWindow, mergeBusy, MESSAGE_ID, names, oneLine, Q, query, rfc822, str, untrusted, windowOf, type PersonToolDef, type Span } from './person-kit.ts';

export { freeGaps, mergeBusy, type Span };

// ---- shared by the Gmail and Calendar tools -----------------------------------------------------------------------------------------------------------------

const labelIdsOf = (doc: unknown): string[] =>
  asArray(asRecord(doc)['labelIds'])
    .slice(0, 30)
    .flatMap((l) => {
      const id = str(l, 100);
      return id === null ? [] : [id];
    });

/**
 * Labels the tools will not add: they hide or throw away mail (the bin and spam) or claim a mail was sent or is a draft. Taking a mail out of the Inbox or marking it read is
 * allowed; nothing here deletes.
 */
const LABELS_NOT_TO_ADD: ReadonlySet<string> = new Set(['TRASH', 'SPAM', 'SENT', 'DRAFT']);
/** A label the tools will not take off either: a mail does not stop being sent or a draft. */
const LABELS_NOT_TO_REMOVE: ReadonlySet<string> = new Set(['SENT', 'DRAFT']);

interface MailLabel {
  id: string;
  name: string;
  type: string;
}
async function mailLabels(api: ProviderApi): Promise<MailLabel[]> {
  const doc = asRecord(await api.json('/gmail/v1/users/me/labels'));
  return asArray(doc['labels'])
    .slice(0, 500)
    .flatMap((l) => {
      const r = asRecord(l);
      const id = str(r['id'], 100);
      const name = str(r['name'], 225);
      return id && name ? [{ id, name, type: str(r['type'], 20) ?? 'user' }] : [];
    });
}
/** A label named by the model, found among the person's own: by its id or by its name in any case. */
const findLabel = (all: readonly MailLabel[], wanted: string): MailLabel | undefined => all.find((l) => l.id === wanted) ?? all.find((l) => l.name.toLowerCase() === wanted.toLowerCase());

const labelWord = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[^\r\n]+$/, 'one line')
  .describe('A label by its name (Invoices) or a built-in one (INBOX, UNREAD, STARRED, IMPORTANT).');
const sendFields = {
  to: z.array(address).min(1).max(20),
  cc: z.array(address).max(20).optional(),
  subject: draftFields.subject,
  body: draftFields.body,
  replyToMessageId: idOf('message this answers').describe('Set it to answer a message: the reply stays in that message’s conversation. Needs the Gmail (read) permission too.').optional(),
};

// ---- free and busy and the event patch ----------------------------------------------------------------------------------------------------------------------

const eventPatch = z
  .strictObject({
    eventId: idOf('event'),
    title: eventFields.title.optional(),
    start: eventFields.start.optional(),
    end: eventFields.end.optional(),
    attendees: z.array(address).max(20).describe('The whole list of guests after the change (it replaces the list). Nobody is notified by the tool itself.').optional(),
    description: z.string().max(4000).optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== 'eventId'), { message: 'say what to change as well (title, start, end, attendees or description)', path: ['eventId'] });

// ---- Google ------------------------------------------------------------------------------------------------------------------------------------------

export const GOOGLE_TOOLS: PersonToolDef[] = [
  {
    name: 'google_drive.search',
    provider: 'google',
    service: 'drive',
    kind: 'read',
    description: `Search the asking person's Google Drive for files whose name or text holds the words you give.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const doc = asRecord(
        await api.json('/drive/v3/files', {
          query: { q: `fullText contains '${driveQuote(q)}' and trashed = false`, pageSize: n, fields: 'files(id,name,mimeType,modifiedTime,webViewLink)', orderBy: 'modifiedTime desc' },
        }),
      );
      return {
        ok: true,
        files: asArray(doc['files']).slice(0, n).map((f) => {
          const r = asRecord(f);
          return { id: str(r['id'], 200), name: str(r['name'], 300), type: str(r['mimeType'], 100), modified: str(r['modifiedTime'], 40), link: str(r['webViewLink'], 500) };
        }),
      };
    },
  },
  {
    name: 'google_drive.read',
    provider: 'google',
    service: 'drive',
    kind: 'read',
    description: `Read the text of one file of the asking person's Google Drive (a document, a sheet as CSV, a slide deck's text, or a plain text file) by the id a search answered.${untrusted}`,
    input: z.strictObject({ fileId: idOf('file') }),
    async run(api, input) {
      const id = enc(String(input['fileId']));
      const meta = asRecord(await api.json(`/drive/v3/files/${id}`, { query: { fields: 'id,name,mimeType,modifiedTime,size,webViewLink' } }));
      const mime = str(meta['mimeType'], 120) ?? '';
      const exportAs: Record<string, string> = {
        'application/vnd.google-apps.document': 'text/plain',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
        'application/vnd.google-apps.presentation': 'text/plain',
      };
      let raw: { text: string; truncated: boolean };
      if (exportAs[mime]) raw = await api.text(`/drive/v3/files/${id}/export`, { query: { mimeType: exportAs[mime] } });
      else if (mime.startsWith('text/') || mime === 'application/json') raw = await api.text(`/drive/v3/files/${id}`, { query: { alt: 'media' } });
      else return { ok: false, code: 'not_readable', message: 'That file is not text and cannot be read here. Its link is in the search result.' };
      const cut = clip(raw.text);
      return { ok: true, id: str(meta['id'], 200), name: str(meta['name'], 300), type: mime, modified: str(meta['modifiedTime'], 40), text: cut.text, truncated: cut.truncated || raw.truncated };
    },
  },
  {
    name: 'gmail.search',
    provider: 'google',
    service: 'gmail',
    kind: 'read',
    description: `Search the asking person's Gmail with Gmail's search words; answers the sender, subject, date and a snippet of each match.${untrusted}`,
    input: z.strictObject({ query, limit }),
    async run(api, input) {
      const { query: q, limit: n } = Q(input);
      const found = asRecord(await api.json('/gmail/v1/users/me/messages', { query: { q, maxResults: Math.min(n, 10) } }));
      const messages: unknown[] = [];
      for (const m of asArray(found['messages']).slice(0, Math.min(n, 10))) {
        const id = str(asRecord(m)['id'], 100);
        if (!id) continue;
        const doc = asRecord(await api.json(`/gmail/v1/users/me/messages/${enc(id)}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] } }));
        const headers = asRecord(doc['payload'])['headers'];
        messages.push({ id, threadId: str(doc['threadId'], 100), from: headerOf(headers, 'from'), subject: headerOf(headers, 'subject'), date: headerOf(headers, 'date'), labels: labelIdsOf(doc), snippet: str(doc['snippet'], 300) });
      }
      return { ok: true, messages };
    },
  },
  {
    name: 'gmail.read',
    provider: 'google',
    service: 'gmail',
    kind: 'read',
    description: `Read one Gmail message of the asking person by the id a search answered: sender, recipients, subject, date and the text.${untrusted}`,
    input: z.strictObject({ messageId: idOf('message') }),
    async run(api, input) {
      const doc = asRecord(await api.json(`/gmail/v1/users/me/messages/${enc(String(input['messageId']))}`, { query: { format: 'full' } }));
      const payload = asRecord(doc['payload']);
      const cut = clip(gmailText(payload));
      return {
        ok: true,
        id: str(doc['id'], 100),
        threadId: str(doc['threadId'], 100),
        labels: labelIdsOf(doc),
        from: headerOf(payload['headers'], 'from'),
        to: headerOf(payload['headers'], 'to'),
        subject: headerOf(payload['headers'], 'subject'),
        date: headerOf(payload['headers'], 'date'),
        text: cut.text,
        truncated: cut.truncated,
      };
    },
  },
  {
    name: 'gmail.draft',
    provider: 'google',
    service: 'gmail_drafts',
    kind: 'write',
    description: "Save a draft message in the asking person's Gmail. It is not sent: the person reads and sends it themselves. Needs a lead's approval.",
    input: z.strictObject(draftFields),
    card: (i) => cardOf(`Save a draft to ${names(i['to']).join(', ')}: ${oneLine(i['subject'])}`, { to: names(i['to']), subject: oneLine(i['subject'], 300), body: String(i['body'] ?? '').slice(0, 1500) }),
    async run(api, input) {
      const raw = Buffer.from(rfc822(input as { to: string[]; subject: string; body: string }), 'utf8').toString('base64url');
      const doc = asRecord(await api.json('/gmail/v1/users/me/drafts', { method: 'POST', body: { message: { raw } } }));
      return { ok: true, draftId: str(doc['id'], 100), note: 'The draft is saved in the person’s Drafts folder; nothing was sent.' };
    },
  },
  {
    name: 'google_calendar.list_events',
    provider: 'google',
    service: 'calendar',
    kind: 'read',
    description: `List events on the asking person's primary Google Calendar between two times, soonest first.${untrusted}`,
    input: z.strictObject(listWindow),
    async run(api, input) {
      const w = windowOf(api, input as { from?: string; to?: string });
      const n = typeof input['limit'] === 'number' ? input['limit'] : 10;
      const doc = asRecord(
        await api.json('/calendar/v3/calendars/primary/events', { query: { timeMin: w.from, timeMax: w.to, maxResults: n, singleEvents: 'true', orderBy: 'startTime' } }),
      );
      return {
        ok: true,
        events: asArray(doc['items']).slice(0, n).map((e) => {
          const r = asRecord(e);
          return {
            id: str(r['id'], 200),
            title: str(r['summary'], 300),
            start: str(asRecord(r['start'])['dateTime'], 40) ?? str(asRecord(r['start'])['date'], 40),
            end: str(asRecord(r['end'])['dateTime'], 40) ?? str(asRecord(r['end'])['date'], 40),
            location: str(r['location'], 300),
            guests: asArray(r['attendees']).length,
            link: str(r['htmlLink'], 500),
          };
        }),
      };
    },
  },
  {
    name: 'google_calendar.create_event',
    provider: 'google',
    service: 'calendar_write',
    kind: 'write',
    description: "Add an event to the asking person's primary Google Calendar. Guests are listed on the event but are not emailed by this tool. Needs a lead's approval.",
    input: z.strictObject(eventFields),
    card: (i) => cardOf(`Add “${oneLine(i['title'], 80)}” to the calendar on ${oneLine(i['start'], 30)}`, { title: oneLine(i['title'], 300), start: i['start'], end: i['end'], guests: names(i['attendees']), description: oneLine(i['description'], 500) }),
    async run(api, input) {
      const i = input as { title: string; start: string; end: string; attendees?: string[]; description?: string };
      const doc = asRecord(
        await api.json('/calendar/v3/calendars/primary/events', {
          method: 'POST',
          query: { sendUpdates: 'none' },
          body: {
            summary: i.title,
            ...(i.description ? { description: i.description } : {}),
            start: { dateTime: i.start },
            end: { dateTime: i.end },
            ...(i.attendees?.length ? { attendees: i.attendees.map((email) => ({ email })) } : {}),
          },
        }),
      );
      return { ok: true, id: str(doc['id'], 200), link: str(doc['htmlLink'], 500) };
    },
  },
  {
    name: 'gmail.list_labels',
    provider: 'google',
    service: 'gmail',
    kind: 'read',
    description: `List the labels of the asking person's Gmail (their own and the built-in ones), with the id of each. Use a label's name or id in a search or when labelling.${untrusted}`,
    input: z.strictObject({}),
    async run(api) {
      const all = await mailLabels(api);
      return { ok: true, labels: all.slice(0, 200).map((l) => ({ id: l.id, name: l.name, type: l.type === 'system' ? 'built-in' : 'own' })) };
    },
  },
  {
    name: 'gmail.label',
    provider: 'google',
    service: 'gmail_labels',
    kind: 'write',
    description:
      "Put labels on one Gmail message of the asking person, or take labels off it (taking off INBOX files it away, taking off UNREAD marks it read). Labels must already exist; it never creates one, bins a message or marks it as spam. Needs a lead's approval.",
    input: z
      .strictObject({
        messageId: idOf('message'),
        add: z.array(labelWord).max(5).optional(),
        remove: z.array(labelWord).max(5).optional(),
      })
      .refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: 'name at least one label to add or remove', path: ['add'] }),
    card: (i) => cardOf(`Label a message: add ${names(i['add']).join(', ') || 'nothing'}, remove ${names(i['remove']).join(', ') || 'nothing'}`, { messageId: i['messageId'], add: names(i['add']), remove: names(i['remove']) }),
    async run(api, input) {
      const i = input as { messageId: string; add?: string[]; remove?: string[] };
      const all = await mailLabels(api);
      const pick = (words: string[] | undefined, blocked: ReadonlySet<string>): { ids: string[] } | { problem: { ok: false; code: string; message: string } } => {
        const ids: string[] = [];
        for (const word of words ?? []) {
          const label = findLabel(all, word);
          if (!label) {
            return { problem: { ok: false, code: 'unknown_label', message: `There is no label “${word.slice(0, 100)}” in this mailbox. Call gmail.list_labels to see the labels that exist.` } };
          }
          if (blocked.has(label.id)) return { problem: { ok: false, code: 'label_not_allowed', message: `The label ${label.id} cannot be changed with this tool.` } };
          if (!ids.includes(label.id)) ids.push(label.id);
        }
        return { ids };
      };
      const add = pick(i.add, LABELS_NOT_TO_ADD);
      if ('problem' in add) return add.problem;
      const remove = pick(i.remove, LABELS_NOT_TO_REMOVE);
      if ('problem' in remove) return remove.problem;
      if (add.ids.some((id) => remove.ids.includes(id))) return { ok: false, code: 'invalid', message: 'The same label cannot be added and removed in one call.' };
      const doc = await api.json(`/gmail/v1/users/me/messages/${enc(i.messageId)}/modify`, { method: 'POST', body: { addLabelIds: add.ids, removeLabelIds: remove.ids } });
      return { ok: true, id: str(asRecord(doc)['id'], 100) ?? i.messageId, labels: labelIdsOf(doc) };
    },
  },
  {
    name: 'gmail.send',
    provider: 'google',
    service: 'gmail_send',
    kind: 'write',
    description:
      "Send a message from the asking person's Gmail, to the addresses you give, in plain text. It really is sent, so a team lead reads the recipients and the text and approves each one first. Set replyToMessageId to answer a message in its conversation. Needs a lead's approval.",
    input: z.strictObject(sendFields).refine((v) => v.to.length + (v.cc?.length ?? 0) <= 25, { message: 'at most 25 recipients in all', path: ['to'] }),
    card: (i) =>
      cardOf(`Send an email to ${names(i['to']).join(', ')}: ${oneLine(i['subject'])}`, {
        to: names(i['to']),
        cc: names(i['cc']),
        subject: oneLine(i['subject'], 300),
        body: String(i['body'] ?? '').slice(0, 1500),
        ...(typeof i['replyToMessageId'] === 'string' ? { inReplyTo: i['replyToMessageId'] } : {}),
      }),
    async run(api, input) {
      const i = input as { to: string[]; cc?: string[]; subject: string; body: string; replyToMessageId?: string };
      let inReplyTo: string | undefined;
      let threadId: string | null = null;
      if (i.replyToMessageId) {
        const original = asRecord(await api.json(`/gmail/v1/users/me/messages/${enc(i.replyToMessageId)}`, { query: { format: 'metadata', metadataHeaders: ['Message-ID'] } }));
        const messageId = headerOf(asRecord(original['payload'])['headers'], 'message-id');
        if (messageId && MESSAGE_ID.test(messageId)) inReplyTo = messageId;
        threadId = str(original['threadId'], 100);
      }
      const raw = Buffer.from(rfc822({ to: i.to, ...(i.cc ? { cc: i.cc } : {}), subject: i.subject, body: i.body, ...(inReplyTo ? { inReplyTo } : {}) }), 'utf8').toString('base64url');
      const doc = asRecord(await api.json('/gmail/v1/users/me/messages/send', { method: 'POST', body: { raw, ...(threadId ? { threadId } : {}) } }));
      return { ok: true, id: str(doc['id'], 100), threadId: str(doc['threadId'], 100), note: 'The message was sent.' };
    },
  },
  {
    name: 'google_calendar.free_busy',
    provider: 'google',
    service: 'calendar_free_busy',
    kind: 'read',
    description: `Show when the asking person, and the people whose addresses you give, are busy between two times (never why), and, if asked, the stretches in which everyone is free. A calendar its owner has not shared shows as not visible.${untrusted}`,
    input: freeBusyInput,
    async run(api, input) {
      const i = input as { from: string; to: string; people?: string[]; minMinutes?: number };
      const window = { start: new Date(i.from).toISOString(), end: new Date(i.to).toISOString() };
      const people = [...new Set((i.people ?? []).map((p) => p.toLowerCase()))];
      const ids = ['primary', ...people];
      const doc = asRecord(await api.json('/calendar/v3/freeBusy', { method: 'POST', body: { timeMin: window.start, timeMax: window.end, items: ids.map((id) => ({ id })) } }));
      const answered = new Map(Object.entries(asRecord(doc['calendars'])));
      const everyone: Span[] = [];
      let all = true;
      const calendars = ids.map((id) => {
        const entry = asRecord(answered.get(id));
        const visible = answered.has(id) && asArray(entry['errors']).length === 0;
        const busy = visible ? mergeBusy(asArray(entry['busy']).slice(0, 500).map((b) => ({ start: str(asRecord(b)['start'], 40) ?? '', end: str(asRecord(b)['end'], 40) ?? '' }))) : [];
        if (!visible) all = false;
        everyone.push(...busy);
        return { who: id === 'primary' ? 'you' : id, visible, busy };
      });
      return { ok: true, window, calendars, ...(i.minMinutes ? { free: freeGaps(everyone, window, i.minMinutes), freeCoversEveryone: all } : {}) };
    },
  },
  {
    name: 'google_calendar.update_event',
    provider: 'google',
    service: 'calendar_write',
    kind: 'write',
    description:
      "Change an event on the asking person's primary Google Calendar by the id a listing answered: its title, times, description or the whole list of guests. Only what you give is changed. Guests are not emailed by this tool. Needs a lead's approval.",
    input: eventPatch,
    card: (i) => {
      const fields = ['title', 'start', 'end', 'attendees', 'description'].filter((k) => i[k] !== undefined);
      return cardOf(`Change event ${oneLine(i['eventId'], 40)}: ${fields.join(', ')}`, {
        eventId: i['eventId'],
        ...(i['title'] !== undefined ? { title: oneLine(i['title'], 300) } : {}),
        ...(i['start'] !== undefined ? { start: i['start'] } : {}),
        ...(i['end'] !== undefined ? { end: i['end'] } : {}),
        ...(i['attendees'] !== undefined ? { guests: names(i['attendees']) } : {}),
        ...(i['description'] !== undefined ? { description: oneLine(i['description'], 500) } : {}),
      });
    },
    async run(api, input) {
      const i = input as { eventId: string; title?: string; start?: string; end?: string; attendees?: string[]; description?: string };
      const doc = asRecord(
        await api.json(`/calendar/v3/calendars/primary/events/${enc(i.eventId)}`, {
          method: 'PATCH',
          query: { sendUpdates: 'none' },
          body: {
            ...(i.title !== undefined ? { summary: i.title } : {}),
            ...(i.description !== undefined ? { description: i.description } : {}),
            ...(i.start !== undefined ? { start: { dateTime: i.start } } : {}),
            ...(i.end !== undefined ? { end: { dateTime: i.end } } : {}),
            ...(i.attendees !== undefined ? { attendees: i.attendees.map((email) => ({ email })) } : {}),
          },
        }),
      );
      return { ok: true, id: str(doc['id'], 200), link: str(doc['htmlLink'], 500) };
    },
  },
];
