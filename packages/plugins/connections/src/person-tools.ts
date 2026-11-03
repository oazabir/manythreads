import type { ToolSourceTool } from '@manythreads/sdk';
import { z } from 'zod';
import { CRM_TOOLS } from './crm-tools.ts';
import { GOOGLE_TOOLS } from './google-tools.ts';
import { MICROSOFT_TOOLS } from './microsoft-tools.ts';
import { TRACKER_TOOLS } from './tracker-tools.ts';
import { asArray, asRecord, clip, enc, idOf, limit, Q, query, str, title, untrusted, type PersonToolDef } from './person-kit.ts';
import { SUPPORT_TOOLS } from './support-tools.ts';

// The tools of a person's Notion connection (PLAN P8-02), and the list of every person tool. The shared helpers are in person-kit.ts, Google's tools in google-tools.ts, Microsoft 365's in microsoft-tools.ts, Zendesk's and Intercom's in support-tools.ts and HubSpot's and Salesforce's in crm-tools.ts.

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

export const PERSON_TOOL_DEFS: readonly PersonToolDef[] = [...GOOGLE_TOOLS, ...MICROSOFT_TOOLS, ...NOTION_TOOLS, ...TRACKER_TOOLS, ...SUPPORT_TOOLS, ...CRM_TOOLS];

const BY_NAME: ReadonlyMap<string, PersonToolDef> = new Map(PERSON_TOOL_DEFS.map((t) => [t.name, t]));
export const personToolDef = (name: string): PersonToolDef | undefined => BY_NAME.get(name);

/** What a model is shown for each person tool; the same shape the team connections' tools have. */
export const PERSON_TOOLS: readonly ToolSourceTool[] = PERSON_TOOL_DEFS.map((t) => {
  const schema = z.toJSONSchema(t.input, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete schema['$schema'];
  return { name: t.name, description: t.description, inputSchema: schema, kind: t.kind };
});
