import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COOLING_TTL_MS,
  FAIL_TTL_MS,
  FETCH_QUEUE,
  OK_TTL_MS,
  SWEEP_QUEUE,
  SYNC_QUEUE,
  WORKSPACE_IMAGE_BYTES_MAX,
  purge,
  registerJobs,
  storeImage,
  sweepWorkspace,
  type JobDeps,
} from '../src/jobs.ts';
import { createHostBreaker, createLinkBudget } from '../src/limits.ts';
import { extractLinks } from '../src/links.ts';
import type { SafeFetchDeps } from '../src/safe-fetch.ts';

// The jobs against a scripted fake database: no Postgres, no real network (a local fake server stands in for the public site). They prove the
// ORDER of things the review asked for: nothing is queued when the feature is off, the page is read with no transaction open, the guard runs again
// for a cached result, the card is inserted only for a live and unchanged message, and the budget and the rules hold. The same behaviour against
// real tables is in link-preview-api.test.ts (which needs the devbox database).

const WS = '01900000-0000-7000-8000-000000000001';
const MSG = '01900000-0000-7000-8000-000000000002';
const CH = '01900000-0000-7000-8000-000000000003';
const AUTHOR = '01900000-0000-7000-8000-000000000004';
const TEAM = '01900000-0000-7000-8000-000000000005';
const BODY = 'read http://site.test/post please';
const URL_ = extractLinks(BODY)[0] as string;

interface Q {
  sql: string;
  params: unknown[];
}

interface State {
  message: Record<string, unknown> | null;
  settings: { enabled: boolean; allow: string[]; deny: string[] } | null;
  cache: Record<string, unknown> | null;
  cards: number;
  hasCard: boolean;
  insertRows: number;
  needNetwork: (urls: string[]) => string[];
  pruned: number;
  used: number;
  freed: number[];
  cardRows: Array<{ id: string; url: string; message_id: string; channel_id: string }>;
  cacheRows: Array<{ id: string; url: string }>;
}

const freshState = (): State => ({
  message: { id: MSG, workspace_id: WS, channel_id: CH, author_id: AUTHOR, body: BODY, deleted: false, channel_kind: 'channel', team_id: TEAM },
  settings: null,
  cache: null,
  cards: 0,
  hasCard: false,
  insertRows: 1,
  needNetwork: (urls) => urls,
  pruned: 0,
  used: 0,
  freed: [],
  cardRows: [],
  cacheRows: [],
});

let state: State;
let queries: Q[];
let open: number; // transactions open right now
let enqueued: Array<{ queue: string; payload: unknown; options: unknown }>;
let pushes: unknown[];
let egressCalls: Array<Record<string, unknown>>;
let egressDecision: { hooks: number; outcome: string; message?: string };
let logs: string[];
let handlers: Map<string, (event: PluginEvent, tx: PluginTx) => Promise<void>>;
let jobHandlers: Map<string, (payload: unknown, tx: PluginTx, job: unknown) => Promise<void>>;
let jobOptions: Map<string, Record<string, unknown> | undefined>;

const rowsFor = (sql: string, params: unknown[]): unknown[] => {
  if (/FROM app\.messages m JOIN app\.channels c/.test(sql)) return state.message ? [state.message] : [];
  if (/FROM app\.link_preview_settings/.test(sql)) return state.settings ? [state.settings] : [];
  if (/to_regclass/.test(sql)) return [{ ok: false }];
  if (/count\(\*\)::int AS n FROM app\.link_previews/.test(sql)) return [{ n: state.cards }];
  if (/SELECT 1 FROM app\.link_previews WHERE message_id/.test(sql)) return state.hasCard ? [{ '?column?': 1 }] : [];
  if (/FROM app\.link_preview_cache WHERE workspace_id = \$1::uuid AND url = \$2 AND expires_at/.test(sql)) return state.cache ? [state.cache] : [];
  if (/FROM unnest\(\$1::text\[\]\)/.test(sql)) return state.needNetwork(params[0] as string[]).map((url) => ({ url }));
  if (/DELETE FROM app\.link_previews WHERE message_id = \$1::uuid AND removed_at IS NULL/.test(sql)) return Array.from({ length: state.pruned }, (_, i) => ({ id: `p${i}` }));
  if (/INSERT INTO app\.link_previews /.test(sql)) return Array.from({ length: state.insertRows }, (_, i) => ({ id: `c${i}` }));
  if (/app\.channel_audience/.test(sql)) return [{ person_id: 'person-1' }];
  if (/sum\(octet_length\(bytes\)\)/.test(sql)) return [{ n: String(state.used) }];
  if (/WITH candidates AS/.test(sql)) return state.freed.map((n) => ({ n }));
  if (/INSERT INTO app\.link_preview_images/.test(sql)) return [{ id: 'img-1' }];
  if (/SELECT id, url, message_id, channel_id FROM app\.link_previews/.test(sql)) {
    const after = params[1] as string;
    return state.cardRows.filter((r) => r.id > after);
  }
  if (/SELECT id, url FROM app\.link_preview_cache/.test(sql)) {
    const after = params[1] as string;
    return state.cacheRows.filter((r) => r.id > after);
  }
  return [];
};

const makeTx = (): PluginTx =>
  ({
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      return { rows: rowsFor(sql, params) };
    },
  }) as unknown as PluginTx;

const THROWING_TX = new Proxy({}, { get: () => { throw new Error('the handler transaction must not be used by a detached job'); } }) as unknown as PluginTx;

const makeCtx = (): PluginContext =>
  ({
    events: { subscribe: (type: string, fn: (e: PluginEvent, tx: PluginTx) => Promise<void>) => void handlers.set(type, fn) },
    jobs: {
      register: (queue: string, fn: (p: unknown, tx: PluginTx, job: unknown) => Promise<void>, options?: Record<string, unknown>) => {
        jobHandlers.set(queue, fn);
        jobOptions.set(queue, options);
      },
      enqueue: async (_tx: PluginTx, queue: string, payload: unknown, options?: unknown) => {
        enqueued.push({ queue, payload, options });
      },
    },
    hooks: {
      runPreEgress: async (_tx: PluginTx, input: Record<string, unknown>) => {
        egressCalls.push({ ...input, openTx: open });
        return egressDecision;
      },
    },
    realtime: { pushToPeople: async (_tx: PluginTx, people: unknown, type: unknown, payload: unknown) => void pushes.push({ people, type, payload }) },
  }) as unknown as PluginContext;

const jobFor = () => ({
  log: { info: (m: string) => void logs.push(m), warn: (m: string) => void logs.push(m) },
  transaction: async <T>(fn: (tx: PluginTx) => Promise<T>): Promise<T> => {
    open += 1;
    try {
      return await fn(makeTx());
    } finally {
      open -= 1;
    }
  },
});

let server: Server;
let port = 0;
let pageHits = 0;
let onPageHit: () => void = () => undefined;
beforeAll(async () => {
  server = createServer((_req, res) => {
    pageHits += 1;
    onPageHit();
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<meta property="og:title" content="Hello"><meta property="og:description" content="World">');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let resolveCalls: Array<{ host: string; openTx: number }>;
const fetchDeps = (): SafeFetchDeps => ({
  resolve: async (host) => {
    resolveCalls.push({ host, openTx: open });
    return [{ address: '93.184.216.34', family: 4 }];
  },
  dial: () => ({ host: '127.0.0.1', port }),
});

let enabled: boolean;
let deps: JobDeps;
beforeEach(() => {
  state = freshState();
  queries = [];
  open = 0;
  enqueued = [];
  pushes = [];
  egressCalls = [];
  egressDecision = { hooks: 1, outcome: 'allow' };
  logs = [];
  handlers = new Map();
  jobHandlers = new Map();
  jobOptions = new Map();
  resolveCalls = [];
  pageHits = 0;
  onPageHit = () => undefined;
  enabled = true;
  deps = { fetchDeps: fetchDeps(), breaker: createHostBreaker(), budget: createLinkBudget(), enabled: () => enabled };
  registerJobs(makeCtx(), deps);
});

const runSync = (): Promise<void> => (jobHandlers.get(SYNC_QUEUE) as NonNullable<ReturnType<typeof jobHandlers.get>>)({ workspaceId: WS, messageId: MSG }, makeTx(), jobFor());
const runFetch = (): Promise<void> =>
  (jobHandlers.get(FETCH_QUEUE) as NonNullable<ReturnType<typeof jobHandlers.get>>)({ workspaceId: WS, messageId: MSG, url: URL_ }, THROWING_TX, jobFor());
const insertQuery = (): Q | undefined => queries.find((q) => /INSERT INTO app\.link_previews /.test(q.sql));

describe('the switch MANYTHREADS_LINK_PREVIEW', () => {
  it('with the feature off, a posted, edited or deleted message queues nothing', async () => {
    enabled = false;
    for (const type of ['channel.message.posted', 'channel.message.edited', 'channel.message.deleted']) {
      await (handlers.get(type) as NonNullable<ReturnType<typeof handlers.get>>)({ type, workspaceId: WS, messageId: MSG } as unknown as PluginEvent, makeTx());
    }
    expect(enqueued).toEqual([]);
  });

  it('with the feature on, a message queues one sync (a post is deduplicated, an edit is not)', async () => {
    const run = (type: string) => (handlers.get(type) as NonNullable<ReturnType<typeof handlers.get>>)({ type, workspaceId: WS, messageId: MSG } as unknown as PluginEvent, makeTx());
    await run('channel.message.posted');
    await run('channel.message.edited');
    expect(enqueued.map((e) => e.queue)).toEqual([SYNC_QUEUE, SYNC_QUEUE]);
    expect(enqueued[0]?.options).toEqual({ dedupeKey: `sync:${MSG}` });
    expect(enqueued[1]?.options).toBeUndefined();
  });

  it('a job already in the queue when the feature is switched off does nothing and touches no table', async () => {
    enabled = false;
    await runSync();
    await runFetch();
    expect(queries).toEqual([]);
    expect(pageHits).toBe(0);
  });
});

describe('sync', () => {
  it('queues one fetch per link, deduplicated per message and address', async () => {
    await runSync();
    expect(enqueued).toEqual([{ queue: FETCH_QUEUE, payload: { workspaceId: WS, messageId: MSG, url: URL_ }, options: { dedupeKey: `lp:${MSG}:${URL_}` } }]);
  });

  it('prunes only live cards: a tombstone (removed_at set) is never deleted', async () => {
    state.pruned = 1;
    await runSync();
    const prune = queries.find((q) => /DELETE FROM app\.link_previews WHERE message_id/.test(q.sql));
    expect(prune?.sql).toMatch(/removed_at IS NULL/);
    expect(pushes).toHaveLength(1); // readers are told a card went
  });

  it('with previews switched off for the workspace it neither prunes nor queues', async () => {
    state.settings = { enabled: false, allow: [], deny: [] };
    await runSync();
    expect(enqueued).toEqual([]);
    expect(queries.some((q) => /^\s*DELETE/.test(q.sql))).toBe(false);
  });

  it('skips links of a site the rules do not allow', async () => {
    state.settings = { enabled: true, allow: [], deny: ['site.test'] };
    await runSync();
    expect(enqueued).toEqual([]);
  });

  it('a message of a deleted or bot-conversation kind drops its cards and queues nothing', async () => {
    state.message = { ...(state.message as object), deleted: true };
    await runSync();
    expect(queries.some((q) => /^\s*DELETE FROM app\.link_previews WHERE message_id = \$1::uuid RETURNING/.test(q.sql))).toBe(true);
    expect(enqueued).toEqual([]);
  });

  describe('the budget', () => {
    it('stops a flood: once the author has used the minute, no more reads are queued and the log says so', async () => {
      let refuse = false;
      deps.budget = { take: () => (refuse ? { ok: false, scope: 'author' } : { ok: true }), reset: () => undefined };
      await runSync();
      expect(enqueued).toHaveLength(1);
      refuse = true;
      enqueued.length = 0;
      await runSync();
      expect(enqueued).toEqual([]);
      expect(logs.some((l) => /author budget is used up/.test(l))).toBe(true);
    });

    it('counts per author and workspace with the real budget (the eleventh message of a minute starts nothing)', async () => {
      for (let i = 0; i < 12; i += 1) await runSync();
      expect(enqueued.length).toBe(10);
    });

    it('is not charged for a link that already has a card or a kept read (no network is needed)', async () => {
      let charged = 0;
      deps.budget = { take: (_a, _w, n) => ((charged += n), { ok: true }), reset: () => undefined };
      state.needNetwork = () => [];
      await runSync();
      expect(charged).toBe(0);
      expect(enqueued).toHaveLength(1); // the fetch is still queued: it makes the card from the kept read
    });
  });
});

describe('fetch', () => {
  it('is a detached job, one per workspace at a time, two in the process', () => {
    expect(jobOptions.get(FETCH_QUEUE)).toMatchObject({ detached: true, serialKey: 'workspaceId', concurrency: 2 });
  });

  it('reads the page with no transaction open, and writes the card in a transaction of its own', async () => {
    await runFetch();
    expect(resolveCalls).toEqual([{ host: 'site.test', openTx: 0 }]);
    expect(pageHits).toBe(1);
    expect(egressCalls.length).toBeGreaterThan(0);
    expect(insertQuery()).toBeDefined();
    expect(pushes).toHaveLength(1);
    expect(open).toBe(0);
  });

  it('asks the guard with the team and with recorded:false (the guard writes its own refusal)', async () => {
    await runFetch();
    expect(egressCalls[0]).toMatchObject({ destination: 'link_preview', workspaceId: WS, teamId: TEAM, recorded: false, text: URL_ });
    expect(egressCalls.every((c) => c['openTx'] === 1)).toBe(true); // each call runs in its own short transaction
  });

  it('writes the card only for a message that is live and still has the same text', async () => {
    await runFetch();
    const q = insertQuery() as Q;
    expect(q.sql).toMatch(/FROM app\.messages m/);
    expect(q.sql).toMatch(/m\.deleted_at IS NULL/);
    expect(q.sql).toMatch(/m\.body = \$2/);
    expect(q.params[1]).toBe(BODY);
  });

  it('an edit that removes the link while the page is being read leaves no card', async () => {
    onPageHit = () => {
      state.message = { ...(state.message as object), body: 'no link any more' };
    };
    await runFetch();
    expect(insertQuery()).toBeUndefined();
    expect(pushes).toEqual([]);
  });

  it('a delete while the page is being read leaves no card', async () => {
    onPageHit = () => {
      state.message = { ...(state.message as object), deleted: true };
    };
    await runFetch();
    expect(insertQuery()).toBeUndefined();
  });

  it('rules changed while the page is being read: a newly denied site gets no card', async () => {
    onPageHit = () => {
      state.settings = { enabled: true, allow: [], deny: ['site.test'] };
    };
    await runFetch();
    expect(insertQuery()).toBeUndefined();
  });

  it('when the database refuses the conditional insert (the message changed under us) nobody is told', async () => {
    state.insertRows = 0;
    await runFetch();
    expect(insertQuery()).toBeDefined();
    expect(pushes).toEqual([]);
  });

  it('a payload address the message does not contain is ignored without any read', async () => {
    state.message = { ...(state.message as object), body: 'nothing here' };
    await runFetch();
    expect(pageHits).toBe(0);
    expect(insertQuery()).toBeUndefined();
  });

  it('a card the author removed (a tombstone) is not made again', async () => {
    state.hasCard = true;
    await runFetch();
    expect(pageHits).toBe(0);
  });

  it('remembers the result for a day when it is good, for an hour when it is not', async () => {
    await runFetch();
    const cacheWrite = queries.find((q) => /INSERT INTO app\.link_preview_cache/.test(q.sql)) as Q;
    expect(cacheWrite.params[2]).toBe('ok');
    expect(cacheWrite.params.at(-1)).toBe(OK_TTL_MS);
    expect(FAIL_TTL_MS).toBeLessThan(OK_TTL_MS);
    expect(COOLING_TTL_MS).toBeLessThan(FAIL_TTL_MS);
  });

  describe('a result kept from an earlier read', () => {
    beforeEach(() => {
      state.cache = { status: 'ok', title: 'Kept', description: null, site_name: null, image_id: null };
    });

    it('makes the card with no network read, but still asks the guard first', async () => {
      await runFetch();
      expect(pageHits).toBe(0);
      expect(resolveCalls).toEqual([]);
      expect(egressCalls).toHaveLength(1);
      expect(egressCalls[0]).toMatchObject({ teamId: TEAM, recorded: false });
      expect(insertQuery()?.params[6]).toBe('Kept');
    });

    it('makes no card when the guard now says no (the rules are judged again, not remembered)', async () => {
      egressDecision = { hooks: 1, outcome: 'block', message: 'no' };
      await runFetch();
      expect(egressCalls).toHaveLength(1);
      expect(insertQuery()).toBeUndefined();
    });

    it('makes no card when nothing guards the destination (fails closed)', async () => {
      egressDecision = { hooks: 0, outcome: 'allow' };
      await runFetch();
      expect(insertQuery()).toBeUndefined();
    });

    it('makes no card from a kept failure', async () => {
      state.cache = { status: 'failed', title: null, description: null, site_name: null, image_id: null };
      await runFetch();
      expect(insertQuery()).toBeUndefined();
    });
  });

  it('a read the guard refuses is remembered as blocked and makes no card', async () => {
    egressDecision = { hooks: 1, outcome: 'block', message: 'no' };
    await runFetch();
    const cacheWrite = queries.find((q) => /INSERT INTO app\.link_preview_cache/.test(q.sql)) as Q;
    expect(cacheWrite.params[2]).toBe('blocked');
    expect(insertQuery()).toBeUndefined();
    expect(pageHits).toBe(0);
  });

  it('a site that keeps timing out opens the breaker, and the next read of it does not leave the process', async () => {
    deps.fetchDeps = { ...fetchDeps(), resolve: async () => new Promise(() => undefined) };
    deps.overallMs = 60;
    for (let i = 0; i < 3; i += 1) await runFetch();
    const before = queries.length;
    expect(deps.breaker.allow('site.test')).toBe(false);
    await runFetch();
    const cacheWrite = queries.slice(before).find((q) => /INSERT INTO app\.link_preview_cache/.test(q.sql)) as Q;
    expect(cacheWrite.params[3]).toBe('host_cooling');
    expect(cacheWrite.params.at(-1)).toBe(COOLING_TTL_MS);
  });
});

describe('storeImage: the byte cap of a workspace', () => {
  const image = { bytes: Buffer.alloc(1000, 1), type: 'image/png' };
  const tx = (): PluginTx => makeTx();

  it('stores a picture that fits, and deletes nothing', async () => {
    state.used = 5000;
    expect(await storeImage(tx(), WS, image, 100_000)).toBe('img-1');
    expect(queries.some((q) => /WITH candidates/.test(q.sql))).toBe(false);
  });

  it('over the cap, drops the oldest pictures no card uses, then stores', async () => {
    state.used = 99_500;
    state.freed = [800, 700];
    expect(await storeImage(tx(), WS, image, 100_000)).toBe('img-1');
    const evict = queries.find((q) => /WITH candidates/.test(q.sql)) as Q;
    expect(evict.sql).toMatch(/NOT EXISTS \(SELECT 1 FROM app\.link_previews p WHERE p\.image_id = i\.id\)/);
    expect(evict.sql).toMatch(/ORDER BY i\.created_at/);
    expect(evict.params).toEqual([WS, 500]); // 99,500 + 1,000 - 100,000
  });

  it('still over after dropping every unused picture: refuses the new one (the card has no picture)', async () => {
    state.used = 99_500;
    state.freed = [100];
    expect(await storeImage(tx(), WS, image, 100_000)).toBeNull();
    expect(queries.some((q) => /INSERT INTO app\.link_preview_images/.test(q.sql))).toBe(false);
  });

  it('the cap of a workspace is 128 MiB', () => {
    expect(WORKSPACE_IMAGE_BYTES_MAX).toBe(128 * 1024 * 1024);
  });
});

describe('sweep: rules are not left behind', () => {
  const ID = (n: number): string => `01900000-0000-7000-8000-0000000001${String(n).padStart(2, '0')}`;

  it('removes the cards and kept reads of a site that is now denied, and tells the readers', async () => {
    state.settings = { enabled: true, allow: [], deny: ['bad.test'] };
    state.cardRows = [
      { id: ID(1), url: 'http://good.test/a', message_id: MSG, channel_id: CH },
      { id: ID(2), url: 'http://bad.test/a', message_id: MSG, channel_id: CH },
      { id: ID(3), url: 'http://sub.bad.test/a', message_id: MSG, channel_id: CH },
    ];
    state.cacheRows = [
      { id: ID(4), url: 'http://good.test/a' },
      { id: ID(5), url: 'http://bad.test/b' },
    ];
    const swept = await sweepWorkspace(makeCtx(), makeTx(), WS);
    expect(swept).toEqual({ cards: 2, cache: 1 });
    const del = queries.filter((q) => /^\s*DELETE FROM app\.link_previews WHERE id/.test(q.sql));
    expect(del[0]?.params[0]).toEqual([ID(2), ID(3)]);
    expect(pushes).toHaveLength(1);
  });

  it('removes everything when the switch is off, and only the live cards (tombstones are not selected)', async () => {
    state.settings = { enabled: false, allow: [], deny: [] };
    state.cardRows = [{ id: ID(1), url: 'http://good.test/a', message_id: MSG, channel_id: CH }];
    state.cacheRows = [{ id: ID(2), url: 'http://good.test/a' }];
    expect(await sweepWorkspace(makeCtx(), makeTx(), WS)).toEqual({ cards: 1, cache: 1 });
    expect(queries.find((q) => /SELECT id, url, message_id, channel_id FROM app\.link_previews/.test(q.sql))?.sql).toMatch(/removed_at IS NULL/);
  });

  it('with an allowlist, removes what is not on it', async () => {
    state.settings = { enabled: true, allow: ['good.test'], deny: [] };
    state.cardRows = [
      { id: ID(1), url: 'http://good.test/a', message_id: MSG, channel_id: CH },
      { id: ID(2), url: 'http://other.test/a', message_id: MSG, channel_id: CH },
    ];
    expect(await sweepWorkspace(makeCtx(), makeTx(), WS)).toEqual({ cards: 1, cache: 0 });
  });

  it('deletes nothing and pushes nothing when every row still passes', async () => {
    state.cardRows = [{ id: ID(1), url: 'http://good.test/a', message_id: MSG, channel_id: CH }];
    expect(await sweepWorkspace(makeCtx(), makeTx(), WS)).toEqual({ cards: 0, cache: 0 });
    expect(pushes).toEqual([]);
  });

  it('the sweep job is registered and runs the sweep for the workspace of its payload', async () => {
    state.settings = { enabled: true, allow: [], deny: ['bad.test'] };
    state.cardRows = [{ id: ID(2), url: 'http://bad.test/a', message_id: MSG, channel_id: CH }];
    await (jobHandlers.get(SWEEP_QUEUE) as NonNullable<ReturnType<typeof jobHandlers.get>>)({ workspaceId: WS }, makeTx(), jobFor());
    expect(logs.some((l) => /1 card\(s\)/.test(l))).toBe(true);
  });

  it('a sweep still runs when the feature is switched off in the environment (old cards must not stay)', async () => {
    enabled = false;
    state.settings = { enabled: false, allow: [], deny: [] };
    state.cardRows = [{ id: ID(1), url: 'http://good.test/a', message_id: MSG, channel_id: CH }];
    await (jobHandlers.get(SWEEP_QUEUE) as NonNullable<ReturnType<typeof jobHandlers.get>>)({ workspaceId: WS }, makeTx(), jobFor());
    expect(queries.some((q) => /^\s*DELETE FROM app\.link_previews WHERE id/.test(q.sql))).toBe(true);
  });
});

describe('purge', () => {
  it('removes cards of deleted messages along with old reads and unused pictures, and never touches tombstones of live messages', async () => {
    await purge(makeTx());
    const sqls = queries.map((q) => q.sql);
    expect(sqls.some((s) => /DELETE FROM app\.link_preview_cache WHERE expires_at < now\(\)/.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM app\.link_previews p USING app\.messages m[\s\S]*m\.deleted_at IS NOT NULL/.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM app\.link_preview_images i[\s\S]*interval '1 hour'/.test(s))).toBe(true);
  });
});
