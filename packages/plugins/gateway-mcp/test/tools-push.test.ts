/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import type { McpToolsProvider } from '@manythreads/sdk';
import { McpToolsStatus } from '@manythreads/shared';
import { lockTools } from '../src/tools-state.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, type RepoWorld } from '../../repo-git/test/world.ts';

// A bot's tools by push (PLAN P14-22), against the real server and database: the session id, the event stream, what makes it send, who may open it,
// and the line the bot's page shows. A `BOT.md` committed through the real loader changes the grants, exactly as an edit does.

const { omar, tariq } = personas;
vi.setConfig({ testTimeout: 180_000 });

const FRAME = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n';

let w: RepoWorld;
let alpha: { botId: string; token: string };
let beta: { botId: string; token: string };

const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const botMd = (name: string, native: string): string =>
  ['---', 'schema: 1', `name: ${name}`, 'role: Answers through a Hermes gateway', 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', '  - type: mention', 'capabilities:', `  native: [${native}]`, '---', '', `# ${name}`, '', 'Soul text.', ''].join('\n');

const commitBot = async (slug: string, native: string, message: string): Promise<void> => {
  const res = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: botMd(slug, native) }], message);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

async function loadBot(slug: string, native: string): Promise<{ botId: string; token: string }> {
  await commitBot(slug, native, `Add ${slug}`);
  const botId = await until(() => w.system(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE slug = $1 AND status = 'active'`, [slug])).rows[0]?.id ?? null), 30_000, `the loader to load ${slug}`);
  const minted = await w.call<{ token: string }>(omar, 'POST', `/api/teams/engineering/bots/${slug}/pairing-tokens`, {});
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  return { botId, token: minted.body.token };
}

const versionOf = (botId: string): Promise<number | null> =>
  w.system(async (tx) => {
    const row = (await tx.query<{ v: string }>('SELECT version::text AS v FROM app.mcp_bot_tools WHERE bot_id = $1', [botId])).rows[0];
    return row ? Number(row.v) : null;
  });

const rpc = async (path: string, token: string | null, method: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> => {
  const res = await fetch(`${w.server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {}, headers: res.headers };
};

const toolNames = (body: any): string[] => (body.result.tools as Array<{ name: string }>).map((t) => t.name).sort();

/** An open event stream: what has been read so far, and a way to wait for more. */
interface OpenStream {
  status: number;
  headers: Headers;
  text(): string;
  ended(): boolean;
  frames(): number;
  close(): void;
}

async function openStream(path: string, token: string | null, headers: Record<string, string> = {}): Promise<OpenStream> {
  const controller = new AbortController();
  const res = await fetch(`${w.server.url}${path}`, {
    method: 'GET',
    headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    signal: controller.signal,
  });
  let text = '';
  let ended = res.body === null;
  if (res.status === 200 && res.body) {
    const reader = res.body.getReader();
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          text += Buffer.from(value).toString('utf8');
        }
      } catch {
        /* aborted */
      }
      ended = true;
    })();
  } else {
    await res.arrayBuffer();
  }
  return { status: res.status, headers: res.headers, text: () => text, ended: () => ended, frames: () => text.split(FRAME).length - 1, close: () => controller.abort() };
}

const framesReach = (stream: OpenStream, count: number, ms: number, what: string): Promise<true> => until(async () => stream.frames() >= count || undefined, ms, what) as Promise<true>;

beforeAll(async () => {
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  alpha = await loadBot('push-alpha', 'messages.post, memory.recall');
  beta = await loadBot('push-beta', 'messages.post');
}, 180_000);

afterAll(async () => {
  await w?.close();
});

describe('the session id', () => {
  it('initialize at a bot’s address says the list can change and hands out a session id; the next calls may send it back', async () => {
    for (const path of ['/mcp', `/api/mcp/bots/${alpha.botId}`]) {
      const init = await rpc(path, alpha.token, 'initialize');
      expect(init.status).toBe(200);
      expect(init.body.result.capabilities.tools).toEqual({ listChanged: true });
      const session = init.headers.get('mcp-session-id');
      expect(session).toMatch(/^v1\./);
      const listed = await rpc(path, alpha.token, 'tools/list', { 'mcp-session-id': session! });
      expect(listed.status).toBe(200);
      expect(toolNames(listed.body)).toEqual(expect.arrayContaining(['memory.recall', 'messages.post']));
      // no header at all (an older client) is still served
      expect((await rpc(path, alpha.token, 'tools/list')).status).toBe(200);
    }
  });

  it('a changed signature, another bot’s id and nonsense are an unknown session (404), never a 500 and never served', async () => {
    const session = (await rpc('/mcp', alpha.token, 'initialize')).headers.get('mcp-session-id')!;
    const other = (await rpc('/mcp', beta.token, 'initialize')).headers.get('mcp-session-id')!;
    for (const bad of [`${session.slice(0, -3)}AAA`, other, 'garbage', 'v1..', 'x'.repeat(300)]) {
      expect((await rpc('/mcp', alpha.token, 'tools/list', { 'mcp-session-id': bad })).status, bad.slice(0, 20)).toBe(404);
      expect((await openStream('/mcp', alpha.token, { 'mcp-session-id': bad })).status, bad.slice(0, 20)).toBe(404);
    }
  });

  it('an initialize that carries a stale or another bot’s session id starts a new session instead of failing; any other call with it is still 404', async () => {
    const other = (await rpc('/mcp', beta.token, 'initialize')).headers.get('mcp-session-id')!;
    for (const stale of ['garbage', other]) {
      const again = await rpc('/mcp', alpha.token, 'initialize', { 'mcp-session-id': stale });
      expect(again.status).toBe(200);
      expect(again.headers.get('mcp-session-id')).toMatch(/^v1\./);
      expect(again.headers.get('mcp-session-id')).not.toBe(stale);
      expect((await rpc('/mcp', alpha.token, 'tools/list', { 'mcp-session-id': stale })).status).toBe(404);
    }
  });

  it('a run’s own address still says the list does not change and gives no session', async () => {
    const minted = await w.call<{ runId: string; token: string }>(null, 'POST', '/api/mcp/runs', { pairingToken: alpha.token });
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    const init = await rpc(`/api/mcp/runs/${minted.body.runId}`, minted.body.token, 'initialize');
    expect(init.body.result.capabilities.tools).toEqual({ listChanged: false });
    expect(init.headers.get('mcp-session-id')).toBeNull();
  });
});

describe('who may open the event stream', () => {
  it('GET without Accept: text/event-stream is 405 as before; without a token 401; with a wrong token, another bot’s token or a run token 401', async () => {
    const plain = await fetch(`${w.server.url}/mcp`, { method: 'GET', headers: { authorization: `Bearer ${alpha.token}` } });
    expect(plain.status).toBe(405);
    expect(plain.headers.get('allow')).toContain('POST');
    expect((await openStream('/mcp', null)).status).toBe(401);
    expect((await openStream('/mcp', 'not-a-token-at-all')).status).toBe(401);
    expect((await openStream(`/api/mcp/bots/${alpha.botId}`, beta.token)).status).toBe(401);
    expect((await openStream(`/api/mcp/bots/${beta.botId}`, null)).status).toBe(401);
    const run = await w.call<{ token: string }>(null, 'POST', '/api/mcp/runs', { pairingToken: alpha.token });
    expect((await openStream('/mcp', run.body.token)).status).toBe(401);
  });

  it('a header of a megabyte is refused by the server and nothing else is harmed', async () => {
    const outcome = await openStream('/mcp', alpha.token, { 'x-pad': 'a'.repeat(1_000_000) }).then(
      (s) => s.status,
      () => 'refused',
    );
    expect(outcome === 'refused' || (typeof outcome === 'number' && outcome >= 400)).toBe(true);
    expect((await rpc('/mcp', alpha.token, 'tools/list')).status).toBe(200);
  });
});

describe('the event stream', () => {
  it('opens with one list_changed, is an event stream that a proxy may not buffer, and carries nothing secret', async () => {
    const stream = await openStream('/mcp', alpha.token);
    try {
      expect(stream.status).toBe(200);
      expect(stream.headers.get('content-type')).toContain('text/event-stream');
      expect(stream.headers.get('x-accel-buffering')).toBe('no');
      expect(stream.headers.get('cache-control')).toContain('no-cache');
      await framesReach(stream, 1, 5_000, 'the first frame');
      expect(stream.text()).toBe(FRAME);
      expect(stream.text()).not.toContain(alpha.token);
      expect(stream.text()).not.toContain(alpha.botId);
    } finally {
      stream.close();
    }
  });

  it('a BOT.md edit that changes the grants makes every open stream of that bot (and only that bot) send list_changed, and the next list has the new tool', async () => {
    const a1 = await openStream('/mcp', alpha.token);
    const a2 = await openStream(`/api/mcp/bots/${alpha.botId}`, alpha.token);
    const b1 = await openStream('/mcp', beta.token);
    try {
      await Promise.all([framesReach(a1, 1, 5_000, 'a1 first'), framesReach(a2, 1, 5_000, 'a2 first'), framesReach(b1, 1, 5_000, 'b1 first')]);
      const before = toolNames((await rpc('/mcp', alpha.token, 'tools/list')).body);
      expect(before).not.toContain('tasks.read');
      const version = (await versionOf(alpha.botId))!;

      await commitBot('push-alpha', 'messages.post, memory.recall, tasks.read', 'Give push-alpha tasks.read');
      await framesReach(a1, 2, 30_000, 'a1 second frame');
      await framesReach(a2, 2, 5_000, 'a2 second frame');
      expect(await versionOf(alpha.botId)).toBeGreaterThan(version);
      expect(toolNames((await rpc('/mcp', alpha.token, 'tools/list')).body)).toContain('tasks.read');

      // an edit that changes only the prose of BOT.md changes no tool, so nothing is pushed
      const stable = await versionOf(alpha.botId);
      const res = await w.commit(omar, 'engineering', [{ op: 'put', path: 'bots/push-alpha/BOT.md', content: botMd('push-alpha', 'messages.post, memory.recall, tasks.read').replace('Soul text.', 'Other text.') }], 'Prose only');
      expect(res.status).toBe(201);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      expect(await versionOf(alpha.botId)).toBe(stable);
      expect(a1.frames()).toBe(2);
      expect(b1.frames()).toBe(1);
    } finally {
      for (const s of [a1, a2, b1]) s.close();
    }
  });

  it('a change another replica wrote to the database reaches a stream this server holds (nothing is shared in process memory)', async () => {
    const stream = await openStream('/mcp', beta.token);
    try {
      await framesReach(stream, 1, 5_000, 'the first frame');
      await w.system((tx) => tx.query('UPDATE app.mcp_bot_tools SET version = version + 1 WHERE bot_id = $1', [beta.botId]));
      await framesReach(stream, 2, 10_000, 'the frame for the other replica’s change');
    } finally {
      stream.close();
    }
  });

  it('a stream that opens after a change still starts with a frame, so a client that reconnects after a deploy lists again', async () => {
    const stream = await openStream('/mcp', alpha.token);
    try {
      await framesReach(stream, 1, 5_000, 'the first frame');
    } finally {
      stream.close();
    }
  });

  it('refuses the fifth stream of a bot with 429 and Retry-After, gives the room back when one closes, and survives opens and aborts in a loop', async () => {
    const held: OpenStream[] = [];
    for (let i = 0; i < 4; i += 1) held.push(await openStream('/mcp', beta.token));
    expect(held.map((s) => s.status)).toEqual([200, 200, 200, 200]);
    const fifth = await openStream('/mcp', beta.token);
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('retry-after')).toBeTruthy();
    held[0]!.close();
    const again = await until(async () => {
      const s = await openStream('/mcp', beta.token);
      if (s.status === 200) return s;
      return null;
    }, 10_000, 'room after a close');
    for (const s of [...held, again]) s.close();
    // open and drop 60 in a row: none may leak a slot
    for (let i = 0; i < 60; i += 1) {
      const s = await until(async () => {
        const o = await openStream('/mcp', beta.token);
        return o.status === 200 ? o : null;
      }, 10_000, 'a slot in the loop');
      s.close();
    }
    const last = await until(async () => {
      const o = await openStream('/mcp', beta.token);
      return o.status === 200 ? o : null;
    }, 10_000, 'a slot after the loop');
    last.close();
  });

  it('ends when the bot’s token is turned off', async () => {
    const minted = await w.call<{ token: string }>(omar, 'POST', '/api/teams/engineering/bots/push-beta/pairing-tokens/rotate', {});
    expect(minted.status, JSON.stringify(minted.body)).toBe(201);
    beta.token = minted.body.token;
    const stream = await openStream('/mcp', beta.token);
    try {
      await framesReach(stream, 1, 5_000, 'the first frame');
      expect((await w.call(omar, 'DELETE', '/api/teams/engineering/bots/push-beta/pairing-tokens')).status).toBe(200);
      await until(async () => stream.ended() || undefined, 30_000, 'the stream to end after the token was revoked');
      expect((await openStream('/mcp', beta.token)).status).toBe(401);
    } finally {
      stream.close();
    }
  });
});

describe('refreshes of one bot’s digest', () => {
  it('are taken one at a time: a second refresh waits for the first to finish, and another bot’s is not held up', async () => {
    let releaseFirst!: () => void;
    const firstHolds = new Promise<void>((resolve) => (releaseFirst = resolve));
    let firstLocked!: () => void;
    const firstHasLock = new Promise<void>((resolve) => (firstLocked = resolve));
    const first = w.system(async (tx) => {
      await lockTools(tx, alpha.botId);
      firstLocked();
      await firstHolds;
    });
    await firstHasLock;
    // the test world's system pool has two connections: the other bot is tried while one is free, then the second refresh takes the other and waits
    let otherGot = false;
    await w.system(async (tx) => {
      await lockTools(tx, beta.botId);
      otherGot = true;
    });
    let secondGot = false;
    const second = w.system(async (tx) => {
      await lockTools(tx, alpha.botId);
      secondGot = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(otherGot).toBe(true);
    expect(secondGot).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondGot).toBe(true);
  });
});

describe('the digest the bot’s page and the pod read', () => {
  it('the provider’s digest is the one the database kept for the bot, and it moves with the grants', async () => {
    const provider = w.server.host.registries.providers['mcp.tools'].list()[0]!.value as McpToolsProvider;
    expect(provider.id).toBe('mcp.tools');
    const digest = (await provider.toolsDigest(alpha.botId))!;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await w.system(async (tx) => (await tx.query<{ d: string }>('SELECT pushed_digest AS d FROM app.mcp_bot_tools WHERE bot_id = $1', [alpha.botId])).rows[0]!.d)).toBe(digest);
    expect(await provider.toolsDigest(beta.botId)).not.toBe(digest);
    expect(await provider.toolsDigest('00000000-0000-4000-8000-000000000999')).toBeNull();
  });

  it('the status line: never before a list, current after one, older after an edit, current after the next list, never again after a new token', async () => {
    const status = async (): Promise<McpToolsStatus> => {
      const res = await w.call(omar, 'GET', '/api/teams/engineering/bots/push-alpha/mcp-tools');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return McpToolsStatus.parse(res.body);
    };
    const fresh = await w.call<{ token: string }>(omar, 'POST', '/api/teams/engineering/bots/push-alpha/pairing-tokens/rotate', {});
    expect(fresh.status).toBe(201);
    expect((await status()).state).toBe('never');
    await rpc('/mcp', fresh.body.token, 'tools/list');
    const current = await until(async () => {
      const s = await status();
      return s.state === 'current' ? s : null;
    }, 10_000, 'the listing to be recorded');
    expect(current.listedDigest).toBe(current.digest);
    expect(current.listedAt).toBeTruthy();

    await commitBot('push-alpha', 'messages.post, memory.recall', 'Take tasks.read away again');
    const older = await until(async () => {
      const s = await status();
      return s.state === 'older' ? s : null;
    }, 30_000, 'the page to say the list is older');
    expect(older.listedDigest).toBe(current.digest);
    expect(older.digest).not.toBe(current.digest);

    await rpc('/mcp', fresh.body.token, 'tools/list');
    await until(async () => (await status()).state === 'current' || undefined, 10_000, 'current after the next list');
    // the status carries digests and a time, nothing of a token
    expect(JSON.stringify(await status())).not.toContain(fresh.body.token);
  });

  it('a person outside the team cannot read it', async () => {
    const res = await w.call(tariq, 'GET', '/api/teams/engineering/bots/push-alpha/mcp-tools');
    expect(res.status).toBe(403);
    expect((await w.call(omar, 'GET', '/api/teams/engineering/bots/no-such-bot/mcp-tools')).status).toBe(404);
  });
});
