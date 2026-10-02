import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
  findPerRowPolicyCalls,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  TEAM_IDS,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { omar, nadia, rafi, sameera, tariq, priya, lena } = personas;
const ALL = [omar, nadia, rafi, sameera, tariq, priya, lena] as const;
const TABLES = ['channel_groups', 'channels', 'channel_members', 'messages', 'message_reactions', 'message_mentions', 'threads', 'thread_follows', 'channel_template_syncs', 'presence', 'typing'];

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> =>
  as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

const ch: Record<string, string> = {};
const msg: Record<string, string> = {};

async function channel(name: string, team: string | null, opts: { kind?: string; private?: boolean; dmKey?: string; archived?: boolean } = {}): Promise<string> {
  return sys(async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO app.channels (workspace_id, team_id, name, kind, private, dm_key, archived_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [omar.workspaceId, team, opts.kind === 'dm' ? '' : name, opts.kind ?? 'channel', opts.private ?? opts.kind === 'dm', opts.dmKey ?? null, opts.archived ? new Date() : null],
    );
    return r.rows[0]!.id;
  });
}
const member = (channelId: string, p: Persona): Promise<unknown> =>
  sys((tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [channelId, p.personId]));
const grant = (channelId: string, p: Persona, permission: string): Promise<unknown> =>
  sys((tx) =>
    tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'person', $3, $4)`,
      [omar.workspaceId, channelId, p.personId, permission],
    ),
  );
const visible = async (p: Persona, permission = 'read'): Promise<string[]> => {
  const r = await q<{ ids: string[] }>(p, 'SELECT app.visible_channel_ids($1) AS ids', [permission]);
  return r[0]!.ids;
};
const names = async (p: Persona): Promise<string[]> => (await q<{ name: string }>(p, "SELECT name FROM app.channels WHERE kind = 'channel' ORDER BY name")).map((r) => r.name);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  const eng = TEAM_IDS.Engineering;
  const mkt = TEAM_IDS.Marketing;
  const sup = TEAM_IDS['Customer support'];
  ch['eng-general'] = await channel('eng-general', eng);
  ch['eng-releases'] = await channel('eng-releases', eng);
  ch['eng-leads'] = await channel('eng-leads', eng, { private: true });
  ch['eng-old'] = await channel('eng-old', eng, { archived: true });
  ch['mkt-general'] = await channel('mkt-general', mkt);
  ch['mkt-secret'] = await channel('mkt-secret', mkt, { private: true });
  ch['sup-general'] = await channel('sup-general', sup);
  ch['dm-nr'] = await channel('', null, { kind: 'dm', dmKey: `${nadia.personId}:${rafi.personId}` });
  await member(ch['eng-leads']!, omar);
  await member(ch['eng-leads']!, rafi);
  await member(ch['mkt-secret']!, tariq);
  await member(ch['dm-nr']!, nadia);
  await member(ch['dm-nr']!, rafi);
  await grant(ch['eng-releases']!, lena, 'read');
  const mk = async (key: string, channelId: string, author: Persona, body: string): Promise<void> => {
    msg[key] = await sys(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [omar.workspaceId, channelId, author.actorId, body],
    )).rows[0]!.id);
  };
  await mk('general', ch['eng-general']!, nadia, 'hello engineering');
  await mk('releases', ch['eng-releases']!, nadia, 'v1 shipped');
  await mk('leads', ch['eng-leads']!, omar, 'leads only');
  await mk('dm', ch['dm-nr']!, nadia, 'private chat');
  await mk('secret', ch['mkt-secret']!, tariq, 'campaign secret');
  await mk('old', ch['eng-old']!, nadia, 'archived talk');
}, 120_000);
afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the channels tables pass the RLS harness', () => {
  it('RLS is enabled and forced, with a policy and an rls comment, on every table', async () => {
    const admin = new pg.Client({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
      for (const table of TABLES) expect(await findPerRowPolicyCalls(admin, table), `${table} calls app.can per row`).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('who sees which channel (app.visible_channel_ids)', () => {
  it('a member sees the public channels of their teams; a private one only as a member; a DM only as a participant', async () => {
    expect(await names(nadia)).toEqual(['eng-general', 'eng-old', 'eng-releases']);
    expect(await names(rafi)).toEqual(['eng-general', 'eng-leads', 'eng-old', 'eng-releases']);
    expect(await names(omar)).toEqual(['eng-general', 'eng-leads', 'eng-old', 'eng-releases', 'mkt-general', 'sup-general']);
    expect(await names(tariq)).toEqual(['mkt-general', 'mkt-secret']);
    expect(await names(sameera)).toEqual(['sup-general']);
    expect(await names(priya)).toEqual(['eng-general', 'eng-old', 'eng-releases', 'mkt-general']);
  });

  it('Sameera cannot see any Engineering channel, message or reaction; Priya cannot see the private channel nor the DM', async () => {
    for (const key of ['general', 'releases', 'leads', 'dm', 'secret']) {
      expect(await q(sameera, 'SELECT id FROM app.messages WHERE id = $1', [msg[key]]), `sameera ${key}`).toEqual([]);
    }
    expect(await q(priya, 'SELECT id FROM app.messages WHERE id = ANY ($1::uuid[])', [[msg['leads'], msg['dm']]])).toEqual([]);
    expect((await q(priya, 'SELECT id FROM app.messages WHERE id = $1', [msg['general']])).length).toBe(1);
    expect((await q<{ n: number }>(sameera, 'SELECT count(*)::int AS n FROM app.messages'))[0]!.n).toBe(0);
  });

  it('a workspace admin reads the public channels of every team but not private channels or DMs of teams they are not in', async () => {
    expect(await visible(omar)).not.toContain(ch['mkt-secret']);
    expect(await visible(omar)).not.toContain(ch['dm-nr']);
    expect((await q(omar, 'SELECT id FROM app.messages WHERE id = $1', [msg['secret']])).length).toBe(0);
    expect((await q(omar, 'SELECT id FROM app.messages WHERE id = $1', [msg['dm']])).length).toBe(0);
  });

  it('Lena sees only the channel she holds a grant on; a read grant gives no post; a post grant does; losing the grant loses the channel', async () => {
    expect(await visible(lena)).toEqual([ch['eng-releases']]);
    expect(await visible(lena, 'post')).toEqual([]);
    expect((await q(lena, 'SELECT id FROM app.messages')).map((r) => r['id'])).toEqual([msg['releases']]);
    expect(await q(lena, 'SELECT person_id FROM app.channel_members')).toEqual([]);
    await grant(ch['eng-releases']!, lena, 'post');
    expect(await visible(lena, 'post')).toEqual([ch['eng-releases']]);
    await sys((tx) => tx.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND subject_id = $1", [lena.personId]));
    expect(await visible(lena)).toEqual([]);
    await grant(ch['eng-releases']!, lena, 'read');
  });

  it('a guest never gets access from a membership row, only from a grant', async () => {
    await member(ch['eng-leads']!, lena);
    try {
      expect(await visible(lena)).toEqual([ch['eng-releases']]);
    } finally {
      await sys((tx) => tx.query('DELETE FROM app.channel_members WHERE person_id = $1', [lena.personId]));
    }
  });

  it('an archived channel is readable but not postable', async () => {
    expect(await visible(nadia)).toContain(ch['eng-old']);
    expect(await visible(nadia, 'post')).not.toContain(ch['eng-old']);
    expect(await code(as(nadia, (tx) => tx.query(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'late', 'late')`,
      [nadia.workspaceId, ch['eng-old'], nadia.actorId])))).toBe('42501');
  });

  it('a suspended person and a bot of nobody see nothing', async () => {
    await sys((tx) => tx.query("UPDATE app.people SET status = 'suspended' WHERE id = $1", [priya.personId]));
    try {
      expect(await visible(priya)).toEqual([]);
      expect(await q(priya, 'SELECT id FROM app.channels')).toEqual([]);
    } finally {
      await sys((tx) => tx.query("UPDATE app.people SET status = 'active' WHERE id = $1", [priya.personId]));
    }
    const ghost = { kind: 'person' as const, id: '00000000-0000-7000-8000-00000000ffff' as never, workspaceId: omar.workspaceId };
    const rows = await withActor(ghost, async (tx) => (await tx.query('SELECT id FROM app.channels')).rows, { pool: appPool });
    expect(rows).toEqual([]);
  });

  it('the audience of a channel is exactly the people whose visible set holds it', async () => {
    await grant(ch['eng-general']!, lena, 'read');
    await sys((tx) => tx.query(
      `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
       VALUES ($1, 'channel', $2, 'team', $3, 'read')`, [omar.workspaceId, ch['mkt-secret'], TEAM_IDS['Customer support']]));
    try {
      for (const [key, id] of Object.entries(ch)) {
        const audience = new Set((await sys(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1)', [id])).rows)).map((r) => r.person_id));
        const sees = new Set<string>();
        for (const p of ALL) if ((await visible(p)).includes(id)) sees.add(p.personId);
        expect([...audience].sort(), key).toEqual([...sees].sort());
      }
    } finally {
      await sys((tx) => tx.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND subject_type = 'team'"));
      await sys((tx) => tx.query("DELETE FROM app.acl_entries WHERE resource_type = 'channel' AND resource_id = $1", [ch['eng-general']]));
    }
  });

  it('channel_audience answers nobody who cannot read the channel themselves', async () => {
    expect(await q(sameera, 'SELECT person_id FROM app.channel_audience($1)', [ch['eng-general']])).toEqual([]);
    expect((await q(nadia, 'SELECT person_id FROM app.channel_audience($1)', [ch['eng-general']])).length).toBeGreaterThan(0);
  });
});

describe('writing: the policies and guards', () => {
  it('a message needs the post set, the caller as author and the channel workspace', async () => {
    const ins = (p: Persona, channelId: string, author: Persona = p): Promise<unknown> =>
      as(p, (tx) => tx.query(`INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'x', 'x')`, [p.workspaceId, channelId, author.actorId]));
    expect(await code(ins(nadia, ch['eng-general']!))).toBeUndefined();
    expect(await code(ins(nadia, ch['eng-general']!, rafi))).toBe('42501');       // forged author
    expect(await code(ins(sameera, ch['eng-general']!))).toBe('42501');           // another team
    expect(await code(ins(priya, ch['eng-leads']!))).toBe('42501');               // private
    expect(await code(ins(lena, ch['eng-releases']!))).toBe('42501');             // read-only guest
    expect(await code(ins(omar, ch['mkt-general']!))).toBeUndefined();            // an admin posts in every public channel
    expect(await code(ins(omar, ch['mkt-secret']!))).toBe('42501');               // ...but not into a private channel they are not in
  });

  it('edit: the author only, text and deletion mark only; the lead may delete but not rewrite', async () => {
    const edit = (p: Persona, id: string, set: string): Promise<{ rowCount: number | null }> =>
      as(p, (tx) => tx.query(`UPDATE app.messages SET ${set} WHERE id = $1`, [id]));
    expect((await edit(nadia, msg['general']!, "body = 'edited', body_plain = 'edited', edited_at = now()")).rowCount).toBe(1);
    expect(await code(edit(rafi, msg['general']!, "body = 'hijack', body_plain = 'hijack', edited_at = now()"))).toBe(undefined);
    expect((await sys(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE id = $1', [msg['general']])).rows[0]!)).body).toBe('edited');
    expect(await code(edit(nadia, msg['general']!, "author_id = '" + rafi.actorId + "'"))).toBe('42501');
    expect(await code(edit(nadia, msg['general']!, "channel_id = '" + ch['eng-releases'] + "'"))).toBe('42501');
    expect(await code(edit(nadia, msg['general']!, "body_plain = 'tampered'"))).toBe('42501');
    expect(await code(edit(omar, msg['general']!, "body = 'lead rewrite', body_plain = 'lead rewrite', edited_at = now()"))).toBe('42501');
    expect((await edit(omar, msg['general']!, "deleted_at = now(), body_plain = ''")).rowCount).toBe(1);
    expect(await code(edit(omar, msg['general']!, 'deleted_at = NULL'))).toBe('42501');   // no undelete
    expect(await code(edit(nadia, msg['general']!, "body = 'again', body_plain = 'again', edited_at = now()"))).toBe('42501');   // not once deleted
    expect((await sys(async (tx) => (await tx.query<{ body: string }>('SELECT body FROM app.messages WHERE id = $1', [msg['general']])).rows[0]!)).body).toBe('edited');
    expect(await code(as(nadia, (tx) => tx.query('DELETE FROM app.messages WHERE id = $1', [msg['releases']])))).toBe('42501');
  });

  it('threads: replies count in the same statement; a reply to a reply or across channels is refused', async () => {
    const reply = (channelId: string, root: string, p: Persona = nadia): Promise<unknown> =>
      as(p, (tx) => tx.query(
        `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'r', 'r', $4)`,
        [p.workspaceId, channelId, p.actorId, root]));
    await reply(ch['eng-releases']!, msg['releases']!);
    await reply(ch['eng-releases']!, msg['releases']!, rafi);
    const thread = (await sys(async (tx) => (await tx.query<{ reply_count: number; title: string }>('SELECT reply_count, title FROM app.threads WHERE root_message_id = $1', [msg['releases']])).rows[0]!));
    expect(thread).toEqual({ reply_count: 2, title: 'v1 shipped' });
    const replyId = (await sys(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.messages WHERE thread_root_id = $1 LIMIT 1', [msg['releases']])).rows[0]!)).id;
    expect(await code(reply(ch['eng-releases']!, replyId))).toBe('23514');
    expect(await code(reply(ch['eng-general']!, msg['releases']!))).toBe('23514');
    // Thread rows are system-written: a caller cannot invent or change one.
    expect(await code(as(nadia, (tx) => tx.query("UPDATE app.threads SET reply_count = 99 WHERE root_message_id = $1", [msg['releases']])))).toBe('42501');
    expect((await sys(async (tx) => (await tx.query<{ reply_count: number }>('SELECT reply_count FROM app.threads WHERE root_message_id = $1', [msg['releases']])).rows[0]!)).reply_count).toBe(2);
    expect(await code(as(nadia, (tx) => tx.query('INSERT INTO app.threads (root_message_id, channel_id) VALUES ($1, $2)', [msg['general'], ch['eng-general']])))).toBe('42501');
    expect((await q(sameera, 'SELECT root_message_id FROM app.threads'))).toEqual([]);
  });

  it('reactions take their channel from the message: a caller cannot claim a channel they can see for a message they cannot', async () => {
    const react = (p: Persona, message: string, channelId: string): Promise<unknown> =>
      as(p, (tx) => tx.query('INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id) VALUES ($1, $2, $3, $4)', [message, p.actorId, '👍', channelId]));
    expect(await code(react(priya, msg['leads']!, ch['eng-general']!))).toBe('42501');
    expect(await code(react(priya, msg['releases']!, ch['eng-general']!))).toBeUndefined();
    const stored = await sys(async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.message_reactions WHERE message_id = $1', [msg['releases']])).rows[0]!);
    expect(stored.channel_id).toBe(ch['eng-releases']);
    expect(await code(as(priya, (tx) => tx.query('INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id) VALUES ($1, $2, $3, $4)', [msg['releases'], rafi.actorId, '🎉', ch['eng-releases']])))).toBe('42501');
    expect((await q(sameera, 'SELECT message_id FROM app.message_reactions'))).toEqual([]);
    expect((await q(lena, 'SELECT message_id FROM app.message_reactions')).length).toBe(1);
    expect(await code(as(lena, (tx) => tx.query('INSERT INTO app.message_reactions (message_id, actor_id, emoji, channel_id) VALUES ($1, $2, $3, $4)', [msg['releases'], lena.actorId, '👍', ch['eng-releases']])))).toBe('42501');
  });

  it('channels: a lead writes team channels, nobody changes identity columns, DMs are not writable through the policy', async () => {
    const mk = (p: Persona, team: string, name: string, extra = 'false'): Promise<unknown> =>
      as(p, (tx) => tx.query(`INSERT INTO app.channels (workspace_id, team_id, name, private, created_by) VALUES ($1, $2, $3, ${extra}, $4)`, [p.workspaceId, team, name, p.actorId]));
    expect(await code(mk(omar, TEAM_IDS.Engineering, 'by-lead'))).toBeUndefined();
    expect(await code(mk(nadia, TEAM_IDS.Engineering, 'by-member'))).toBe('42501');
    expect(await code(mk(omar, TEAM_IDS.Marketing, 'by-admin'))).toBeUndefined();
    expect(await code(mk(tariq, TEAM_IDS.Engineering, 'cross-team'))).toBe('42501');
    expect(await code(mk(omar, TEAM_IDS.Engineering, 'by-lead'))).toBe('23505');
    expect(await code(mk(omar, TEAM_IDS.Engineering, 'Bad Name'))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.channels (workspace_id, name, kind, private, dm_key, created_by) VALUES ($1, '', 'dm', true, 'x:y', $2)`, [omar.workspaceId, omar.actorId])))).toBe('42501');
    const upd = (p: Persona, set: string, id = ch['eng-general']!): Promise<{ rowCount: number | null }> =>
      as(p, (tx) => tx.query(`UPDATE app.channels SET ${set} WHERE id = $1`, [id]));
    expect((await upd(omar, "purpose = 'ok'")).rowCount).toBe(1);
    expect((await upd(nadia, "purpose = 'no'")).rowCount).toBe(0);
    expect(await code(upd(omar, 'private = true'))).toBe('23514');
    expect(await code(upd(omar, `team_id = '${TEAM_IDS.Marketing}'`))).toBe('23514');
    expect((await upd(omar, "purpose = 'x'", ch['mkt-secret']!)).rowCount).toBe(0);            // not visible: not updatable
    expect((await upd(omar, "purpose = 'x'", ch['dm-nr']!)).rowCount).toBe(0);
    expect(await code(as(omar, (tx) => tx.query('DELETE FROM app.channels WHERE id = $1', [ch['eng-general']])))).toBe('42501');
  });

  it('membership goes through the definer functions: the checks use the caller, not a settable GUC', async () => {
    const call = (p: Persona, fn: string, ...args: unknown[]): Promise<unknown> =>
      as(p, (tx) => tx.query(`SELECT app.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')})`, args));
    expect(await code(as(nadia, (tx) => tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2)', [ch['eng-leads'], nadia.personId])))).toBe('42501');
    expect(await code(call(nadia, 'channels_join', ch['eng-leads']))).toBe('42501');             // private
    expect(await code(call(nadia, 'channels_join', ch['dm-nr']))).toBe('42501');                 // a DM
    expect(await code(call(lena, 'channels_join', ch['eng-releases']))).toBe('42501');           // a guest
    expect(await code(call(sameera, 'channels_join', ch['eng-general']))).toBe('42501');         // another team
    expect(await code(call(nadia, 'channels_join', ch['eng-old']))).toBe('23514');               // archived
    expect(await code(call(nadia, 'channels_join', ch['eng-general']))).toBeUndefined();
    expect(await code(call(nadia, 'channels_add_member', ch['eng-leads'], nadia.personId))).toBe('42501');
    expect(await code(call(omar, 'channels_add_member', ch['eng-leads'], sameera.personId))).toBe('23514');   // not on the team
    expect(await code(call(omar, 'channels_add_member', ch['eng-leads'], lena.personId))).toBe('23514');      // a guest
    expect(await code(call(omar, 'channels_add_member', ch['eng-old'], nadia.personId))).toBe('23514');       // archived
    expect(await code(call(omar, 'channels_add_member', ch['dm-nr'], nadia.personId))).toBe('42501');         // a DM is not manageable
    expect(await code(call(omar, 'channels_add_member', ch['eng-leads'], nadia.personId))).toBeUndefined();
    expect(await code(call(nadia, 'channels_remove_member', ch['eng-leads'], rafi.personId))).toBe('42501');
    expect(await code(call(nadia, 'channels_remove_member', ch['dm-nr'], nadia.personId))).toBe('23514');     // nobody leaves a DM
    expect(await code(call(nadia, 'channels_remove_member', ch['eng-leads'], nadia.personId))).toBeUndefined(); // leaving
    expect(await visible(nadia)).not.toContain(ch['eng-leads']);
    expect((await q(nadia, 'SELECT person_id FROM app.channel_members WHERE channel_id = $1', [ch['dm-nr']])).length).toBe(2);
    expect(await q(sameera, 'SELECT person_id FROM app.channel_members')).toEqual([]);
  });

  it('team templates: the sync is for people who can read the team (and the system), runs once, never recreates a renamed channel', async () => {
    const def = { id: 'engineering', version: 1, channels: [{ name: '#alpha', purpose: 'a' }, { name: '#beta', private: true, purpose: 'b' }] };
    await sys((tx) => tx.query('UPDATE app.teams SET template = $2, template_definition = $3::jsonb WHERE id = $1', [TEAM_IDS.Marketing, 'engineering', JSON.stringify(def)]));
    expect(await code(as(sameera, (tx) => tx.query('SELECT * FROM app.channels_sync_template($1)', [TEAM_IDS.Marketing])))).toBe('42501');
    const first = await as(tariq, async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.channels_sync_template($1)', [TEAM_IDS.Marketing])).rows.map((r) => r.name));
    expect(first).toEqual(['alpha', 'beta']);
    expect(await as(tariq, async (tx) => (await tx.query('SELECT * FROM app.channels_sync_template($1)', [TEAM_IDS.Marketing])).rows)).toEqual([]);
    const beta = await sys(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.channels WHERE team_id = $1 AND name = 'beta'", [TEAM_IDS.Marketing])).rows[0]!.id);
    expect((await sys(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_members WHERE channel_id = $1', [beta])).rows)).map((r) => r.person_id)).toEqual([tariq.personId]);
    await sys((tx) => tx.query("UPDATE app.channels SET name = 'alpha-renamed' WHERE team_id = $1 AND name = 'alpha'", [TEAM_IDS.Marketing]));
    await sys((tx) => tx.query('DELETE FROM app.channel_template_syncs WHERE team_id = $1', [TEAM_IDS.Marketing]));
    expect(await sys(async (tx) => (await tx.query<{ name: string }>('SELECT name FROM app.channels_sync_template($1)', [TEAM_IDS.Marketing])).rows.map((r) => r.name))).toEqual(['alpha']);
  });

  it('thread follows are private to the person and need a message they can read', async () => {
    const follow = (p: Persona, root: string): Promise<unknown> =>
      as(p, (tx) => tx.query('INSERT INTO app.thread_follows (person_id, thread_root_id) VALUES ($1, $2)', [p.personId, root]));
    expect(await code(follow(nadia, msg['releases']!))).toBe('23505');          // she replied: the thread already follows her
    expect(await code(follow(priya, msg['releases']!))).toBeUndefined();
    expect(await code(follow(sameera, msg['releases']!))).toBe('42501');
    expect(await code(follow(priya, msg['leads']!))).toBe('42501');
    expect(await code(as(sameera, (tx) => tx.query('INSERT INTO app.thread_follows (person_id, thread_root_id) VALUES ($1, $2)', [nadia.personId, msg['releases']])))).toBe('42501');
    expect((await q(priya, 'SELECT person_id FROM app.thread_follows')).map((r) => r['person_id'])).toEqual([priya.personId]);
    expect((await q(rafi, 'SELECT person_id FROM app.thread_follows')).map((r) => r['person_id'])).toEqual([rafi.personId]);   // the reply made him follow
    expect(await q(omar, 'SELECT person_id FROM app.thread_follows')).toEqual([]);
    expect((await as(priya, (tx) => tx.query('DELETE FROM app.thread_follows WHERE person_id = $1', [priya.personId]))).rowCount).toBe(1);
    expect((await as(priya, (tx) => tx.query('DELETE FROM app.thread_follows WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(0);
  });

  it('messages is read through the channel index (no per-row visibility call even on a few thousand rows)', async () => {
    await sys((tx) => tx.query(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain)
       SELECT $1, $2, $3, 'bulk', 'bulk' FROM generate_series(1, 3000)`, [omar.workspaceId, ch['eng-general'], nadia.actorId]));
    const plan = await as(nadia, async (tx) => (await tx.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT id FROM app.messages WHERE channel_id = $1 ORDER BY id DESC LIMIT 50`, [ch['eng-general']])).rows.map((r) => r['QUERY PLAN']).join('\n'));
    expect(plan).toMatch(/messages_channel_id_desc/);
    expect(plan).not.toMatch(/app\.can/);
  });
});

describe('presence and typing (UNLOGGED, migration 0003)', () => {
  const upsertPresence = (p: Persona, who: Persona = p): Promise<unknown> =>
    as(p, (tx) => tx.query(
      `INSERT INTO app.presence (person_id, workspace_id, status) VALUES ($1, $2, 'online')
       ON CONFLICT (person_id) DO UPDATE SET seen_at = now()`, [who.personId, omar.workspaceId]));
  const setTyping = (p: Persona, channelId: string, who: Persona = p): Promise<unknown> =>
    as(p, (tx) => tx.query(
      `INSERT INTO app.typing (channel_id, person_id, expires_at) VALUES ($1, $2, now() + interval '5 seconds')
       ON CONFLICT (channel_id, person_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`, [channelId, who.personId]));

  it('both tables are UNLOGGED and carry the rls comment kind the harness expects', async () => {
    const rows = await sys(async (tx) => (await tx.query<{ relname: string; relpersistence: string; comment: string }>(
      `SELECT c.relname, c.relpersistence, obj_description(c.oid, 'pg_class') AS comment FROM pg_class c
        WHERE c.relnamespace = 'app'::regnamespace AND c.relname IN ('presence', 'typing') ORDER BY c.relname`)).rows);
    expect(rows.map((r) => [r.relname, r.relpersistence])).toEqual([['presence', 'u'], ['typing', 'u']]);
    expect(rows[0]?.comment).toMatch(/^rls: workspace/);
    expect(rows[1]?.comment).toMatch(/^rls: team/);
  });

  it('presence: a person writes only their own row; members read everyone of the workspace, a guest only themself', async () => {
    await upsertPresence(nadia);
    await upsertPresence(rafi);
    await upsertPresence(lena);
    expect(await code(upsertPresence(nadia, rafi))).toBe('42501');                       // not someone else's row
    expect(await code(as(nadia, (tx) => tx.query("INSERT INTO app.presence (person_id, workspace_id) VALUES ($1, '00000000-0000-7000-8000-00000000ffff')", [nadia.personId])))).toBeDefined();
    expect((await q(sameera, 'SELECT person_id FROM app.presence')).map((r) => r['person_id']).sort()).toEqual([nadia.personId, rafi.personId, lena.personId].sort());
    expect((await q(lena, 'SELECT person_id FROM app.presence')).map((r) => r['person_id'])).toEqual([lena.personId]);
    expect((await as(nadia, (tx) => tx.query("UPDATE app.presence SET status = 'away' WHERE person_id = $1", [rafi.personId]))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.presence WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(0);
    expect((await as(rafi, (tx) => tx.query("UPDATE app.presence SET status = 'away' WHERE person_id = $1", [rafi.personId]))).rowCount).toBe(1);
    expect(await code(as(rafi, (tx) => tx.query("UPDATE app.presence SET status = 'busy' WHERE person_id = $1", [rafi.personId])))).toBe('23514');
  });

  it('typing: own row, in a channel the person can post in; readable only with the channel', async () => {
    await setTyping(nadia, ch['eng-general']!);
    expect(await code(setTyping(nadia, ch['eng-general']!, rafi))).toBe('42501');         // not for someone else
    expect(await code(setTyping(sameera, ch['eng-general']!))).toBe('42501');             // a channel she cannot see
    expect(await code(setTyping(lena, ch['eng-releases']!))).toBe('42501');               // read grant only: no post
    expect(await code(setTyping(nadia, ch['eng-old']!))).toBe('42501');                   // archived: not in the post set
    await setTyping(rafi, ch['eng-leads']!);
    expect(await code(setTyping(nadia, ch['eng-leads']!))).toBe('42501');                 // private, not a member
    expect((await q(priya, 'SELECT person_id FROM app.typing')).map((r) => r['person_id'])).toEqual([nadia.personId]);   // not the private channel's
    expect((await q(rafi, 'SELECT person_id FROM app.typing ORDER BY person_id')).length).toBe(2);
    expect(await q(sameera, 'SELECT person_id FROM app.typing')).toEqual([]);
    expect(await q(omar, "SELECT person_id FROM app.typing WHERE channel_id = $1", [ch['eng-leads']])).toHaveLength(1);   // omar is a member of eng-leads
    expect((await q(lena, 'SELECT person_id FROM app.typing')).length).toBe(0);           // her grant is #eng-releases only
  });

  it('typing: one can delete their own row and sweep expired rows of a channel they read, never a live row of somebody else', async () => {
    expect((await as(priya, (tx) => tx.query('DELETE FROM app.typing WHERE person_id = $1', [nadia.personId]))).rowCount).toBe(0);
    await sys((tx) => tx.query("UPDATE app.typing SET expires_at = now() - interval '1 second' WHERE person_id = $1", [nadia.personId]));
    expect((await as(priya, (tx) => tx.query('DELETE FROM app.typing WHERE person_id = $1', [nadia.personId]))).rowCount).toBe(1);   // expired: a sweep
    expect((await as(sameera, (tx) => tx.query('DELETE FROM app.typing WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(0);
    expect((await as(rafi, (tx) => tx.query('DELETE FROM app.typing WHERE person_id = $1', [rafi.personId]))).rowCount).toBe(1);
  });
});

describe('mentions: who writes and deletes them, and who they can name (migration 0003)', () => {
  const mention = (p: Persona, messageId: string, mentioned: Persona): Promise<unknown> =>
    as(p, (tx) => tx.query("INSERT INTO app.message_mentions (message_id, mentioned_id, kind, channel_id) VALUES ($1, $2, 'person', $1)", [messageId, mentioned.actorId]));

  it('only the author of the message writes or deletes its mentions', async () => {
    expect(await code(mention(rafi, msg['general']!, priya))).toBe('42501');               // not the author
    await mention(nadia, msg['general']!, rafi);
    expect((await q(rafi, 'SELECT mentioned_id FROM app.message_mentions WHERE message_id = $1', [msg['general']])).length).toBe(1);
    expect(await q(sameera, 'SELECT mentioned_id FROM app.message_mentions')).toEqual([]);
    expect((await as(rafi, (tx) => tx.query('DELETE FROM app.message_mentions WHERE message_id = $1', [msg['general']]))).rowCount).toBe(0);
    expect((await as(priya, (tx) => tx.query('DELETE FROM app.message_mentions WHERE message_id = $1', [msg['general']]))).rowCount).toBe(0);
    expect((await as(nadia, (tx) => tx.query('DELETE FROM app.message_mentions WHERE message_id = $1', [msg['general']]))).rowCount).toBe(1);
  });

  it('app.channel_mention_candidates answers for people who can read the channel, as the audience, and never to a guest or an outsider', async () => {
    const cands = (p: Persona, channelId: string, prefixes: string[]): Promise<string[]> =>
      as(p, async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_mention_candidates($1, $2::text[])', [channelId, prefixes])).rows.map((r) => r.person_id).sort());
    expect(await cands(nadia, ch['eng-general']!, ['ra%'])).toEqual([rafi.personId]);
    expect(await cands(nadia, ch['eng-general']!, ['sam%'])).toEqual([]);                    // Sameera is not on Engineering
    expect(await cands(nadia, ch['eng-general']!, ['%'])).toEqual([omar.personId, nadia.personId, rafi.personId, priya.personId].sort());   // the audience, no guest
    expect(await cands(nadia, ch['eng-leads']!, ['%'])).toEqual([]);                           // a channel she cannot read
    expect(await cands(rafi, ch['eng-leads']!, ['%'])).toEqual([omar.personId, rafi.personId].sort());
    expect(await cands(lena, ch['eng-releases']!, ['%'])).toEqual([]);                         // a guest resolves nobody
    expect(await cands(sameera, ch['eng-general']!, ['%'])).toEqual([]);
    expect(await cands(nadia, ch['eng-general']!, [])).toEqual([]);
  });
});

describe('following a thread: thread_follows is the membership, read_state.followed its mirror (migration 0003)', () => {
  const reply = (p: Persona, root: string, channelId: string): Promise<string> =>
    as(p, async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain, thread_root_id) VALUES ($1, $2, $3, 'r', 'r', $4) RETURNING id`,
      [omar.workspaceId, channelId, p.actorId, root])).rows[0]!.id);
  const mirror = (root: string): Promise<string[]> =>
    sys(async (tx) => (await tx.query<{ person_id: string }>(
      "SELECT person_id FROM app.read_state WHERE target_type = 'thread' AND target_id = $1 AND followed ORDER BY person_id", [root])).rows.map((r) => r.person_id));
  const members = (root: string): Promise<string[]> =>
    sys(async (tx) => (await tx.query<{ person_id: string }>('SELECT person_id FROM app.thread_follows WHERE thread_root_id = $1 ORDER BY person_id', [root])).rows.map((r) => r.person_id));
  const sortedIds = (...p: Persona[]): string[] => p.map((x) => x.personId as string).sort();
  const freshRoot = (author: Persona, channelId: string): Promise<string> =>
    sys(async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO app.messages (workspace_id, channel_id, author_id, body, body_plain) VALUES ($1, $2, $3, 'root', 'root') RETURNING id`,
      [omar.workspaceId, channelId, author.actorId])).rows[0]!.id);
  let root = '';
  let root2 = '';
  beforeAll(async () => {
    root = await freshRoot(nadia, ch['eng-general']!);
    root2 = await freshRoot(nadia, ch['eng-general']!);
  });

  it('the first reply makes the replier and the root author follow, and the mirror says so, even for the author who did not write it', async () => {
    await reply(rafi, root, ch['eng-general']!);
    expect(await members(root)).toEqual(sortedIds(nadia, rafi));
    expect(await mirror(root)).toEqual(sortedIds(nadia, rafi));
  });

  it('giving a follow up is not undone by someone else\'s reply (only the first reply follows the root author); a reply of your own follows again', async () => {
    await as(nadia, (tx) => tx.query('DELETE FROM app.thread_follows WHERE person_id = $1 AND thread_root_id = $2', [nadia.personId, root]));
    expect(await members(root)).toEqual(sortedIds(rafi));
    expect(await mirror(root)).toEqual(sortedIds(rafi));
    await reply(rafi, root, ch['eng-general']!);
    expect(await members(root)).toEqual(sortedIds(rafi));
    await reply(nadia, root, ch['eng-general']!);
    expect(await members(root)).toEqual(sortedIds(nadia, rafi));
    expect(await mirror(root)).toEqual(sortedIds(nadia, rafi));
  });

  it('a follow made by the person themself is mirrored too, and the mirror keeps the unread count it finds', async () => {
    const r = root2;
    await sys((tx) => tx.query(
      "INSERT INTO app.read_state (person_id, target_type, target_id, unread_count) VALUES ($1, 'thread', $2, 3)", [priya.personId, r]));
    await as(priya, (tx) => tx.query('INSERT INTO app.thread_follows (person_id, thread_root_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [priya.personId, r]));
    const row = (await sys(async (tx) => (await tx.query<{ followed: boolean; unread_count: number }>(
      "SELECT followed, unread_count FROM app.read_state WHERE person_id = $1 AND target_type = 'thread' AND target_id = $2", [priya.personId, r])).rows))[0];
    expect(row).toEqual({ followed: true, unread_count: 3 });
    await as(priya, (tx) => tx.query('DELETE FROM app.thread_follows WHERE person_id = $1 AND thread_root_id = $2', [priya.personId, r]));
    expect((await sys(async (tx) => (await tx.query<{ followed: boolean; unread_count: number }>(
      "SELECT followed, unread_count FROM app.read_state WHERE person_id = $1 AND target_type = 'thread' AND target_id = $2", [priya.personId, r])).rows))[0])
      .toEqual({ followed: false, unread_count: 3 });
  });
});

