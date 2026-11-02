import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eventually, ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld, type Persona } from '../../files/test/world.ts';
import { resetDropLimits } from '../src/upload.ts';
import { sampleDocx, sampleEml, buildZip } from './zipkit.ts';

// P8-14, P8-15, P8-16, P8-17 through the real server: a person drops a file, a note or a chat message into their team's inbox; the platform checks it, reads it,
// files a Reference in the team's memory (no model needed), and tells the dropper. Held items wait for a lead; a file that cannot be read says why.

const { omar, nadia, sameera, lena, tariq } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: FilesWorld;
let since = new Date(0);

interface Item {
  id: string;
  teamId: string;
  origin: string;
  state: string;
  kind: string;
  name: string;
  size: number;
  droppedBy: string | null;
  droppedByName: string | null;
  teamOnly: boolean;
  reason: string | null;
  holdReason: string | null;
  duplicateOf: string | null;
  parentId: string | null;
  filedPaths: string[];
  commitSha: string | null;
  originalKept: boolean;
  attempts: number;
}
interface Dropped {
  item: Item;
  duplicate: boolean;
  error?: { message: string };
}

const headersOf = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

const upload = async (who: Persona | null, name: string, body: Uint8Array | string, query = '', team = 'engineering'): Promise<{ status: number; body: Dropped }> => {
  const res = await fetch(`${world.server.url}/api/teams/${team}/inbox/items?name=${encodeURIComponent(name)}${query}`, {
    method: 'POST',
    headers: { ...(who ? headersOf(who) : {}), 'content-type': 'application/octet-stream' },
    body: (typeof body === 'string' ? Buffer.from(body) : body) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const note = (who: Persona, payload: Record<string, unknown>, team = 'engineering') => world.call<Dropped>(who, 'POST', `/api/teams/${team}/inbox/notes`, payload);
const getItem = async (who: Persona, id: string, team = 'engineering'): Promise<Item> => (await world.call<{ item: Item }>(who, 'GET', `/api/teams/${team}/inbox/items/${id}`)).body.item;
const states = async (who: Persona, query = ''): Promise<Item[]> => (await world.call<{ items: Item[] }>(who, 'GET', `/api/teams/engineering/inbox/items${query}`)).body.items;
const settle = (who: Persona, id: string, wanted: string[], what = 'the item to settle'): Promise<Item> =>
  eventually(async () => {
    const it = await getItem(who, id);
    return wanted.includes(it.state) ? it : false;
  }, 60_000, `${what} (${wanted.join('/')})`);
const repoFile = async (path: string): Promise<string> => {
  const res = await world.call<{ content: string }>(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.content;
};
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND occurred_at >= $2 ORDER BY id`, [type, since]))).rows.map((r) => r.payload);
const setTeamMd = async (frontmatter: string): Promise<void> => {
  const res = await world.call(omar, 'POST', '/api/teams/engineering/proposals', { path: 'TEAM.md', op: 'put', content: `---\n${frontmatter}---\n\n# Engineering\n`, title: 'Inbox settings', applyNow: true });
  expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
};
const withEnv = async (vars: Record<string, string>, fn: () => Promise<void>): Promise<void> => {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

/** A chunked upload that sends `first`, then waits `pauseMs` between further chunks, `chunks` times; resolves with the answer. */
const dribble = (who: Persona, name: string, first: string, pauseMs: number, chunks: number, hold?: Promise<void>): Promise<{ status: number; body: { error?: { message: string } } }> =>
  new Promise((resolve) => {
    const u = new URL(`${world.server.url}/api/teams/engineering/inbox/items?name=${encodeURIComponent(name)}`);
    const req = http.request({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'POST', agent: false, headers: { ...headersOf(who), 'transfer-encoding': 'chunked', 'content-type': 'application/octet-stream' } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (c: Buffer) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString();
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} });
      });
    });
    // a sender cut off for stalling gets its connection closed, not an answer
    req.on('error', () => resolve({ status: 0, body: {} }));
    void (async () => {
      req.write(first);
      for (let i = 0; i < chunks; i += 1) {
        await new Promise((r) => setTimeout(r, pauseMs));
        if (req.destroyed) return;
        req.write('more text\n');
      }
      if (hold) await hold;
      req.end();
    })();
  });

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
}, 180_000);

// each test has its own minute: how many a person may drop per minute is tested on its own
beforeEach(() => {
  resetDropLimits();
});

afterAll(async () => {
  await world?.close();
});

describe('dropping a file', () => {
  const MD = '# Release checklist\n\nTag the release, then update the changelog. The on-call engineer approves the deploy.\n';
  let first = '';

  it('a member drops a Markdown file; it is read, filed as a Reference in the team memory, and the dropper is told', async () => {
    const res = await upload(nadia, 'Release checklist.md', MD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.item).toMatchObject({ origin: 'person', kind: 'markdown', state: 'queued', name: 'Release checklist.md', teamOnly: false, originalKept: true, droppedByName: 'Nadia' });
    first = res.body.item.id;
    const filed = await settle(nadia, first, ['filed']);
    expect(filed.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(filed.filedPaths).toHaveLength(1);
    expect(filed.filedPaths[0]).toMatch(/^memory\/references\/release-checklist-[0-9a-f]{8}\.md$/);
    const concept = await repoFile(filed.filedPaths[0]!);
    expect(concept).toContain('type: Reference');
    expect(concept).toContain('origin: drop');
    expect(concept).toContain('process:inbox');
    expect(concept).toContain('The on-call engineer approves the deploy.');
    expect(concept).toMatch(/resource: inbox\/filed\/\d{4}-\d{2}\/[0-9a-f]{8}-Release-checklist\.md/);
    expect(concept).not.toContain('share:');
    // the bundle's index lists it
    expect(await repoFile('memory/index.md')).toContain('references/');
    expect((await events('memory.item.dropped')).map((e) => e['duplicate'])).toEqual([false]);
    const filedEvents = await events('memory.item.filed');
    expect(filedEvents).toHaveLength(1);
    expect(filedEvents[0]).toMatchObject({ itemId: first, concepts: 1, distilled: false, origin: 'person' });
  });

  it('the same bytes again are a duplicate: nothing is written twice and no work is queued', async () => {
    const again = await upload(omar, 'copy of checklist.md', MD);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.item).toMatchObject({ state: 'duplicate', duplicateOf: first, originalKept: false });
    expect((await events('memory.item.filed')).length).toBe(1);
    expect((await events('memory.item.dropped')).map((e) => e['duplicate'])).toEqual([false, true]);
  });

  it('the team sees its inbox; an outsider, a guest and nobody at all see nothing', async () => {
    const mine = await states(nadia);
    expect(mine.map((i) => i.id)).toEqual(expect.arrayContaining([first]));
    const lead = await world.call<{ items: Item[]; canManage: boolean; maxBytes: number }>(omar, 'GET', '/api/teams/engineering/inbox/items');
    expect(lead.body.canManage).toBe(true);
    expect(lead.body.maxBytes).toBe(25 * 1024 * 1024);
    expect((await world.call<{ canManage: boolean }>(nadia, 'GET', '/api/teams/engineering/inbox/items')).body.canManage).toBe(false);
    expect((await world.call(sameera, 'GET', '/api/teams/engineering/inbox/items')).status).toBe(403);
    expect((await world.call(lena, 'GET', '/api/teams/engineering/inbox/items')).status).toBe(403);
    expect((await world.call(null, 'GET', '/api/teams/engineering/inbox/items')).status).toBe(401);
    expect((await world.call(sameera, 'GET', `/api/teams/engineering/inbox/items/${first}`)).status).toBe(403);
    expect((await world.call(omar, 'GET', '/api/teams/engineering/inbox/items/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('refuses what cannot be dropped: no name, a kind of file nobody reads, an empty file, a guest, an outsider, nobody', async () => {
    expect((await upload(nadia, '', 'x')).status).toBe(400);
    const unknown = await upload(nadia, 'program.exe', 'MZ');
    expect(unknown.status).toBe(415);
    expect(unknown.body.error?.message).toContain('cannot be dropped');
    expect((await upload(nadia, 'empty.md', '')).status).toBe(400);
    expect((await upload(lena, 'a.md', 'guest words')).status).toBe(403);
    expect((await upload(sameera, 'a.md', 'outsider words')).status).toBe(403);
    expect((await upload(tariq, 'a.md', 'marketing words')).status).toBe(403);
    expect((await upload(null, 'a.md', 'nobody words')).status).toBe(401);
    expect((await upload(nadia, 'a.md', 'words', '', 'no-such-team')).status).toBe(403);
  });

  it('stops at the size cap: from the declared length before a byte is read, and from the stream when it is not declared', async () => {
    await withEnv({ MANYTHREADS_INBOX_MAX_BYTES: '2000' }, async () => {
      const big = 'x'.repeat(3000);
      const declared = await upload(nadia, 'big.md', big);
      expect(declared.status).toBe(413);
      expect(declared.body.error?.message).toContain('larger than');
      const streamed = await dribble(nadia, 'streamed.md', big, 10, 1);
      expect(streamed.status).toBe(413);
      expect((await upload(nadia, 'ok.md', 'x'.repeat(1500))).status).toBe(201);
    });
  });

  it('cuts off a sender that stalls, and one that takes too long; the slot is free again afterwards', async () => {
    await withEnv({ MANYTHREADS_UPLOAD_IDLE_MS: '300' }, async () => {
      const stalled = await dribble(nadia, 'stalled.md', 'a few words', 3000, 1);
      expect([0, 400]).toContain(stalled.status);
    });
    await withEnv({ MANYTHREADS_UPLOAD_IDLE_MS: '2000', MANYTHREADS_UPLOAD_MAX_MS: '700' }, async () => {
      const slow = await dribble(nadia, 'slow.md', 'a few words', 200, 10);
      expect([0, 400]).toContain(slow.status);
    });
    expect((await states(omar, '?limit=200')).filter((i) => i.name === 'stalled.md' || i.name === 'slow.md')).toEqual([]);
    expect((await upload(nadia, 'after-the-stall.md', '# After\n\nThis one arrives in one piece.\n')).status).toBe(201);
  });

  it('allows a person only two uploads at once', async () => {
    await withEnv({ MANYTHREADS_UPLOAD_IDLE_MS: '5000' }, async () => {
      let release: () => void = () => undefined;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      const one = dribble(omar, 'slot-one.md', 'first slot words', 50, 1, hold);
      const two = dribble(omar, 'slot-two.md', 'second slot words', 50, 1, hold);
      await new Promise((r) => setTimeout(r, 600));
      const third = await upload(omar, 'slot-three.md', 'third slot words');
      expect(third.status).toBe(429);
      expect(third.body.error?.message).toContain('Too many uploads at once');
      release();
      expect((await one).status).toBe(201);
      expect((await two).status).toBe(201);
    });
  });

  it('limits how many things one person drops in a minute', async () => {
    resetDropLimits();
    await withEnv({ MANYTHREADS_INBOX_DROPS_PER_MINUTE: '3' }, async () => {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) codes.push((await upload(omar, `rate-${i}.md`, `rate limited words ${i}`)).status);
      expect(codes).toEqual([201, 201, 201, 429, 429]);
      // another person is not held back by it
      expect((await upload(nadia, 'not-limited.md', 'nadia is under her own limit')).status).toBe(201);
    });
    resetDropLimits();
  });
});

describe('dropping a note', () => {
  it('files a note with a title as a Markdown Reference', async () => {
    const res = await note(nadia, { title: 'Pager rota', text: 'Sameera is on call the week of 9 November.', teamOnly: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item).toMatchObject({ kind: 'markdown', name: 'Pager rota', origin: 'person' });
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    const text = await repoFile(filed.filedPaths[0]!);
    expect(text).toContain('title: Pager rota');
    expect(text).toContain('Sameera is on call the week of 9 November.');
  });

  it('names an untitled note from its first line, and keeps a team-only note out of shares', async () => {
    const res = await note(nadia, { text: '## Deploy window\n\nTuesdays after standup.', teamOnly: true });
    expect(res.status).toBe(201);
    expect(res.body.item).toMatchObject({ name: 'Deploy window', teamOnly: true });
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    expect(await repoFile(filed.filedPaths[0]!)).toContain('share: never');
  });

  it('files a lone web address as a link and never fetches the page', async () => {
    const res = await note(nadia, { text: 'https://example.invalid/never-fetched', teamOnly: false });
    expect(res.status).toBe(201);
    expect(res.body.item.kind).toBe('link');
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    expect(await repoFile(filed.filedPaths[0]!)).toContain('https://example.invalid/never-fetched');
  });

  it('refuses an empty note, an unknown field, a guest and an outsider', async () => {
    expect((await note(nadia, { text: '   ', teamOnly: false })).status).toBe(400);
    expect((await note(nadia, { text: 'x', teamOnly: false, origin: 'email' })).status).toBe(400);
    expect((await note(lena, { text: 'words', teamOnly: false })).status).toBe(403);
    expect((await note(sameera, { text: 'words', teamOnly: false })).status).toBe(403);
  });
});

describe('send to memory', () => {
  let channelId = '';
  let privateId = '';
  const post = async (who: Persona, channel: string, body: string, threadRootId: string | null = null): Promise<string> => {
    const res = await world.call<{ id: string }>(who, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, body, threadRootId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  };
  const send = (who: Persona, channel: string, message: string, body: Record<string, unknown> = {}) =>
    world.call<Dropped>(who, 'POST', `/api/channels/${channel}/messages/${message}/send-to-memory`, { confirmPrivate: false, teamOnly: false, thread: false, ...body });

  beforeAll(async () => {
    channelId = (await world.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'inbox-public' })).body.channel.id;
    privateId = (await world.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'inbox-private', private: true })).body.channel.id;
  });

  it('files one message, with who said it and when', async () => {
    const message = await post(omar, channelId, 'We decided to keep the nightly build at 02:00 UTC.');
    const res = await send(nadia, channelId, message);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item).toMatchObject({ origin: 'message', kind: 'markdown', name: expect.stringContaining('Message in #inbox-public') });
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    const text = await repoFile(filed.filedPaths[0]!);
    expect(text).toContain('We decided to keep the nightly build at 02:00 UTC.');
    expect(text).toContain('Omar');
  });

  it('files a whole thread when asked', async () => {
    const root = await post(omar, channelId, 'Should we move the standup?');
    await post(nadia, channelId, 'Yes, to 09:30 so the east coast can join.', root);
    const res = await send(nadia, channelId, root, { thread: true });
    expect(res.status).toBe(201);
    expect(res.body.item.name).toContain('Thread in #inbox-public');
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    const text = await repoFile(filed.filedPaths[0]!);
    expect(text).toContain('Should we move the standup?');
    expect(text).toContain('Yes, to 09:30 so the east coast can join.');
  });

  it('asks before sending a private channel’s message to the whole team', async () => {
    const message = await post(omar, privateId, 'The reorg is confidential until Friday.');
    const asked = await send(omar, privateId, message);
    expect(asked.status).toBe(409);
    expect(asked.body.error?.message).toContain('private');
    expect(asked.body.error?.message).toContain('Engineering');
    expect((await send(omar, privateId, message, { confirmPrivate: true })).status).toBe(201);
    // a person who cannot read the channel cannot send from it
    expect((await send(nadia, privateId, message, { confirmPrivate: true })).status).toBe(403);
  });

  it('refuses a deleted message, a direct message, a guest and an outsider', async () => {
    const message = await post(omar, channelId, 'Oops, wrong channel.');
    expect((await world.call(omar, 'DELETE', `/api/channels/${channelId}/messages/${message}`)).status).toBe(200);
    expect((await send(omar, channelId, message)).status).toBe(409);
    const dm = await world.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [nadia.personId] });
    const dmId = dm.body.dm.channel.id;
    const dmMessage = await post(omar, dmId, 'Just between us.');
    const refused = await send(nadia, dmId, dmMessage);
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toContain('team channel');
    const open = await post(omar, channelId, 'A message the guest can read once granted.');
    await world.grant(channelId, lena, 'read');
    expect((await send(lena, channelId, open)).status).toBe(403);
    expect((await send(sameera, channelId, open)).status).toBe(403);
  });
});

describe('what the platform can read', () => {
  it('reads a Word file into text and files it', async () => {
    const res = await upload(nadia, 'Q3 planning.docx', sampleDocx());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item.kind).toBe('docx');
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    const text = await repoFile(filed.filedPaths[0]!);
    expect(text).toContain('Write the runbook');
    expect(text).toContain('Ship the inbox & the board by October.');
  });

  it('says plainly why a file could not be read, and keeps the original for a retry', async () => {
    const res = await upload(nadia, 'broken.pdf', '%PDF-1.4 this is not really a pdf');
    expect(res.status).toBe(201);
    const failed = await settle(nadia, res.body.item.id, ['failed']);
    expect(failed.reason).toBeTruthy();
    expect(failed.reason).not.toMatch(/at \w+\.|Error:|undefined/);
    expect(failed.originalKept).toBe(true);
    expect((await events('memory.item.failed')).some((e) => e['itemId'] === failed.id && e['stage'] === 'extract')).toBe(true);
    // only a lead retries; it fails the same way because the file is the same
    expect((await world.call(nadia, 'POST', `/api/teams/engineering/inbox/items/${failed.id}/retry`)).status).toBe(403);
    expect((await world.call(omar, 'POST', `/api/teams/engineering/inbox/items/${first()}/retry`)).status).toBe(409);
    const retried = await world.call<{ item: Item }>(omar, 'POST', `/api/teams/engineering/inbox/items/${failed.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.item.state).toBe('queued');
    expect((await settle(nadia, failed.id, ['failed'])).attempts).toBeGreaterThanOrEqual(1);
  });

  it('keeps a picture and says it cannot be read yet', async () => {
    const res = await upload(nadia, 'whiteboard.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    expect(res.status).toBe(201);
    const failed = await settle(nadia, res.body.item.id, ['failed']);
    expect(failed.reason).toContain('Pictures cannot be read yet');
    expect(failed.originalKept).toBe(true);
  });

  it('files an email and gives each attachment an item of its own', async () => {
    const res = await upload(nadia, 'renewal.eml', sampleEml());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    expect(await repoFile(filed.filedPaths[0]!)).toContain('The renewal is due on 1 December');
    const children = await eventually(async () => {
      const all = await states(omar, '?limit=200');
      const mine = all.filter((i) => i.parentId === filed.id);
      return mine.length > 0 ? mine : false;
    }, 30_000, 'the attachment item');
    expect(children.find((c) => c.name === 'contract.pdf')).toMatchObject({ kind: 'pdf', droppedBy: filed.droppedBy, parentId: filed.id });
  });

  function first(): string {
    return filedId;
  }
  let filedId = '00000000-0000-4000-8000-000000000001';
  beforeAll(async () => {
    filedId = (await states(nadia, '?state=filed&limit=1'))[0]!.id;
  });
});

describe('holding', () => {
  const held = async (name: string, body: Uint8Array | string, wantReason: string): Promise<Item> => {
    const res = await upload(nadia, name, body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const it = await settle(nadia, res.body.item.id, ['held', 'filed', 'failed']);
    expect(it.state, `${name}: ${it.reason}`).toBe('held');
    expect(it.holdReason).toBe(wantReason);
    return it;
  };

  it('a team that asks to review everything holds each drop; the dropper and the lead see it, a lead releases it, and it is then filed', async () => {
    await setTeamMd('memory:\n  inbox:\n    review: all\n');
    resetDropLimits();
    const it = await held('Quarterly notes.md', '# Quarterly notes\n\nThe review-all team wants a lead to look at this first.\n', 'review_all');
    expect(it.reason).toContain('every drop');
    expect((await events('memory.item.held')).some((e) => e['itemId'] === it.id && e['reason'] === 'review_all')).toBe(true);
    expect((await states(omar, '?state=held')).map((i) => i.id)).toContain(it.id);
    // a member who is neither the dropper nor a lead does not see it
    expect((await world.call(sameera, 'GET', '/api/teams/engineering/inbox/items')).status).toBe(403);
    expect((await world.call(nadia, 'POST', `/api/teams/engineering/inbox/items/${it.id}/release`)).status).toBe(403);
    const released = await world.call<{ item: Item }>(omar, 'POST', `/api/teams/engineering/inbox/items/${it.id}/release`);
    expect(released.status).toBe(200);
    expect(released.body.item.state).toBe('queued');
    const filed = await settle(nadia, it.id, ['filed']);
    expect(filed.filedPaths).toHaveLength(1);
    expect((await events('memory.item.released')).map((e) => e['itemId'])).toContain(it.id);
    // releasing twice is refused
    expect((await world.call(omar, 'POST', `/api/teams/engineering/inbox/items/${it.id}/release`)).status).toBe(409);
  });

  it('a lead discards a held item: the original goes with it, and the same bytes can be dropped again', async () => {
    const body = '# Draft\n\nSomething nobody should keep.\n';
    const it = await held('Draft.md', body, 'review_all');
    const gone = await world.call<{ item: Item }>(omar, 'POST', `/api/teams/engineering/inbox/items/${it.id}/discard`);
    expect(gone.status).toBe(200);
    expect(gone.body.item).toMatchObject({ state: 'discarded', originalKept: false });
    expect((await events('memory.item.discarded')).map((e) => e['itemId'])).toContain(it.id);
    expect((await world.system((tx) => tx.query('SELECT 1 FROM app.memory_inbox_items WHERE id = $1 AND blob_key IS NOT NULL', [it.id]))).rowCount).toBe(0);
    expect((await world.call(omar, 'POST', `/api/teams/engineering/inbox/items/${it.id}/discard`)).status).toBe(409);
    expect((await world.call(nadia, 'POST', `/api/teams/engineering/inbox/items/${it.id}/discard`)).status).toBe(403);
    const again = await upload(nadia, 'Draft again.md', body);
    expect(again.body.duplicate).toBe(false);
  });

  it('holds what is too big for the team, and a bundle from elsewhere, whatever the team’s review setting', async () => {
    await setTeamMd('memory:\n  inbox:\n    review: none\n    maxBytes: 1500\n');
    resetDropLimits();
    const big = await held('Long minutes.md', `# Long minutes\n\n${'The meeting went on. '.repeat(120)}\n`, 'oversize');
    expect(big.reason).toContain('larger than');
    const bundle = await held('shared-memory.zip', buildZip([{ name: 'index.md', data: '# bundle' }]), 'foreign_bundle');
    expect(bundle.kind).toBe('bundle');
    // under review: none a normal drop goes straight through
    const small = await upload(nadia, 'Small.md', '# Small\n\nNo review needed here.\n');
    expect((await settle(nadia, small.body.item.id, ['filed'])).state).toBe('filed');
  });

  it('reads a settings block it cannot understand as the strictest answer, never as no settings', async () => {
    await setTeamMd('memory:\n  inbox:\n    review: sometimes\n');
    resetDropLimits();
    const it = await held('Typo team.md', '# Typo team\n\nA mistyped setting must not loosen the rules.\n', 'review_all');
    expect(it.reason).toContain('could not be read');
    await setTeamMd('name: Engineering\n');
  });
});
