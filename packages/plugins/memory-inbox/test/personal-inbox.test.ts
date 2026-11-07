import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo, PluginContext } from '@manythreads/sdk';
import { eventually, ensureChannels } from '../../channels/test/world.ts';
import { createWorld, personas, type FilesWorld, type Persona } from '../../files/test/world.ts';
import { personalFileStep, personalHoldVerdict, personalReferencePath, personalSweep } from '../src/personal.ts';
import { resetDropLimits } from '../src/upload.ts';
import { sampleDocx } from './zipkit.ts';

// P20-04 through the real server: a person drops a file, a note or a chat message into their OWN inbox; the platform reads it and files a Reference in their Personal
// memory (no model, no team); only the owner sees any of it; Send to team drops a copy into a team's inbox as the person.

const { omar, nadia, rafi, sameera, lena } = personas;
vi.setConfig({ testTimeout: 120_000 });

let world: FilesWorld;
let since = new Date(0);

interface Item {
  id: string;
  personId: string;
  space: string;
  teamId?: string;
  origin: string;
  state: string;
  kind: string;
  name: string;
  size: number;
  droppedBy: string | null;
  droppedByName: string | null;
  reason: string | null;
  holdReason: string | null;
  duplicateOf: string | null;
  filedPaths: string[];
  originalKept: boolean;
  attempts: number;
}
interface Dropped {
  item: Item;
  duplicate: boolean;
  error?: { message: string };
}

const headersOf = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });
const upload = async (who: Persona | null, name: string, body: Uint8Array | string): Promise<{ status: number; body: Dropped }> => {
  const res = await fetch(`${world.server.url}/api/me/inbox/items?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { ...(who ? headersOf(who) : {}), 'content-type': 'application/octet-stream' },
    body: (typeof body === 'string' ? Buffer.from(body) : body) as unknown as RequestInit['body'],
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const note = (who: Persona, payload: Record<string, unknown>) => world.call<Dropped>(who, 'POST', '/api/me/inbox/notes', payload);
const getItem = async (who: Persona, id: string): Promise<Item> => (await world.call<{ item: Item }>(who, 'GET', `/api/me/inbox/items/${id}`)).body.item;
const list = async (who: Persona, query = ''): Promise<Item[]> => (await world.call<{ items: Item[] }>(who, 'GET', `/api/me/inbox/items${query}`)).body.items;
const settle = (who: Persona, id: string, wanted: string[]): Promise<Item> =>
  eventually(async () => {
    const it = await getItem(who, id);
    return wanted.includes(it.state) ? it : false;
  }, 60_000, `the item to settle (${wanted.join('/')})`);
const memoryFile = async (who: Persona, path: string): Promise<string> => {
  const res = await world.call<{ file: { content: string } }>(who, 'GET', `/api/me/memory/file?path=${encodeURIComponent(path)}`);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.file.content;
};
const events = async (type: string): Promise<Array<Record<string, unknown>>> =>
  (await world.system((tx) => tx.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM app.events WHERE type = $1 AND occurred_at >= $2 ORDER BY id`, [type, since]))).rows.map((r) => r.payload);

beforeAll(async () => {
  world = await createWorld();
  await ensureChannels(world);
  since = (await world.system((tx) => tx.query<{ now: Date }>('SELECT clock_timestamp() AS now'))).rows[0]!.now;
}, 180_000);

beforeEach(() => {
  resetDropLimits();
});

afterAll(async () => {
  await world?.close();
});

describe('dropping a file into your own inbox', () => {
  const MD = '# My reading list\n\nStart with the SRE book, then the Postgres internals notes.\n';
  let first = '';

  it('is read and filed as a Reference in the person’s own Memory, with no team in the way', async () => {
    const res = await upload(nadia, 'Reading list.md', MD);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.duplicate).toBe(false);
    expect(res.body.item).toMatchObject({ personId: nadia.personId, space: `person:${nadia.personId}`, origin: 'person', kind: 'markdown', state: 'queued', name: 'Reading list.md', originalKept: true, droppedByName: 'Nadia' });
    expect(res.body.item.teamId).toBeUndefined();
    first = res.body.item.id;
    const filed = await settle(nadia, first, ['filed']);
    expect(filed.filedPaths).toHaveLength(1);
    expect(filed.filedPaths[0]).toBe(personalReferencePath({ id: first, name: 'Reading list.md' }, 'My reading list'));
    const concept = await memoryFile(nadia, filed.filedPaths[0]!);
    expect(concept).toContain('type: Reference');
    expect(concept).toContain('origin: drop');
    expect(concept).toContain('Start with the SRE book');
    // it is in the person's Memory list as a Personal concept
    const concepts = await world.call<{ items: Array<{ path: string; space: string; type: string }> }>(nadia, 'GET', '/api/me/memory/concepts');
    expect(concepts.body.items.find((c) => c.path === filed.filedPaths[0])).toMatchObject({ type: 'Reference', space: `person:${nadia.personId}` });
    const changed = (await events('memory.personal_item.changed')).filter((e) => e['itemId'] === first);
    expect(changed.map((e) => e['state'])).toEqual(['queued', 'filed']);
    expect(changed[0]).toMatchObject({ personId: nadia.personId, kind: 'markdown', duplicate: false });
    // the event carries ids and sizes, never the name or the text
    expect(JSON.stringify(changed)).not.toContain('Reading list');
  });

  it('the same bytes again are a duplicate: nothing is written twice', async () => {
    const again = await upload(nadia, 'copy of list.md', MD);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.item).toMatchObject({ state: 'duplicate', duplicateOf: first, originalKept: false });
    // another person dropping the same bytes is not a duplicate: inboxes are separate
    const rafis = await upload(rafi, 'list.md', MD);
    expect(rafis.status).toBe(201);
    expect(rafis.body.duplicate).toBe(false);
  });

  it('is seen by its owner alone: not a teammate, an admin, a guest, an outsider or nobody', async () => {
    expect((await list(nadia)).map((i) => i.id)).toContain(first);
    expect((await list(rafi)).map((i) => i.id)).not.toContain(first);
    expect((await list(omar)).map((i) => i.id)).not.toContain(first);
    expect((await world.call(omar, 'GET', `/api/me/inbox/items/${first}`)).status).toBe(404);
    expect((await world.call(rafi, 'GET', `/api/me/inbox/items/${first}`)).status).toBe(404);
    expect((await world.call(lena, 'GET', '/api/me/inbox/items')).status).toBe(403);
    expect((await world.call(null, 'GET', '/api/me/inbox/items')).status).toBe(401);
    const mine = await world.call<{ items: Item[]; maxBytes: number }>(nadia, 'GET', '/api/me/inbox/items');
    expect(mine.body.maxBytes).toBe(25 * 1024 * 1024);
  });

  it('refuses a guest, a kind it cannot take, a missing name, an empty file, and too large a file', async () => {
    expect((await upload(lena, 'a.md', 'words')).status).toBe(403);
    expect((await upload(nadia, 'tool.exe', 'MZ')).status).toBe(415);
    expect((await upload(nadia, 'empty.md', '')).status).toBe(400);
    const noName = await fetch(`${world.server.url}/api/me/inbox/items`, { method: 'POST', headers: { ...headersOf(nadia), 'content-type': 'application/octet-stream' }, body: 'x' });
    expect(noName.status).toBe(400);
    const before = process.env['MANYTHREADS_INBOX_MAX_BYTES'];
    process.env['MANYTHREADS_INBOX_MAX_BYTES'] = '1000';
    try {
      expect((await upload(nadia, 'big.md', 'x'.repeat(5000))).status).toBe(413);
    } finally {
      if (before === undefined) delete process.env['MANYTHREADS_INBOX_MAX_BYTES'];
      else process.env['MANYTHREADS_INBOX_MAX_BYTES'] = before;
    }
  });

  it('reads a Word file into text', async () => {
    const res = await upload(nadia, 'Q3 planning.docx', sampleDocx());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    expect(await memoryFile(nadia, filed.filedPaths[0]!)).toContain('Write the runbook');
  });

  it('says plainly why a file could not be read, keeps the original, and a retry runs the same step again', async () => {
    const res = await upload(nadia, 'broken.pdf', '%PDF-1.4 this is not really a pdf');
    const failed = await settle(nadia, res.body.item.id, ['failed']);
    expect(failed.reason).toBeTruthy();
    expect(failed.reason).not.toMatch(/at \w+\.|Error:|undefined/);
    expect(failed.originalKept).toBe(true);
    expect((await world.call(rafi, 'POST', `/api/me/inbox/items/${failed.id}/retry`)).status).toBe(404);
    expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${first}/retry`)).status).toBe(409);
    const retried = await world.call<{ item: Item }>(nadia, 'POST', `/api/me/inbox/items/${failed.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.item.state).toBe('queued');
    expect((await settle(nadia, failed.id, ['failed'])).attempts).toBeGreaterThanOrEqual(1);
    // a failed item can be thrown away, and its original goes with it
    const thrown = await world.call<{ item: Item }>(nadia, 'POST', `/api/me/inbox/items/${failed.id}/discard`);
    expect(thrown.status).toBe(200);
    expect(thrown.body.item).toMatchObject({ state: 'discarded', originalKept: false });
  });

  it('keeps a picture and says it cannot be read yet', async () => {
    const res = await upload(nadia, 'whiteboard.png', new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));
    const failed = await settle(nadia, res.body.item.id, ['failed']);
    expect(failed.reason).toContain('Pictures cannot be read yet');
  });
});

describe('a note', () => {
  it('is filed with its title, and a web address alone is kept as a link and never fetched', async () => {
    const res = await note(nadia, { title: 'Standup habits', text: 'Say what you will do today, not what you did.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    expect(await memoryFile(nadia, filed.filedPaths[0]!)).toContain('Say what you will do today');
    const link = await note(nadia, { text: 'https://example.invalid/never-fetched' });
    expect(link.body.item.kind).toBe('link');
    const linked = await settle(nadia, link.body.item.id, ['filed']);
    expect(await memoryFile(nadia, linked.filedPaths[0]!)).toContain('https://example.invalid/never-fetched');
  });

  it('refuses an empty note, an unknown field, a guest and nobody', async () => {
    expect((await note(nadia, { text: '   ' })).status).toBe(400);
    expect((await note(nadia, { text: 'x', teamOnly: true })).status).toBe(400);
    expect((await note(lena, { text: 'words' })).status).toBe(403);
    expect((await world.call(null, 'POST', '/api/me/inbox/notes', { text: 'x' })).status).toBe(401);
  });
});

describe('holding', () => {
  it('holds a memory bundle from elsewhere for the owner; releasing it lets it through to the read, which says the bundle cannot be imported here', async () => {
    const res = await upload(rafi, 'someones-memory.zip', 'PK\u0003\u0004 not really');
    const held = await settle(rafi, res.body.item.id, ['held']);
    expect(held.holdReason).toBe('foreign_bundle');
    expect(held.reason).toContain('bundle');
    // only the owner decides
    expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${held.id}/release`)).status).toBe(404);
    expect((await world.call(rafi, 'POST', `/api/me/inbox/items/${held.id}/retry`)).status).toBe(409);
    const released = await world.call<{ item: Item }>(rafi, 'POST', `/api/me/inbox/items/${held.id}/release`);
    expect(released.status).toBe(200);
    expect(released.body.item.state).toBe('queued');
    const failed = await settle(rafi, held.id, ['failed', 'held']);
    expect(failed.state).toBe('failed');
    expect(failed.reason).toContain('bundle');
  });

  it('lets the owner discard a held item, and the original goes with it', async () => {
    const res = await upload(rafi, 'another.zip', 'PK\u0003\u0004 other');
    const held = await settle(rafi, res.body.item.id, ['held']);
    const gone = await world.call<{ item: Item }>(rafi, 'POST', `/api/me/inbox/items/${held.id}/discard`);
    expect(gone.status).toBe(200);
    expect(gone.body.item).toMatchObject({ state: 'discarded', originalKept: false });
    expect((await world.call(rafi, 'POST', `/api/me/inbox/items/${held.id}/discard`)).status).toBe(409);
    expect((await world.call(rafi, 'POST', `/api/me/inbox/items/${held.id}/release`)).status).toBe(409);
    expect((await list(rafi)).map((i) => i.id)).not.toContain(held.id);
    expect((await list(rafi, '?state=discarded')).map((i) => i.id)).toContain(held.id);
  });

  it('holds nothing for “review”: the owner is the reviewer', () => {
    expect(personalHoldVerdict({ kind: 'markdown', size: 10 }, false)).toBeNull();
    expect(personalHoldVerdict({ kind: 'bundle', size: 10 }, false)).toMatchObject({ reason: 'foreign_bundle' });
    expect(personalHoldVerdict({ kind: 'pdf', size: 26 * 1024 * 1024 }, false)).toMatchObject({ reason: 'oversize' });
    expect(personalHoldVerdict({ kind: 'bundle', size: 26 * 1024 * 1024 }, true)).toBeNull();
    expect(personalHoldVerdict({ kind: 'markdown', size: 2000 }, false, 1000)).toMatchObject({ reason: 'oversize' });
  });
});

describe('send to team', () => {
  let filedId = '';
  beforeAll(async () => {
    const res = await note(nadia, { title: 'Onboarding tips', text: 'Pair the new person with a buddy for the first two weeks.' });
    filedId = (await settle(nadia, res.body.item.id, ['filed'])).id;
  });

  it('drops a copy of the original into the team’s inbox as the person; the personal item stays', async () => {
    const sent = await world.call<{ teamItemId: string; duplicate: boolean }>(nadia, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'engineering', teamOnly: true });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.duplicate).toBe(false);
    const team = await world.call<{ item: { id: string; teamId: string; origin: string; teamOnly: boolean; droppedByName: string } }>(nadia, 'GET', `/api/teams/engineering/inbox/items/${sent.body.teamItemId}`);
    expect(team.status).toBe(200);
    expect(team.body.item).toMatchObject({ origin: 'person', teamOnly: true, droppedByName: 'Nadia' });
    // the team's own pipeline takes it from here
    await eventually(async () => ((await world.call<{ item: { state: string } }>(nadia, 'GET', `/api/teams/engineering/inbox/items/${sent.body.teamItemId}`)).body.item.state === 'filed' ? true : false), 60_000, 'the team item to be filed');
    expect((await getItem(nadia, filedId)).state).toBe('filed');
    // the same bytes again are the team's duplicate, not a second filing
    const again = await world.call<{ teamItemId: string; duplicate: boolean }>(nadia, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'engineering', teamOnly: false });
    expect(again.body.duplicate).toBe(true);
  });

  it('refuses a team the person is not on, a guest, an item that is not theirs, a held, discarded or duplicate item, and an unknown field', async () => {
    expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'customer-support', teamOnly: false })).status).toBeGreaterThanOrEqual(403);
    expect((await world.call(rafi, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'engineering', teamOnly: false })).status).toBe(404);
    expect((await world.call(lena, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'engineering', teamOnly: false })).status).toBe(403);
    expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${filedId}/send-to-team`, { teamSlug: 'engineering', teamOnly: false, everyone: true })).status).toBe(400);
    const dup = (await list(nadia)).find((i) => i.state === 'duplicate');
    if (dup) expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${dup.id}/send-to-team`, { teamSlug: 'engineering', teamOnly: false })).status).toBe(409);
    const gone = (await list(nadia, '?state=discarded'))[0];
    if (gone) expect((await world.call(nadia, 'POST', `/api/me/inbox/items/${gone.id}/send-to-team`, { teamSlug: 'engineering', teamOnly: false })).status).toBe(409);
  });
});

describe('send to memory, to your own inbox', () => {
  let channelId = '';
  const post = async (who: Persona, channel: string, body: string, threadRootId: string | null = null): Promise<string> => {
    const res = await world.call<{ id: string }>(who, 'POST', `/api/channels/${channel}/messages`, { channelId: channel, body, threadRootId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  };
  const send = (who: Persona, channel: string, message: string, body: Record<string, unknown> = {}) =>
    world.call<Dropped>(who, 'POST', `/api/channels/${channel}/messages/${message}/send-to-memory`, { target: 'personal', thread: false, ...body });

  beforeAll(async () => {
    channelId = (await world.call<{ channel: { id: string } }>(omar, 'POST', '/api/teams/engineering/channels', { name: 'personal-copies' })).body.channel.id;
  });

  it('files a message in the person’s own inbox, with who said it, and the team never sees it', async () => {
    const message = await post(omar, channelId, 'Remember: the staging database is refreshed every Monday.');
    const res = await send(nadia, channelId, message);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.item).toMatchObject({ personId: nadia.personId, origin: 'message', kind: 'markdown', name: expect.stringContaining('Message in #personal-copies') });
    const filed = await settle(nadia, res.body.item.id, ['filed']);
    const text = await memoryFile(nadia, filed.filedPaths[0]!);
    expect(text).toContain('staging database is refreshed every Monday');
    expect(text).toContain('Omar');
    const teamInbox = await world.call<{ items: Array<{ name: string }> }>(omar, 'GET', '/api/teams/engineering/inbox/items?limit=200');
    expect(teamInbox.body.items.some((i) => i.name.includes('personal-copies'))).toBe(false);
  });

  it('takes a whole thread, and a direct message the person is in (a copy for them alone)', async () => {
    const root = await post(omar, channelId, 'Which region do we fail over to?');
    await post(nadia, channelId, 'eu-west, then us-east.', root);
    const thread = await send(nadia, channelId, root, { thread: true });
    expect(thread.status).toBe(201);
    const filed = await settle(nadia, thread.body.item.id, ['filed']);
    expect(await memoryFile(nadia, filed.filedPaths[0]!)).toContain('eu-west, then us-east.');
    const dm = (await world.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [nadia.personId] })).body.dm.channel.id;
    const dmMessage = await post(omar, dm, 'Between us: the offer is approved.');
    const fromDm = await send(nadia, dm, dmMessage);
    expect(fromDm.status, JSON.stringify(fromDm.body)).toBe(201);
    expect(await memoryFile(nadia, (await settle(nadia, fromDm.body.item.id, ['filed'])).filedPaths[0]!)).toContain('the offer is approved');
  });

  it('refuses a message the person cannot read, a deleted message, a guest and nobody; the team target still answers a team item', async () => {
    const dm = (await world.call<{ dm: { channel: { id: string } } }>(omar, 'POST', '/api/dms', { personIds: [rafi.personId] })).body.dm.channel.id;
    const secret = await post(omar, dm, 'Not for Nadia.');
    expect((await send(nadia, dm, secret)).status).toBe(403);
    const gone = await post(omar, channelId, 'Oops.');
    expect((await world.call(omar, 'DELETE', `/api/channels/${channelId}/messages/${gone}`)).status).toBe(200);
    expect((await send(nadia, channelId, gone)).status).toBe(409);
    const open = await post(omar, channelId, 'A message the guest may read once granted.');
    await world.grant(channelId, lena, 'read');
    expect((await send(lena, channelId, open)).status).toBe(403);
    expect((await send(sameera, channelId, open)).status).toBe(403);
    const team = await world.call<{ item: { teamId: string }; duplicate: boolean }>(nadia, 'POST', `/api/channels/${channelId}/messages/${open}/send-to-memory`, { confirmPrivate: false, teamOnly: false, thread: false });
    expect(team.status).toBe(201);
    expect(team.body.item.teamId).toBeTruthy();
  });
});

// ---- the steps by hand, with a stand-in for the guards and the sweep ---------------------------------------------------------------------

describe('the read-and-file step', () => {
  let n = 0;
  const NOW = new Date('2026-11-02T10:00:00Z');
  const enqueued: Array<{ queue: string; payload: Record<string, unknown>; dedupeKey: string | undefined }> = [];
  let egress: { hooks: number; outcome: string; text: string; message?: string } = { hooks: 0, outcome: 'allow', text: '' };
  const seen: Array<{ mode: string | undefined; destination: string }> = [];
  const bytesOf = new Map<string, Uint8Array>();
  const ctx = {
    providers: {
      get: (kind: string): unknown =>
        kind === 'storage'
          ? {
              id: 'storage',
              async get(key: string): Promise<AsyncIterable<Uint8Array>> {
                const bytes = bytesOf.get(key);
                if (!bytes) throw new Error('gone');
                return (async function* () {
                  yield bytes;
                })();
              },
              async delete(): Promise<boolean> {
                return true;
              },
            }
          : undefined,
    },
    jobs: {
      async enqueue(_tx: unknown, queue: string, payload: Record<string, unknown>, opts?: { dedupeKey?: string }): Promise<void> {
        enqueued.push({ queue, payload, dedupeKey: opts?.dedupeKey });
      },
    },
    audit: { async emit(): Promise<void> {} },
    hooks: {
      async runPreEgress(_tx: unknown, input: { mode?: string; destination: string }): Promise<typeof egress> {
        seen.push({ mode: input.mode, destination: input.destination });
        return egress;
      },
    },
    runtime: { now: () => NOW },
  } as unknown as PluginContext;
  const job = {
    transaction: <T>(fn: (tx: never) => Promise<T>): Promise<T> => world.system(fn as never),
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
  } as unknown as JobInfo;

  async function seedItem(over: { text?: string; state?: string; stage?: string; released?: boolean; attempts?: number; ageMinutes?: number } = {}, inTx?: Parameters<Parameters<typeof world.system>[0]>[0]): Promise<string> {
    n += 1;
    const text = over.text ?? `# Seeded ${n}\n\nSome words ${n}.\n`;
    const key = `seed-blob-${Date.now()}-${n}`;
    bytesOf.set(key, new TextEncoder().encode(text));
    const run = async (tx: Parameters<Parameters<typeof world.system>[0]>[0]): Promise<string> => {
      const id = (
        await tx.query<{ id: string }>(
          `INSERT INTO app.memory_personal_inbox_items (workspace_id, owner_person_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, released_at, attempts, updated_at)
           VALUES ($1, $2, 'person', $3, $4, 'markdown', $5, $6, lpad(to_hex($7::int + 424242), 64, '0'), $8, $9, 'Rafi', CASE WHEN $10 THEN now() END, $11, now() - make_interval(mins => $12)) RETURNING id`,
          [rafi.workspaceId, rafi.personId, over.state ?? 'queued', over.stage ?? 'extract', `seeded-${n}.md`, text.length, n, key, rafi.actorId, over.released === true, over.attempts ?? 0, over.ageMinutes ?? 0],
        )
      ).rows[0]!.id;
      return id;
    };
    return inTx ? run(inTx) : world.system(run);
  }
  const row = async (id: string): Promise<{ state: string; hold_reason: string | null; reason: string | null; filed_paths: string[]; stage: string; attempts: number }> =>
    (await world.system((tx) => tx.query<{ state: string; hold_reason: string | null; reason: string | null; filed_paths: string[]; stage: string; attempts: number }>('SELECT state, hold_reason, reason, filed_paths, stage, attempts FROM app.memory_personal_inbox_items WHERE id = $1', [id]))).rows[0]!;
  const fileText = async (path: string): Promise<string | undefined> =>
    (await world.system((tx) => tx.query<{ content: string }>('SELECT content FROM app.memory_personal_files WHERE owner_person_id = $1 AND path = $2', [rafi.personId, path]))).rows[0]?.content;

  beforeEach(() => {
    egress = { hooks: 0, outcome: 'allow', text: '' };
    seen.length = 0;
    enqueued.length = 0;
  });

  it('holds an item the workspace’s guards want approved, and files nothing', async () => {
    egress = { hooks: 1, outcome: 'require_approval', text: 'x' };
    const id = await seedItem({ text: 'My card is 4111 1111 1111 1111' });
    await personalFileStep(ctx, job, id);
    expect(await row(id)).toMatchObject({ state: 'held', hold_reason: 'dlp', filed_paths: [] });
    expect(seen).toEqual([{ mode: 'hold', destination: 'memory_inbox' }]);
    expect((await row(id)).reason).toContain('private data');
  });

  it('files it once the owner has released it (the guards are asked in “approved” mode), as written', async () => {
    egress = { hooks: 1, outcome: 'allow', text: 'unused' };
    const id = await seedItem({ text: 'Released text about nothing in particular.', released: true });
    await personalFileStep(ctx, job, id);
    const done = await row(id);
    expect(done).toMatchObject({ state: 'filed', stage: 'done' });
    expect(seen).toEqual([{ mode: 'approved', destination: 'memory_inbox' }]);
    expect(await fileText(done.filed_paths[0]!)).toContain('Released text about nothing in particular.');
  });

  it('fails an item the guards block, with their sentence', async () => {
    egress = { hooks: 1, outcome: 'block', text: '', message: 'The data rules say no.' };
    const id = await seedItem();
    await personalFileStep(ctx, job, id);
    expect(await row(id)).toMatchObject({ state: 'failed', reason: 'The data rules say no.', filed_paths: [] });
  });

  it('files the redacted text when the guards redact', async () => {
    egress = { hooks: 1, outcome: 'redact', text: 'Call me on [redacted].' };
    const id = await seedItem({ text: 'Call me on 555-0100.' });
    await personalFileStep(ctx, job, id);
    const done = await row(id);
    expect(done.state).toBe('filed');
    const text = await fileText(done.filed_paths[0]!);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('555-0100');
  });

  it('does nothing twice and nothing out of turn: a filed, discarded or wrong-stage item is left alone', async () => {
    const id = await seedItem({ text: 'Only once.' });
    await personalFileStep(ctx, job, id);
    const once = await row(id);
    await personalFileStep(ctx, job, id);
    expect(await row(id)).toEqual(once);
    const early = await seedItem({ stage: 'hold' });
    await personalFileStep(ctx, job, early);
    expect(await row(early)).toMatchObject({ state: 'queued', stage: 'hold' });
  });

  it('fails an item whose original is gone, with a plain sentence', async () => {
    const id = await seedItem();
    await world.system((tx) => tx.query(`UPDATE app.memory_personal_inbox_items SET blob_key = 'missing-blob' WHERE id = $1`, [id]));
    await personalFileStep(ctx, job, id);
    const r = await row(id);
    expect(r.state).toBe('failed');
    expect(r.reason).toContain('could not be read');
  });

  it('the sweep puts a stuck item back, gives up after too many tries, and re-queues a due one', async () => {
    // all inside one transaction that is rolled back, so the server's own sweep never sees these rows
    const out: { moved: number; states: Record<string, string>; queued: unknown[] } = { moved: 0, states: {}, queued: [] };
    await world
      .system(async (tx) => {
        const stuck = await seedItem({ state: 'extracting', ageMinutes: 45, attempts: 1 }, tx);
        const tired = await seedItem({ state: 'extracting', ageMinutes: 45, attempts: 5 }, tx);
        const due = await seedItem({ state: 'queued', stage: 'extract', ageMinutes: 10 }, tx);
        const fresh = await seedItem({ state: 'queued', stage: 'extract', ageMinutes: 0 }, tx);
        out.moved = await personalSweep(ctx, tx);
        for (const [k, id] of Object.entries({ stuck, tired, due, fresh })) out.states[k] = (await tx.query<{ state: string }>('SELECT state FROM app.memory_personal_inbox_items WHERE id = $1', [id])).rows[0]!.state;
        out.queued = enqueued.map((e) => ({ id: e.payload['itemId'], queue: e.queue, dedupeKey: e.dedupeKey, which: [due, fresh].indexOf(String(e.payload['itemId'])) }));
        throw new Error('roll back');
      })
      .catch((e: Error) => {
        if (e.message !== 'roll back') throw e;
      });
    expect(out.moved).toBe(3);
    expect(out.states).toEqual({ stuck: 'queued', tired: 'failed', due: 'queued', fresh: 'queued' });
    // the due one was queued again (the file step), the fresh one was left for its own job
    expect(out.queued).toHaveLength(1);
    expect(out.queued[0]).toMatchObject({ queue: 'memory-inbox.personal-file', which: 0 });
  });
});
