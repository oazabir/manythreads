import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  linkPreviewMigrationSource,
  personaActor,
  personas,
  TEAM_IDS,
  teamsMigrationSource,
  testClient,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, tariq, priya } = personas;

// Who reads and writes what (pnpm test:rls). A card is readable with its message's channel; the author of the message, a manager of its channel (the
// lead of its team) and a workspace admin may mark it removed (and nothing else about it); the fetch job (the system role) creates and deletes
// cards. The cache is not readable by requests at all. A picture is readable only through a card the caller can read. The settings are readable by
// every member of the workspace and written by workspace owners and admins.

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);

let openChannel = '';
let privateChannel = '';
let marketingChannel = '';
let nadiaMessage = '';
let omarMessage = '';
let privateMessage = '';
let nadiaCard = '';
let omarCard = '';
let privateCard = '';
let imageId = '';

const newChannel = (name: string, isPrivate: boolean, members: Persona[], team: string = TEAM_IDS.Engineering): Promise<string> =>
  sys(async (tx) => {
    const id = (
      await tx.query<{ id: string }>(
        'INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [omar.workspaceId, team, name, 'channel', isPrivate, omar.actorId],
      )
    ).rows[0]!.id;
    for (const m of members) await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [id, m.personId]);
    return id;
  });
const newMessage = (channel: string, author: Persona): Promise<string> =>
  sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'x', 'x') RETURNING id", [omar.workspaceId, channel, author.actorId])).rows[0]!.id);
const newCard = (channel: string, message: string, url: string, image: string | null = null): Promise<string> =>
  sys(async (tx) =>
    (
      await tx.query<{ id: string }>(
        "INSERT INTO app.link_previews (workspace_id, channel_id, message_id, url, host, title, image_id) VALUES ($1, $2, $3, $4, 'a.example', 'T', $5) RETURNING id",
        [omar.workspaceId, channel, message, url, image],
      )
    ).rows[0]!.id,
  );

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, linkPreviewMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  openChannel = await newChannel('lp-open', false, []);
  privateChannel = await newChannel('lp-private', true, [omar]);
  marketingChannel = await newChannel('lp-marketing', false, [], TEAM_IDS.Marketing);
  nadiaMessage = await newMessage(openChannel, nadia);
  omarMessage = await newMessage(openChannel, omar);
  privateMessage = await newMessage(privateChannel, omar);
  imageId = await sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2) RETURNING id", [omar.workspaceId, PNG])).rows[0]!.id);
  nadiaCard = await newCard(openChannel, nadiaMessage, 'https://a.example/n', imageId);
  omarCard = await newCard(openChannel, omarMessage, 'https://a.example/o');
  privateCard = await newCard(privateChannel, privateMessage, 'https://a.example/p');
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the link-preview tables pass the RLS harness', () => {
  it('RLS is enabled and forced on all four tables, with policies and an rls comment; no policy calls a per-row helper', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of ['link_previews', 'link_preview_images', 'link_preview_cache', 'link_preview_settings']) {
        expect(await findPerRowPolicyCalls(admin, table), table).toEqual([]);
        const plan = await admin.query('SELECT relrowsecurity AS on, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass', [`app.${table}`]);
        expect(plan.rows[0], table).toEqual({ on: true, forced: true });
      }
    } finally {
      await admin.end();
    }
  });
});

describe('a card is read with its message\'s channel', () => {
  it('a reader of the channel sees the cards of its messages', async () => {
    const ids = (await q<{ id: string }>(rafi, 'SELECT id FROM app.link_previews WHERE channel_id = $1', [openChannel])).map((r) => r.id);
    expect(ids.sort()).toEqual([nadiaCard, omarCard].sort());
  });

  it('a person who cannot read a private channel sees none of its cards', async () => {
    expect(await q(nadia, 'SELECT id FROM app.link_previews WHERE id = $1', [privateCard])).toEqual([]);
    expect((await q(omar, 'SELECT id FROM app.link_previews WHERE id = $1', [privateCard])).length).toBe(1);
  });
});

describe('the author, a channel manager and a workspace admin remove a card, and change nothing else', () => {
  const remove = (p: Persona, card: string, removedBy: Persona = p) =>
    as(p, (tx) => tx.query('UPDATE app.link_previews SET removed_at = now(), removed_by = $2 WHERE id = $1 RETURNING id', [card, removedBy.actorId]));

  it('another reader of the channel who is neither author, manager nor admin cannot', async () => {
    expect((await remove(rafi, nadiaCard)).rows).toHaveLength(0);
  });

  it('the lead of another team cannot (a team channel is managed by its own team\'s lead)', async () => {
    expect((await remove(tariq, nadiaCard)).rows).toHaveLength(0);
  });

  it('the author cannot put someone else\'s name on the removal', async () => {
    expect(await code(remove(nadia, nadiaCard, rafi))).toBe('42501');
  });

  it('a workspace admin can remove a card of somebody else\'s message', async () => {
    const m = await newMessage(openChannel, nadia);
    const card = await newCard(openChannel, m, 'https://a.example/admin-removes');
    expect((await remove(omar, card)).rows).toHaveLength(1);
    const row = (await sys((tx) => tx.query<{ removed_by: string }>('SELECT removed_by FROM app.link_previews WHERE id = $1', [card]))).rows[0];
    expect(row?.removed_by).toBe(omar.actorId);
  });

  it('the lead of the channel\'s team, who is neither admin nor author, can', async () => {
    const m = await newMessage(marketingChannel, priya);
    const card = await newCard(marketingChannel, m, 'https://a.example/lead-removes');
    expect((await remove(tariq, card)).rows).toHaveLength(1);
    const row = (await sys((tx) => tx.query<{ removed_by: string }>('SELECT removed_by FROM app.link_previews WHERE id = $1', [card]))).rows[0];
    expect(row?.removed_by).toBe(tariq.actorId);
  });

  it('a member of the channel\'s team who is not the author cannot', async () => {
    const m = await newMessage(marketingChannel, tariq);
    const card = await newCard(marketingChannel, m, 'https://a.example/member-cannot');
    expect((await remove(priya, card)).rows).toHaveLength(0);
  });

  it('the author can, once', async () => {
    expect((await remove(nadia, nadiaCard)).rows).toHaveLength(1);
    const row = (await sys((tx) => tx.query<{ removed_by: string }>('SELECT removed_by FROM app.link_previews WHERE id = $1', [nadiaCard]))).rows[0];
    expect(row?.removed_by).toBe(nadia.actorId);
  });

  it('cannot reach a card of a channel they cannot read, even as an author of nothing there', async () => {
    expect((await remove(nadia, privateCard)).rows).toHaveLength(0);
  });

  it('cannot change the title, the address or the picture (no column grant)', async () => {
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.link_previews SET title = 'changed' WHERE id = $1", [omarCard])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query("UPDATE app.link_previews SET url = 'http://b.example/' WHERE id = $1", [omarCard])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('UPDATE app.link_previews SET image_id = NULL WHERE id = $1', [omarCard])))).toBe('42501');
  });

  it('cannot create or delete a card', async () => {
    expect(
      await code(
        as(omar, (tx) =>
          tx.query("INSERT INTO app.link_previews (workspace_id, channel_id, message_id, url, host) VALUES ($1, $2, $3, 'https://x.example/', 'x.example')", [omar.workspaceId, openChannel, omarMessage]),
        ),
      ),
    ).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.link_previews WHERE id = $1', [omarCard])))).toBe('42501');
  });

  it('the system role can delete (a message loses its link)', async () => {
    const gone = await sys((tx) => tx.query('DELETE FROM app.link_previews WHERE id = $1 RETURNING id', [omarCard]));
    expect(gone.rows).toHaveLength(1);
  });
});

describe('the cache is the fetch job\'s alone', () => {
  it('a request cannot read or write it, an admin included', async () => {
    expect(await code(as(omar, (tx) => tx.query('SELECT 1 FROM app.link_preview_cache')))).toBe('42501');
    expect(
      await code(
        as(omar, (tx) =>
          tx.query("INSERT INTO app.link_preview_cache (workspace_id, url, status, expires_at) VALUES ($1, 'https://a.example/', 'ok', now())", [omar.workspaceId]),
        ),
      ),
    ).toBe('42501');
  });

  it('the system role can, and one address is one row per workspace', async () => {
    await sys((tx) => tx.query("INSERT INTO app.link_preview_cache (workspace_id, url, status, expires_at) VALUES ($1, 'https://a.example/c', 'ok', now() + interval '1 day')", [omar.workspaceId]));
    expect(
      await code(sys((tx) => tx.query("INSERT INTO app.link_preview_cache (workspace_id, url, status, expires_at) VALUES ($1, 'https://a.example/c', 'ok', now())", [omar.workspaceId]))),
    ).toBe('23505');
  });
});

describe('a picture is read only through a card the caller can read', () => {
  it('shows it to a reader of the channel (nadia\'s card was removed but the row stays for the job)', async () => {
    // omar's card has no picture; give the private channel's card one and check who sees it
    const privateImage = await sys(async (tx) => (await tx.query<{ id: string }>("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2) RETURNING id", [omar.workspaceId, PNG])).rows[0]!.id);
    await sys((tx) => tx.query('UPDATE app.link_previews SET image_id = $2 WHERE id = $1', [privateCard, privateImage]));
    expect(await q(omar, 'SELECT id FROM app.link_preview_images WHERE id = $1', [privateImage])).toHaveLength(1);
    expect(await q(nadia, 'SELECT id FROM app.link_preview_images WHERE id = $1', [privateImage])).toEqual([]);
    expect(imageId).not.toBe(privateImage);
  });

  it('a request cannot write, change or delete one', async () => {
    expect(await code(as(omar, (tx) => tx.query("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2)", [omar.workspaceId, PNG])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.link_preview_images WHERE id = $1', [imageId])))).toBe('42501');
  });

  it('only the five kinds, and at most 512 KiB, are accepted at all (even from the system role)', async () => {
    expect(await code(sys((tx) => tx.query("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/svg+xml', $2)", [omar.workspaceId, PNG])))).toBe('23514');
    expect(await code(sys((tx) => tx.query("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2)", [omar.workspaceId, Buffer.alloc(512 * 1024 + 1, 1)])))).toBe('23514');
    // exactly the limit is fine
    await sys((tx) => tx.query("INSERT INTO app.link_preview_images (workspace_id, content_type, bytes) VALUES ($1, 'image/png', $2)", [omar.workspaceId, Buffer.alloc(512 * 1024, 1)]));
  });
});

describe('the settings are read by every member and written by workspace owners and admins', () => {
  it('an admin writes and reads them; a member reads them (the routes judge a card\'s site by them) but writes nothing', async () => {
    await as(omar, (tx) =>
      tx.query("INSERT INTO app.link_preview_settings (workspace_id, enabled, allow, deny, updated_by) VALUES ($1, true, '{}', '{evil.example}', $2)", [omar.workspaceId, omar.actorId]),
    );
    expect((await q<{ deny: string[] }>(omar, 'SELECT deny FROM app.link_preview_settings'))[0]?.deny).toEqual(['evil.example']);
    expect((await q<{ deny: string[] }>(nadia, 'SELECT deny FROM app.link_preview_settings'))[0]?.deny).toEqual(['evil.example']);
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.link_preview_settings (workspace_id, enabled) VALUES ($1, false)", [nadia.workspaceId])))).toBe('42501');
    expect((await as(nadia, (tx) => tx.query('UPDATE app.link_preview_settings SET enabled = false RETURNING workspace_id'))).rows).toHaveLength(0);
  });
});
