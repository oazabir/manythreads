import type { PanelEntry } from '../kernel/panel';

/*
 * The right-panel entry of a search: `search:<query>`, or `search:in:<channel id> <query>` when it is limited to one conversation
 * (the DM screen's own search box). Kept in one place so the boxes that open it and the panel that reads it agree.
 */
export const SEARCH_PANEL = 'search';
const SCOPED = /^in:([0-9a-f-]{36}) (.*)$/s;

export type SearchSpec = { q: string; channelId: string | null };

export function searchEntry(q: string, channelId: string | null = null): PanelEntry {
  const text = q.trim().replace(/\s+/g, ' ').slice(0, 200);
  return { type: SEARCH_PANEL, id: channelId ? `in:${channelId} ${text}` : text };
}

export function parseSearchEntry(id: string): SearchSpec {
  const m = SCOPED.exec(id);
  return m ? { q: m[2] ?? '', channelId: m[1] ?? null } : { q: id, channelId: null };
}
