import { randomUUID } from 'node:crypto';
import { createAppPool, createSystemPool, withActor, withSystem, type Tx } from '@manythreads/kernel';
import {
  approvalsMigrationSource,
  botsMigrationSource,
  channelsMigrationSource,
  connectionsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  personaActor,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  type Persona,
  type TestDatabase,
} from '@manythreads/test-utils';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P16-02: the OAuth app a workspace admin enters for a provider. The client id is readable by the workspace's admins only; the sealed client secret is the system's
// alone, and goes when the app goes. (The harness checks of every table, including these two, are in connections.test.ts.)

const { omar, nadia, tariq, sameera, lena } = personas;

let db: TestDatabase;
let appPool: pg.Pool;
let sysPool: pg.Pool;
let botActor: string;
let otherWorkspace: string;
let secretId: string;
const as = <T>(p: Persona, fn: (tx: Tx) => Promise<T>): Promise<T> => withActor(personaActor(p), fn, { pool: appPool });
const asBot = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withActor({ kind: 'bot', id: botActor as never, workspaceId: omar.workspaceId as never }, fn, { pool: appPool });
const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });
const sysAny = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: sysPool });
const code = (promise: Promise<unknown>): Promise<string | undefined> => promise.then(() => undefined, (e: { code?: string }) => e.code);
const seal = (tx: Tx, workspace: string): Promise<string> =>
  tx.query<{ id: string }>(`INSERT INTO app.secrets (ciphertext, wrapped_key, key_id, workspace_id) VALUES ('\\x00', '\\x00', 'test', $1) RETURNING id`, [workspace]).then((r) => r.rows[0]!.id);
const exists = (id: string): Promise<boolean> => sysAny(async (tx) => (await tx.query('SELECT 1 FROM app.secrets WHERE id = $1', [id])).rows.length > 0);

beforeAll(async () => {
  db = await createTestDatabase({ sources: [testKernelMigrationSource, teamsMigrationSource, channelsMigrationSource, botsMigrationSource, approvalsMigrationSource, connectionsMigrationSource] });
  await createPersonas(db);
  appPool = createAppPool(db.appUrl, 4);
  sysPool = createSystemPool(db.systemUrl, 2);
  botActor = (await sys((tx) => tx.query<{ id: string }>(`INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`, [omar.workspaceId, randomUUID()]))).rows[0]!.id;
  await sys(async (tx) => {
    await tx.query(`INSERT INTO app.connection_oauth_apps (workspace_id, provider, client_id) VALUES ($1, 'google', 'the-client-id')`, [omar.workspaceId]);
    secretId = await seal(tx, omar.workspaceId);
    await tx.query(`INSERT INTO app.connection_oauth_app_secrets (workspace_id, provider, secret_id) VALUES ($1, 'google', $2)`, [omar.workspaceId, secretId]);
  });
  otherWorkspace = await sysAny(async (tx) => {
    const workspace = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('other-ws', 'Other') RETURNING id`)).rows[0]!.id;
    await tx.query(`INSERT INTO app.connection_oauth_apps (workspace_id, provider, client_id) VALUES ($1, 'google', 'other-workspace-client')`, [workspace]);
    return workspace;
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

describe('the OAuth apps of a workspace', () => {
  it('are read by the workspace admins (their own workspace only) and by nobody else', async () => {
    expect(await as(omar, async (tx) => (await tx.query<{ client_id: string }>('SELECT client_id FROM app.connection_oauth_apps')).rows.map((r) => r.client_id))).toEqual(['the-client-id']);
    for (const person of [nadia, tariq, sameera, lena]) {
      expect(await as(person, async (tx) => (await tx.query('SELECT 1 FROM app.connection_oauth_apps')).rows.length), person.name).toBe(0);
    }
    expect(await asBot(async (tx) => (await tx.query('SELECT 1 FROM app.connection_oauth_apps')).rows.length)).toBe(0);
  });

  it('are written by the system only: not even an admin can put one in, change one or remove one', async () => {
    expect(await code(as(omar, (tx) => tx.query(`INSERT INTO app.connection_oauth_apps (workspace_id, provider, client_id) VALUES ($1, 'microsoft', 'x')`, [omar.workspaceId])))).toBeDefined();
    // the application role holds the SELECT privilege only
    expect(await code(as(omar, (tx) => tx.query(`UPDATE app.connection_oauth_apps SET client_id = 'changed' WHERE provider = 'google'`)))).toBe('42501');
    expect(await code(as(omar, (tx) => tx.query(`DELETE FROM app.connection_oauth_apps WHERE provider = 'google'`)))).toBe('42501');
    expect(
      await sys(async (tx) => (await tx.query<{ client_id: string }>(`SELECT client_id FROM app.connection_oauth_apps WHERE provider = 'google' AND workspace_id = $1`, [omar.workspaceId])).rows.map((r) => r.client_id)),
    ).toEqual(['the-client-id']);
  });

  it('keep the secret out of every person-facing role: no privilege on the table, and none on the sealed row', async () => {
    for (const person of [omar, nadia, tariq, sameera, lena]) {
      expect(await code(as(person, (tx) => tx.query('SELECT 1 FROM app.connection_oauth_app_secrets'))), person.name).toBe('42501');
      expect(await code(as(person, (tx) => tx.query(`INSERT INTO app.connection_oauth_app_secrets (workspace_id, provider, secret_id) VALUES ($1, 'microsoft', $2)`, [omar.workspaceId, secretId]))), person.name).toBe('42501');
      expect(await code(as(person, (tx) => tx.query('SELECT 1 FROM app.secrets'))), person.name).toBe('42501');
    }
    expect(await code(asBot((tx) => tx.query('SELECT 1 FROM app.connection_oauth_app_secrets')))).toBe('42501');
  });

  it('a secret names an app of its own workspace and provider, and takes the sealed value with it when the app goes', async () => {
    expect(await code(sys((tx) => tx.query(`INSERT INTO app.connection_oauth_app_secrets (workspace_id, provider, secret_id) VALUES ($1, 'notion', $2)`, [omar.workspaceId, secretId])))).toBe('23503');
    expect(await exists(secretId)).toBe(true);
    await sys((tx) => tx.query(`DELETE FROM app.connection_oauth_apps WHERE provider = 'google' AND workspace_id = $1`, [omar.workspaceId]));
    expect(await exists(secretId)).toBe(false);
    expect(await sys(async (tx) => (await tx.query('SELECT 1 FROM app.connection_oauth_app_secrets')).rows.length)).toBe(0);
  });

  it('go with their workspace, sealed value included', async () => {
    const doomed = await sysAny(async (tx) => {
      const workspace = (await tx.query<{ id: string }>(`INSERT INTO app.workspaces (slug, name) VALUES ('doomed-ws', 'Doomed') RETURNING id`)).rows[0]!.id;
      await tx.query(`INSERT INTO app.connection_oauth_apps (workspace_id, provider, client_id) VALUES ($1, 'google', 'doomed-client')`, [workspace]);
      const id = await seal(tx, workspace);
      await tx.query(`INSERT INTO app.connection_oauth_app_secrets (workspace_id, provider, secret_id) VALUES ($1, 'google', $2)`, [workspace, id]);
      return { workspace, id };
    });
    expect(await exists(doomed.id)).toBe(true);
    await sysAny((tx) => tx.query('DELETE FROM app.workspaces WHERE id = $1', [doomed.workspace]));
    expect(await exists(doomed.id)).toBe(false);
    // and the other workspace's app is untouched
    expect(await sysAny(async (tx) => (await tx.query('SELECT 1 FROM app.connection_oauth_apps WHERE workspace_id = $1', [otherWorkspace])).rows.length)).toBe(1);
  });
});
