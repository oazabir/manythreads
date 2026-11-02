import { beforeEach, describe, expect, it } from 'vitest';
import { InboxItemChangedPush, WS_INBOX_ITEM_CHANGED, type InboxItem } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { createMockTransport } from '../src/api/mock';
import {
  InboxListWithAddress,
  createInboxNote,
  discardInboxItem,
  fetchConcepts,
  fetchInboxItem,
  fetchInboxItems,
  releaseInboxItem,
  retryInboxItem,
  sendToMemory,
} from '../src/screens/memory/inboxApi';
import { parseInboxPush } from '../src/screens/memory/inboxLive';
import {
  FILTERS,
  conceptLink,
  conceptName,
  countsByFilter,
  dropProblem,
  emailAddressOf,
  filedConcepts,
  filedReference,
  holdSentence,
  inFilter,
  inboxLink,
  isProcessing,
  itemActions,
  itemLook,
  itemSentence,
  noticeCopy,
  sizeLabel,
} from '../src/screens/memory/inboxWords';

/*
 * What the Memory screen's Inbox tab sends and says. The first part checks each call reaches the route the memory-inbox plugin mounts (written out, not derived
 * from the route objects the client uses). The second runs the same calls against the mock transport the screen uses offline: its answers must parse with the
 * shared schemas and refuse what the server refuses. The third reads the plain words.
 */

const ITEM = '00000000-0000-7000-8000-0000000d0001';
const CHANNEL = '00000000-0000-7000-8000-0000000c0001';
const MESSAGE = '00000000-0000-7000-8000-0000000e0001';

describe('the inbox calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };
  const cases: Array<{ name: string; run: () => Promise<unknown>; method: string; url: string; body?: unknown }> = [
    { name: 'lists the items', run: () => fetchInboxItems('engineering'), method: 'GET', url: '/api/teams/engineering/inbox/items' },
    { name: 'lists one state', run: () => fetchInboxItems('engineering', 'held'), method: 'GET', url: '/api/teams/engineering/inbox/items' },
    { name: 'reads one item', run: () => fetchInboxItem('engineering', ITEM), method: 'GET', url: `/api/teams/engineering/inbox/items/${ITEM}` },
    { name: 'adds a note', run: () => createInboxNote('engineering', { title: 'Standup', text: 'We ship on Friday.', teamOnly: true }), method: 'POST', url: '/api/teams/engineering/inbox/notes', body: { title: 'Standup', text: 'We ship on Friday.', teamOnly: true } },
    { name: 'releases', run: () => releaseInboxItem('engineering', ITEM), method: 'POST', url: `/api/teams/engineering/inbox/items/${ITEM}/release` },
    { name: 'discards', run: () => discardInboxItem('engineering', ITEM), method: 'POST', url: `/api/teams/engineering/inbox/items/${ITEM}/discard` },
    { name: 'retries', run: () => retryInboxItem('engineering', ITEM), method: 'POST', url: `/api/teams/engineering/inbox/items/${ITEM}/retry` },
    {
      name: 'sends a message to memory',
      run: () => sendToMemory(CHANNEL, MESSAGE, { confirmPrivate: true, teamOnly: false, thread: true }),
      method: 'POST',
      url: `/api/channels/${CHANNEL}/messages/${MESSAGE}/send-to-memory`,
      body: { confirmPrivate: true, teamOnly: false, thread: true },
    },
    { name: 'lists the concepts', run: () => fetchConcepts('engineering'), method: 'GET', url: '/api/teams/engineering/memory/concepts' },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const req = await send(c.run);
      expect(req.method).toBe(c.method);
      expect(req.url.split('?')[0]).toBe(c.url);
      if (c.body !== undefined) expect(JSON.parse(req.body ?? 'null')).toEqual(c.body);
    });
  }

  it('asks for the newest two hundred, and for one state when told', async () => {
    expect((await send(() => fetchInboxItems('engineering'))).url).toContain('limit=200');
    expect((await send(() => fetchInboxItems('engineering', 'held'))).url).toContain('state=held');
  });

  it('refuses a note the schema does not know before it leaves the browser', async () => {
    await expect(createInboxNote('engineering', { text: '', teamOnly: false })).rejects.toThrow();
    await expect(createInboxNote('engineering', { text: 'x', teamOnly: false, extra: 1 } as never)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('the mock answers as the plugin does', () => {
  const as = (who: string) => setTransport(createMockTransport({ latencyMs: 0, as: who }));
  const byName = (items: readonly InboxItem[], name: string): InboxItem => {
    const found = items.find((i) => i.name === name);
    if (!found) throw new Error(`no item called ${name}`);
    return found;
  };

  it('a team member reads the queue: one drop in each place, and the email address when the team has one', async () => {
    as('nadia');
    const list = await fetchInboxItems('engineering');
    expect(list.canManage).toBe(false);
    expect(list.emailAddress).toBe('engineering@inbox.kahf.example');
    expect(list.items.map((i) => i.state).sort()).toEqual(['failed', 'filed', 'filing', 'held', 'needs_review']);
    const counts = countsByFilter(list.items);
    expect(counts).toEqual({ all: 5, processing: 1, needs_review: 1, held: 1, filed: 1, failed: 1 });
  });

  it('a team with no email address sends none, and the page then shows nothing for it', async () => {
    as('sameera');
    const list = await fetchInboxItems('customer-support');
    expect(list.emailAddress).toBeUndefined();
    expect(emailAddressOf(list)).toBeNull();
    expect(list.items).toEqual([]);
  });

  it('the filed item names the concepts it became, and each is in the team’s memory', async () => {
    as('nadia');
    const filed = byName((await fetchInboxItems('engineering')).items, 'Release notes 2.4.md');
    expect(filedConcepts(filed)).toHaveLength(3);
    expect(filedReference(filed)).toMatch(/^memory\/references\//);
    const known = new Set((await fetchConcepts('engineering')).items.map((c) => c.path));
    for (const p of filed.filedPaths) expect(known.has(p)).toBe(true);
  });

  it('only a lead or admin releases, discards or retries; anyone else is told so', async () => {
    as('nadia');
    const held = byName((await fetchInboxItems('engineering')).items, 'partner-export.zip');
    await expect(releaseInboxItem('engineering', held.id)).rejects.toThrow(/team lead or a workspace admin/);
    await expect(discardInboxItem('engineering', held.id)).rejects.toThrow(/team lead or a workspace admin/);
    await expect(retryInboxItem('engineering', held.id)).rejects.toThrow(/team lead or a workspace admin/);
  });

  it('a lead releases a held item and it is filed on the way; a retry needs a failed one; a discard takes the item out of the list', async () => {
    as('omar');
    const items = (await fetchInboxItems('engineering')).items;
    const held = byName(items, 'partner-export.zip');
    const failed = byName(items, 'whiteboard.png');
    await expect(retryInboxItem('engineering', held.id)).rejects.toThrow(/failed/);
    await expect(releaseInboxItem('engineering', failed.id)).rejects.toThrow(/held item/);
    expect((await releaseInboxItem('engineering', held.id)).item.state).toBe('queued');
    expect(byName((await fetchInboxItems('engineering')).items, 'partner-export.zip').state).toBe('filing');
    expect(byName((await fetchInboxItems('engineering')).items, 'partner-export.zip').state).toBe('filed');
    expect((await discardInboxItem('engineering', failed.id)).item.state).toBe('discarded');
    expect((await fetchInboxItems('engineering')).items.some((i) => i.id === failed.id)).toBe(false);
    await expect(discardInboxItem('engineering', held.id)).rejects.toThrow(/cannot be discarded/);
  });

  it('a note is queued, then filed; a web address is a link; the same note again is a duplicate', async () => {
    as('nadia');
    const made = await createInboxNote('engineering', { title: 'Standup', text: 'We ship on Friday.', teamOnly: true });
    expect(made.duplicate).toBe(false);
    expect(made.item).toMatchObject({ name: 'Standup', kind: 'markdown', state: 'queued', teamOnly: true, origin: 'person' });
    const link = await createInboxNote('engineering', { text: 'https://example.com/spec', teamOnly: false });
    expect(link.item).toMatchObject({ kind: 'link', name: 'https://example.com/spec' });
    const again = await createInboxNote('engineering', { title: 'Standup', text: 'We ship on Friday.', teamOnly: false });
    expect(again.duplicate).toBe(true);
    expect(again.item.state).toBe('duplicate');
    await fetchInboxItems('engineering');
    expect(byName((await fetchInboxItems('engineering')).items, 'Standup').state).toBe('filed');
  });

  it('a message sent to memory is a drop from a message', async () => {
    as('nadia');
    const sent = await sendToMemory(CHANNEL, MESSAGE, { confirmPrivate: false, teamOnly: false, thread: true });
    expect(sent.item).toMatchObject({ origin: 'message', name: 'Thread in #general' });
  });

  it('a person outside the team is refused the list', async () => {
    as('lena');
    await expect(fetchInboxItems('engineering')).rejects.toThrow();
  });

  it('the list answer parses with and without an address', () => {
    const base = { items: [], canManage: false, maxBytes: 1024 };
    expect(InboxListWithAddress.parse(base).emailAddress).toBeUndefined();
    expect(InboxListWithAddress.parse({ ...base, emailAddress: null }).emailAddress).toBeNull();
    expect(InboxListWithAddress.parse({ ...base, emailAddress: 'team@inbox.example' }).emailAddress).toBe('team@inbox.example');
  });
});

describe('a live push', () => {
  const payload = { teamId: '00000000-0000-7000-8000-0000000b0001', itemId: ITEM, state: 'filed' };
  it('is read when it is an inbox push with the shared shape, and ignored otherwise', () => {
    expect(parseInboxPush({ type: WS_INBOX_ITEM_CHANGED, payload })).toEqual(InboxItemChangedPush.parse(payload));
    expect(parseInboxPush({ type: 'message.created', payload })).toBeNull();
    expect(parseInboxPush({ type: WS_INBOX_ITEM_CHANGED, payload: { ...payload, state: 'sideways' } })).toBeNull();
    expect(parseInboxPush({ type: WS_INBOX_ITEM_CHANGED, payload: {} })).toBeNull();
  });
});

describe('the words', () => {
  const item = (patch: Partial<InboxItem>): InboxItem =>
    ({ id: ITEM, name: 'Design review notes', state: 'filed', reason: null, holdReason: null, duplicateOf: null, filedPaths: [], ...patch }) as InboxItem;

  it('has the five filters of the plan, in order, after All', () => {
    expect(FILTERS.map((f) => f.label)).toEqual(['All', 'Processing', 'Needs review', 'Held', 'Filed', 'Failed']);
  });

  it('puts every state in one filter and a duplicate with the filed; a discarded item is in none', () => {
    const where = (s: InboxItem['state']) => FILTERS.filter((f) => f.id !== 'all' && inFilter({ state: s }, f.id)).map((f) => f.id);
    expect(where('queued')).toEqual(['processing']);
    expect(where('extracting')).toEqual(['processing']);
    expect(where('filing')).toEqual(['processing']);
    expect(where('duplicate')).toEqual(['filed']);
    expect(where('needs_review')).toEqual(['needs_review']);
    expect(where('discarded')).toEqual([]);
    expect(inFilter({ state: 'discarded' }, 'all')).toBe(false);
    expect(isProcessing({ state: 'extracting' })).toBe(true);
    expect(isProcessing({ state: 'filed' })).toBe(false);
  });

  it('tells a person what happened, in the words of the plan', () => {
    const paths = ['memory/facts/a.md', 'memory/decisions/b.md', 'memory/people/c.md', 'memory/references/design-review-notes-1a2b3c4d.md'];
    expect(noticeCopy(item({ filedPaths: paths }))).toBe('Filed 3 concepts from Design review notes');
    expect(noticeCopy(item({ filedPaths: paths.slice(0, 1).concat(paths[3] as string) }))).toBe('Filed 1 concept from Design review notes');
    expect(noticeCopy(item({ filedPaths: [paths[3] as string] }))).toBe('Filed Design review notes as a reference');
    expect(noticeCopy(item({ state: 'held' }))).toBe('Design review notes is held until a team lead looks at it');
    expect(noticeCopy(item({ state: 'failed' }))).toBe('Design review notes could not be filed');
    expect(noticeCopy(item({ state: 'needs_review' }))).toBe('Design review notes needs a look before it is filed');
    expect(noticeCopy(item({ state: 'queued' }))).toBeNull();
    expect(noticeCopy(item({ state: 'filing' }))).toBeNull();
  });

  it('separates the concepts an item became from its reference, and names a concept from its file when it has no title', () => {
    const it2 = item({ filedPaths: ['memory/facts/release-process.md', 'memory/references/x-12345678.md'] });
    expect(filedConcepts(it2)).toEqual(['memory/facts/release-process.md']);
    expect(filedReference(it2)).toBe('memory/references/x-12345678.md');
    expect(conceptName('memory/facts/release-process.md')).toBe('release process');
  });

  it('shows the server’s sentence first, and its own words when there is none', () => {
    expect(itemSentence(item({ state: 'failed', reason: 'Pictures cannot be read yet.' }))).toBe('Pictures cannot be read yet.');
    expect(itemSentence(item({ state: 'held', holdReason: 'dlp' }))).toBe(holdSentence('dlp'));
    expect(itemSentence(item({ state: 'filed' }))).toBeNull();
    expect(itemLook({ state: 'held' }).label).toBe('Held');
    expect(itemLook({ state: 'failed' }).tone).toBe('bad');
  });

  it('offers Retry, Release and Discard only to a lead or admin, and only where the server accepts them', () => {
    expect(itemActions({ state: 'failed' }, false)).toEqual({ retry: false, release: false, discard: false });
    expect(itemActions({ state: 'failed' }, true)).toEqual({ retry: true, release: false, discard: true });
    expect(itemActions({ state: 'held' }, true)).toEqual({ retry: false, release: true, discard: true });
    expect(itemActions({ state: 'needs_review' }, true)).toEqual({ retry: false, release: true, discard: true });
    expect(itemActions({ state: 'filed' }, true)).toEqual({ retry: false, release: false, discard: false });
    expect(itemActions({ state: 'filing' }, true)).toEqual({ retry: false, release: false, discard: false });
  });

  it('checks a file against the size cap before sending, and says so with its name', () => {
    expect(dropProblem({ name: 'a.md', size: 10 }, 1024)).toBeNull();
    expect(dropProblem({ name: 'a.md', size: 0 }, 1024)).toBe('a.md is empty.');
    expect(dropProblem({ name: 'big.pdf', size: 30 * 1024 * 1024 }, 25 * 1024 * 1024)).toBe('big.pdf is larger than the 25 MB limit.');
    expect(sizeLabel(512)).toBe('512 B');
    expect(sizeLabel(2048)).toBe('2 KB');
    expect(sizeLabel(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('reads the email address only when there is one', () => {
    expect(emailAddressOf({})).toBeNull();
    expect(emailAddressOf({ emailAddress: null })).toBeNull();
    expect(emailAddressOf({ emailAddress: '  ' })).toBeNull();
    expect(emailAddressOf({ emailAddress: 'eng@inbox.example' })).toBe('eng@inbox.example');
  });

  it('links to the inbox and to a concept by team and path', () => {
    expect(inboxLink('engineering')).toBe('/t/engineering/memory?tab=inbox');
    expect(conceptLink('engineering', 'memory/facts/a b.md')).toBe('/t/engineering/memory?concept=memory%2Ffacts%2Fa%20b.md');
  });
});
