import type { RemoteDocument } from '@manythreads/sdk';
import type { ConnectorRoot } from '@manythreads/shared';
import { safeId, type AdapterCtx, type DocAdapter } from './adapter.ts';
import { DocError, MAX_DOCUMENT_BYTES, accessAnswer, arr, decodeState, encodeState, enc, isStrOrNull, nameOf, rec, str, unreadableAccess, unreadableOrThrow } from './http.ts';
import { notionToMarkdown, type NotionBlock } from './markdown.ts';

// Notion (PLAN Bundle D, P16-08, decisions D13 and D14). Notion offers no change feed, so a pass asks for the pages the person shared with the connection, NEWEST EDIT FIRST
// (`search` sorted by `last_edited_time`, descending), and stops at the first page not edited since the last pass.
//   * State `{hi, after, c}`: `hi` is the newest edit seen in THIS pass (the first page's first row), `after` the mark of the pass before, `c` Notion's own page cursor.
//     When the pass ends, the cursor is `{after: hi - slack}`. Notion rounds edit times to the minute, so the mark is held back two minutes: a page edited in the same minute
//     as the pass is listed once more (the knowledge side skips a page whose version it already has) rather than missed.
//   * Removed pages: a page that Notion itself says is in the trash is reported removed. Notion has no feed of deletions or un-sharing, so a page that simply stops being
//     returned is not noticed here; the knowledge side drops it when the source is read in full again.
//   * A root is "everything shared with the connection" or one database (a page whose parent is that database).
//   * `access`: the API does not say who in the workspace may open a page, so a page is "not everyone" unless it is published to the web (`public_url`): groups true.

const WORKSPACE = 'workspace';
const SLACK_MS = 2 * 60 * 1000;
const MAX_BLOCK_CALLS = 40;
const MAX_BLOCKS = 5000;
const MAX_DEPTH = 3;

interface State {
  k: 's';
  hi: string | null;
  after: string | null;
  c: string | null;
}
const isState = (v: Record<string, unknown>): v is State & Record<string, unknown> =>
  v['k'] === 's' && isStrOrNull(v['hi'], 40) && isStrOrNull(v['after'], 40) && isStrOrNull(v['c'], 500);

const sameId = (a: string, b: string): boolean => a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();

/** The title of a page: its one `title` property, as plain text. */
export function notionTitle(page: Record<string, unknown>, fallback: string): string {
  for (const prop of Object.values(rec(page['properties']))) {
    const p = rec(prop);
    if (p['type'] === 'title') {
      const text = arr(p['title'])
        .map((t) => str(rec(t)['plain_text'], 500) ?? '')
        .join('');
      if (text.trim() !== '') return nameOf(text, fallback);
    }
  }
  return fallback;
}

function isInTrash(page: Record<string, unknown>): boolean {
  return page['archived'] === true || page['in_trash'] === true;
}

export const notion: DocAdapter = {
  async listRoots(ctx) {
    const roots: ConnectorRoot[] = [{ id: WORKSPACE, name: 'Everything shared with the connection', kind: 'workspace', parent: null }];
    try {
      const found = rec(await ctx.http.json('/search', { method: 'POST', body: { filter: { property: 'object', value: 'database' }, page_size: 100 } }));
      for (const raw of arr(found['results'])) {
        const r = rec(raw);
        const id = str(r['id'], 100);
        if (r['object'] !== 'database' || !id || !safeId(id)) continue;
        const title = arr(r['title'])
          .map((t) => str(rec(t)['plain_text'], 300) ?? '')
          .join('');
        roots.push({ id, name: nameOf(title, 'Database'), kind: 'database', parent: null });
      }
    } catch (err) {
      if (!(err instanceof DocError) || err.code === 'not_connected') throw err;
    }
    return roots.slice(0, 200);
  },

  async listChanges(ctx, { root, cursor }) {
    if (root !== WORKSPACE && !safeId(root)) throw new DocError('not_found', 'That database is not one this reader can open.');
    const state: State = decodeState<State>(cursor, isState) ?? { k: 's', hi: null, after: null, c: null };
    const answer = rec(
      await ctx.http.json('/search', {
        method: 'POST',
        body: {
          filter: { property: 'object', value: 'page' },
          sort: { direction: 'descending', timestamp: 'last_edited_time' },
          page_size: 50,
          ...(state.c ? { start_cursor: state.c } : {}),
        },
      }),
    );
    const results = arr(answer['results']);
    let hi = state.hi;
    let reachedOld = false;
    const items: RemoteDocument[] = [];
    for (const raw of results) {
      const page = rec(raw);
      if (page['object'] !== undefined && page['object'] !== 'page') continue;
      const id = str(page['id'], 100);
      const edited = str(page['last_edited_time'], 40);
      if (!id || !safeId(id) || !edited) continue;
      if (hi === null || edited > hi) hi = edited;
      // newest first: the first page not edited since the last pass ends this pass
      if (state.after !== null && edited <= state.after) {
        reachedOld = true;
        break;
      }
      if (root !== WORKSPACE) {
        const parent = rec(page['parent']);
        const db = str(parent['database_id'], 100);
        if (!db || !sameId(db, root)) continue;
      }
      const name = notionTitle(page, 'Untitled');
      items.push({ remoteId: id, name, kind: 'md', version: edited, url: str(page['url'], 1000), removed: isInTrash(page) });
    }
    const nextCursor = str(answer['next_cursor'], 500);
    const more = answer['has_more'] === true && nextCursor !== null && !reachedOld;
    if (more) {
      const resume = encodeState({ k: 's', hi, after: state.after, c: nextCursor } satisfies State);
      return { items, next: resume, cursor: resume };
    }
    const mark = hi === null ? state.after : new Date(Math.min(Date.parse(hi), ctx.now().getTime() - SLACK_MS)).toISOString();
    const done = encodeState({ k: 's', hi: null, after: Number.isNaN(Date.parse(mark ?? '')) ? state.after : mark, c: null } satisfies State);
    return { items, next: null, cursor: done };
  },

  async fetch(ctx, remoteId) {
    if (!safeId(remoteId)) throw new DocError('not_found', 'That page is not one this reader can open.');
    const page = rec(await ctx.http.json(`/pages/${enc(remoteId)}`, { doc: true }));
    if (isInTrash(page)) throw new DocError('not_found', 'That page is in the trash.');
    const blocks = await readBlocks(ctx, remoteId, 0, { calls: 0, blocks: 0 });
    const md = notionToMarkdown(notionTitle(page, 'Untitled'), blocks);
    const bytes = Buffer.from(md, 'utf8');
    return { bytes: new Uint8Array(bytes.subarray(0, MAX_DOCUMENT_BYTES)), kind: 'md' };
  },

  async access(ctx, remoteId) {
    if (!safeId(remoteId)) return unreadableAccess();
    try {
      const page = rec(await ctx.http.json(`/pages/${enc(remoteId)}`, { doc: true }));
      // published to the web: anyone. Otherwise the API does not say who in the workspace may open it, which is "not everyone".
      return accessAnswer({ anyone: str(page['public_url'], 2000) !== null, domains: [], users: [], groups: str(page['public_url'], 2000) === null });
    } catch (err) {
      return unreadableOrThrow(err);
    }
  },
};

/** The blocks under `id`, with the children of a block that has some read to a depth of three. A page with more than the budget of calls or blocks is cut there. */
async function readBlocks(ctx: AdapterCtx, id: string, depth: number, budget: { calls: number; blocks: number }): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let startCursor: string | null = null;
  for (;;) {
    if (budget.calls >= MAX_BLOCK_CALLS || budget.blocks >= MAX_BLOCKS) break;
    budget.calls++;
    const answer = rec(await ctx.http.json(`/blocks/${enc(id)}/children`, { query: { page_size: 100, ...(startCursor ? { start_cursor: startCursor } : {}) }, doc: true }));
    for (const raw of arr(answer['results'])) {
      if (budget.blocks >= MAX_BLOCKS) break;
      budget.blocks++;
      const block = rec(raw) as NotionBlock;
      const blockId = str(block['id'], 100);
      if (block.has_children === true && blockId && safeId(blockId) && depth < MAX_DEPTH) block.children = await readBlocks(ctx, blockId, depth + 1, budget);
      out.push(block);
    }
    startCursor = answer['has_more'] === true ? str(answer['next_cursor'], 500) : null;
    if (!startCursor) break;
  }
  return out;
}
