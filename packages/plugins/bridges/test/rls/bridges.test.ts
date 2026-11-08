import { createHash } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  botsMigrationSource,
  bridgesMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  explainRlsViolations,
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

// Bundle D, bridges 0001: who sees a chat app account, who links a chat user or a channel, that a code works once and only for who asked, that the credential, code and message
// tables are unreachable to every person-facing role, and the rules the database keeps whatever the code does (only public channels, only a turned-on account with a token).

const { omar, nadia, rafi, tariq, lena } = personas;
const ENG = TEAM_IDS.Engineering;
const hash = (s: string): string => createHash('sha256').update(s).digest('hex');

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const q = async <T extends Record<string, unknown>>(p: Persona, text: string, values: unknown[] = []): Promise<T[]> => as(p, async (tx) => (await tx.query<T>(text, values)).rows);
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);

let account = '';
let offAccount = '';
let pub = '';
let priv = '';
let botId = '';

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, bridgesMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  await sys(async (tx) => {
    const mk = async (name: string, isPrivate: boolean): Promise<string> =>
      (await tx.query<{ id: string }>('INSERT INTO app.channels (workspace_id, team_id, name, kind, private, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [omar.workspaceId, ENG, name, 'channel', isPrivate, omar.actorId])).rows[0]!.id;
    pub = await mk('br-open', false);
    priv = await mk('br-private', true);
    await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2), ($1, $3)', [priv, omar.personId, nadia.personId]);
    botId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bots (workspace_id, team_id, slug, name, role, kind, runtime, visibility, definition_sha, status)
         VALUES ($1, $2, 'brb', 'Bridge bot', 'Answers', 'agent', 'hermes', 'team', $3, 'active') RETURNING id`,
        [omar.workspaceId, ENG, 'a'.repeat(64)],
      )
    ).rows[0]!.id;
    // an account that is on (with its token), and one that is off
    account = (await tx.query<{ id: string }>(`INSERT INTO app.bridge_accounts (workspace_id, provider, display_name, handle) VALUES ($1, 'telegram', 'Kahf bot', '@kahf_bot') RETURNING id`, [omar.workspaceId])).rows[0]!.id;
    const secret = (await tx.query<{ id: string }>(`INSERT INTO app.secrets (ciphertext, wrapped_key, key_id, workspace_id) VALUES ('\\x00', '\\x00', 'test', $1) RETURNING id`, [omar.workspaceId])).rows[0]!.id;
    await tx.query(`INSERT INTO app.bridge_secrets (workspace_id, account_id, name, secret_id) VALUES ($1, $2, 'bot_token', $3)`, [omar.workspaceId, account, secret]);
    await tx.query(`UPDATE app.bridge_accounts SET status = 'on' WHERE id = $1`, [account]);
    offAccount = (await tx.query<{ id: string }>(`INSERT INTO app.bridge_accounts (workspace_id, provider, display_name) VALUES ($1, 'slack', 'Slack app') RETURNING id`, [omar.workspaceId])).rows[0]!.id;
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the bridges tables pass the RLS harness', () => {
  it('forced RLS, a rls: comment, policies for every command', async () => {
    const admin = testClient({ connectionString: db.ownerUrl });
    await admin.connect();
    try {
      expect(await explainRlsViolations(admin)).toEqual([]);
    } finally {
      await admin.end();
    }
  });
});

describe('accounts', () => {
  it('admins read and write them; a member sees none and cannot write', async () => {
    expect((await q(omar, 'SELECT id FROM app.bridge_accounts')).length).toBe(2);
    expect(await q(nadia, 'SELECT id FROM app.bridge_accounts')).toEqual([]);
    expect(await q(lena, 'SELECT id FROM app.bridge_accounts')).toEqual([]);
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.bridge_accounts (workspace_id, provider, display_name) VALUES ($1, 'teams', 'x')`, [omar.workspaceId])))).toBe('42501');
    await as(nadia, (tx) => tx.query(`UPDATE app.bridge_accounts SET display_name = 'hacked'`));
    expect((await q<{ display_name: string }>(omar, 'SELECT display_name FROM app.bridge_accounts WHERE id = $1', [account]))[0]!.display_name).toBe('Kahf bot');
  });

  it('a member lists only the accounts that are on, with their public handle; a guest lists none', async () => {
    expect(await q(nadia, 'SELECT * FROM app.bridges_available()')).toEqual([expect.objectContaining({ provider: 'telegram', display_name: 'Kahf bot', handle: '@kahf_bot' })]);
    expect(await q(lena, 'SELECT * FROM app.bridges_available()')).toEqual([]);
  });

  it('an account cannot be switched on without a bot token, and its service never changes', async () => {
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.bridge_accounts SET status = 'on' WHERE id = $1`, [offAccount])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.bridge_accounts SET provider = 'teams' WHERE id = $1`, [account])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.bridge_accounts (workspace_id, provider, display_name) VALUES ($1, 'telegram', 'twice')`, [omar.workspaceId])))).toBe('23505');
  });
});

describe('the credential, code, message and unlinked-chat tables are system only', () => {
  it('no person-facing role reads or writes them', async () => {
    for (const table of ['bridge_secrets', 'bridge_link_codes', 'bridge_messages', 'bridge_unlinked_chats']) {
      expect(await code(as(omar, (tx) => tx.query(`SELECT 1 FROM app.${table}`))), table).toBe('42501');
      expect(await code(as(nadia, (tx) => tx.query(`SELECT 1 FROM app.${table}`))), table).toBe('42501');
    }
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.bridge_secrets')).rows)).length).toBe(1);
  });
});

describe('linking a chat user', () => {
  it('a member asks for a code; only its hash is kept; an earlier unused one stops working', async () => {
    const first = await q<{ at: Date }>(nadia, 'SELECT app.bridges_issue_code($1, $2, NULL, $3) AS at', [account, 'identity', hash('11111111')]);
    expect(first[0]!.at.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
    await q(nadia, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('22222222')]);
    const rows = await sys(async (tx) => (await tx.query<{ code_hash: string }>(`SELECT code_hash FROM app.bridge_link_codes WHERE person_id = $1 AND used_at IS NULL`, [nadia.personId])).rows);
    expect(rows.map((r) => r.code_hash)).toEqual([hash('22222222')]);
  });

  it('a guest, an account that is off and an unknown purpose are refused', async () => {
    expect(await code(as(lena, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('33333333')])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, NULL, $3)', [offAccount, 'identity', hash('44444444')])))).toBe('P0002');
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'other', hash('55555555')])))).toBe('23514');
  });

  it('five codes in ten minutes is the most one person gets', async () => {
    for (let i = 0; i < 3; i++) await q(rafi, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash(`rafi-${i}`)]);
    await q(rafi, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('rafi-3')]);
    await q(rafi, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('rafi-4')]);
    expect(await code(as(rafi, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('rafi-5')])))).toBe('23514');
  });

  it('the app role cannot redeem a code; the system role can, once, and gets the person back', async () => {
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.bridges_link_identity($1, $2, $3, $4)', [account, hash('22222222'), 'tg-1', '@nadia'])))).toBe('42501');
    expect(await code(as(nadia, (tx) => tx.query('SELECT 1 FROM app.bridge_link_codes')))).toBe('42501');
    const got = await sys(async (tx) => (await tx.query<{ p: string | null }>('SELECT app.bridges_link_identity($1, $2, $3, $4) AS p', [account, hash('22222222'), 'tg-1', '@nadia'])).rows[0]!.p);
    expect(got).toBe(nadia.personId);
    // a second use, a wrong code and a code for another account all answer null
    const again = await sys(async (tx) => (await tx.query<{ p: string | null }>('SELECT app.bridges_link_identity($1, $2, $3, $4) AS p', [account, hash('22222222'), 'tg-2', '@x'])).rows[0]!.p);
    expect(again).toBeNull();
    const wrong = await sys(async (tx) => (await tx.query<{ p: string | null }>('SELECT app.bridges_link_identity($1, $2, $3, $4) AS p', [account, hash('00000000'), 'tg-3', '@y'])).rows[0]!.p);
    expect(wrong).toBeNull();
  });

  it('a chat user that is already someone else\'s cannot be linked again, and the code stays unused', async () => {
    await q(rafi, 'SELECT 1'); // rafi has used up his codes above; use a fresh person
    await q(tariq, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('tariq-1')]);
    expect(await code(sys((tx) => tx.query('SELECT app.bridges_link_identity($1, $2, $3, $4)', [account, hash('tariq-1'), 'tg-1', '@t'])))).toBe('23505');
    const used = await sys(async (tx) => (await tx.query<{ used_at: Date | null }>('SELECT used_at FROM app.bridge_link_codes WHERE code_hash = $1', [hash('tariq-1')])).rows[0]!.used_at);
    expect(used).toBeNull();
  });

  it('an expired code does not work', async () => {
    await q(omar, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('omar-1')]);
    await sys((tx) => tx.query(`UPDATE app.bridge_link_codes SET expires_at = now() - interval '1 second' WHERE code_hash = $1`, [hash('omar-1')]));
    const got = await sys(async (tx) => (await tx.query<{ p: string | null }>('SELECT app.bridges_link_identity($1, $2, $3, $4) AS p', [account, hash('omar-1'), 'tg-9', '@o'])).rows[0]!.p);
    expect(got).toBeNull();
  });

  it('a person reads and removes their own link; others see neither; an admin sees all', async () => {
    expect((await q<{ person_id: string }>(nadia, 'SELECT person_id FROM app.bridge_identities')).map((r) => r.person_id)).toEqual([nadia.personId]);
    expect(await q(rafi, 'SELECT 1 FROM app.bridge_identities')).toEqual([]);
    expect((await q(omar, 'SELECT 1 FROM app.bridge_identities')).length).toBe(1);
    expect(await code(as(nadia, (tx) => tx.query(`INSERT INTO app.bridge_identities (workspace_id, account_id, person_id, external_user_id) VALUES ($1, $2, $3, 'forged')`, [omar.workspaceId, account, nadia.personId])))).toBe('42501');
    // rafi tries to remove nadia's link: no row is his
    await as(rafi, (tx) => tx.query('DELETE FROM app.bridge_identities'));
    expect((await q(omar, 'SELECT 1 FROM app.bridge_identities')).length).toBe(1);
    await as(nadia, (tx) => tx.query('DELETE FROM app.bridge_identities'));
    expect(await q(omar, 'SELECT 1 FROM app.bridge_identities')).toEqual([]);
  });
});

describe('a private chat with a bot', () => {
  it('the person reads their own session; it goes when the link goes', async () => {
    await q(nadia, 'SELECT app.bridges_issue_code($1, $2, NULL, $3)', [account, 'identity', hash('nadia-again')]);
    await sys((tx) => tx.query('SELECT app.bridges_link_identity($1, $2, $3, $4)', [account, hash('nadia-again'), 'tg-1', '@nadia']));
    await sys((tx) => tx.query('INSERT INTO app.bridge_dm_sessions (workspace_id, account_id, person_id, external_chat_id, bot_id) VALUES ($1, $2, $3, $4, $5)', [omar.workspaceId, account, nadia.personId, 'chat-1', botId]));
    expect((await q(nadia, 'SELECT 1 FROM app.bridge_dm_sessions')).length).toBe(1);
    expect(await q(rafi, 'SELECT 1 FROM app.bridge_dm_sessions')).toEqual([]);
    expect(await q(omar, 'SELECT 1 FROM app.bridge_dm_sessions')).toEqual([]);
    expect(await code(as(nadia, (tx) => tx.query('UPDATE app.bridge_dm_sessions SET bot_id = bot_id RETURNING 1')))).toBe('42501');
    await as(nadia, (tx) => tx.query('DELETE FROM app.bridge_identities'));
    expect((await sys(async (tx) => (await tx.query('SELECT 1 FROM app.bridge_dm_sessions')).rows)).length).toBe(0);
  });
});

describe('linking a channel', () => {
  it('a lead who can post asks for a code for a public channel; a member, a guest and a private channel are refused', async () => {
    const at = await q<{ at: Date }>(omar, 'SELECT app.bridges_issue_code($1, $2, $3, $4) AS at', [account, 'channel', pub, hash('chan-1')]);
    expect(at[0]!.at.getTime()).toBeGreaterThan(Date.now());
    expect(await code(as(nadia, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, $3, $4)', [account, 'channel', pub, hash('chan-2')])))).toBe('42501');
    expect(await code(as(lena, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, $3, $4)', [account, 'channel', pub, hash('chan-3')])))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, $3, $4)', [account, 'channel', priv, hash('chan-4')])))).toBe('23514');
    expect(await code(as(omar, (tx) => tx.query('SELECT app.bridges_issue_code($1, $2, $3, $4)', [account, 'identity', pub, hash('chan-5')])))).toBe('23514');
  });

  it('the system role redeems it once; the link is readable by readers of the channel and removable by a lead', async () => {
    const id = await sys(async (tx) => (await tx.query<{ id: string | null }>('SELECT app.bridges_link_channel($1, $2, $3, $4) AS id', [account, hash('chan-1'), 'group-1', 'Eng group'])).rows[0]!.id);
    expect(id).not.toBeNull();
    expect(await code(as(omar, (tx) => tx.query('SELECT app.bridges_link_channel($1, $2, $3, $4)', [account, hash('chan-1'), 'group-2', 'x'])))).toBe('42501');
    const again = await sys(async (tx) => (await tx.query<{ id: string | null }>('SELECT app.bridges_link_channel($1, $2, $3, $4) AS id', [account, hash('chan-1'), 'group-2', 'x'])).rows[0]!.id);
    expect(again).toBeNull();
    expect((await q(nadia, 'SELECT 1 FROM app.bridge_links')).length).toBe(1);
    expect(await q(lena, 'SELECT 1 FROM app.bridge_links')).toEqual([]); // a guest reads a channel only when added to it
  });

  it('nobody but the system role makes a link directly, and only a lead removes one', async () => {
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.bridge_links (workspace_id, team_id, account_id, channel_id, external_chat_id) VALUES ($1, $2, $3, $4, 'sneaky')`, [omar.workspaceId, ENG, account, pub])))).toBe('42501');
    await as(nadia, (tx) => tx.query('DELETE FROM app.bridge_links'));
    expect((await q(omar, 'SELECT 1 FROM app.bridge_links')).length).toBe(1);
    await as(omar, (tx) => tx.query('DELETE FROM app.bridge_links'));
    expect(await q(omar, 'SELECT 1 FROM app.bridge_links')).toEqual([]);
  });

  it('the database refuses a link to a private channel, whoever writes it', async () => {
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.bridge_links (workspace_id, team_id, account_id, channel_id, external_chat_id) VALUES ($1, $2, $3, $4, 'g-priv')`, [omar.workspaceId, ENG, account, priv])))).toBe('23514');
  });

  it('a private channel\'s code cannot be redeemed after the channel went private', async () => {
    await q(omar, 'SELECT app.bridges_issue_code($1, $2, $3, $4)', [account, 'channel', pub, hash('chan-late')]);
    await sys((tx) => tx.query(`UPDATE app.channels SET private = true WHERE id = $1`, [pub]));
    try {
      const id = await sys(async (tx) => (await tx.query<{ id: string | null }>('SELECT app.bridges_link_channel($1, $2, $3, $4) AS id', [account, hash('chan-late'), 'g-late', 'x'])).rows[0]!.id);
      expect(id).toBeNull();
    } finally {
      await sys((tx) => tx.query(`UPDATE app.channels SET private = false WHERE id = $1`, [pub]));
    }
  });
});

describe('messages', () => {
  it('an inbound update id is kept once; an outbound row has none', async () => {
    await sys((tx) => tx.query(`INSERT INTO app.bridge_messages (workspace_id, account_id, direction, provider_update_id) VALUES ($1, $2, 'in', 'u-1')`, [omar.workspaceId, account]));
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.bridge_messages (workspace_id, account_id, direction, provider_update_id) VALUES ($1, $2, 'in', 'u-1')`, [omar.workspaceId, account])))).toBe('23505');
    await sys((tx) => tx.query(`INSERT INTO app.bridge_messages (workspace_id, account_id, direction, status) VALUES ($1, $2, 'out', 'pending')`, [omar.workspaceId, account]));
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.bridge_messages (workspace_id, account_id, direction, status) VALUES ($1, $2, 'in', 'pending')`, [omar.workspaceId, account])))).toBe('23514');
  });
});
