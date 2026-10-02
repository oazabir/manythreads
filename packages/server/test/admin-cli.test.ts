import { Readable } from 'node:stream';
import { createSystemPool, verifyPassword, withSystem } from '@manythreads/kernel';
import { createApiClient, createPersonas, startTestServer, NADIA, OMAR, PERSONA_PASSWORD, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readPassword, runAdmin, type AdminIo } from '../src/cli/admin.ts';

const NEW_PASSWORD = 'a-brand-new-passphrase';

/** GET /api/session answers 200 for everybody; only a live session says `authenticated: true`. */
const authenticated = async (c: ReturnType<typeof createApiClient>): Promise<boolean> =>
  ((await (await c.get('/api/session')).json()) as { authenticated?: boolean }).authenticated === true;

describe('admin set-password', () => {
  let s: TestServer;
  beforeAll(async () => {
    s = await startTestServer();
    await createPersonas(s.db);
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const sql = <T>(text: string, values: unknown[] = []): Promise<T[]> =>
    withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });

  async function run(argv: string[], stdin: string, tty = false) {
    const out: string[] = [];
    const err: string[] = [];
    const input = Object.assign(Readable.from([Buffer.from(stdin)]), { isTTY: tty });
    const io: AdminIo = {
      stdin: input,
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      env: { NODE_ENV: 'test' },
      pool: () => createSystemPool(s.db.systemUrl, 2),
    };
    const code = await runAdmin(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const hashOf = async (personId: string): Promise<string> =>
    (await sql<{ hash: string }>('SELECT hash FROM app.password_credentials WHERE person_id = $1', [personId]))[0]?.hash ?? '';

  it('strips exactly one trailing line break from stdin', async () => {
    expect(await readPassword(Readable.from(['pass word\n']))).toBe('pass word');
    expect(await readPassword(Readable.from(['pass word\r\n']))).toBe('pass word');
    expect(await readPassword(Readable.from(['pass word\n\n']))).toBe('pass word\n');
    expect(await readPassword(Readable.from(['pa', 'ss']))).toBe('pass');
  });

  it('rejects a password under 12 characters and changes nothing', async () => {
    const before = await hashOf(OMAR.personId);
    const r = await run(['set-password', OMAR.email], 'only-11-chr\n');
    expect(r.code).toBe(2);
    expect(r.err).toContain('at least 12 characters');
    expect(await hashOf(OMAR.personId)).toBe(before);
  });

  it('fails for an unknown email and for usage mistakes, without echoing the password', async () => {
    const unknown = await run(['set-password', 'nobody@kahf.example'], `${NEW_PASSWORD}\n`);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain('No person has the email nobody@kahf.example');
    expect(unknown.err + unknown.out).not.toContain(NEW_PASSWORD);
    expect((await run([], '')).code).toBe(2);
    expect((await run(['set-password'], NEW_PASSWORD)).code).toBe(2);
    expect((await run(['set-password', 'a@b.c', 'extra'], NEW_PASSWORD)).code).toBe(2);
    expect((await run(['frobnicate', OMAR.email], NEW_PASSWORD)).code).toBe(2);
    const tty = await run(['set-password', OMAR.email], '', true);
    expect(tty.code).toBe(2);
    expect(tty.err).toContain('standard input');
  });

  it('refuses a suspended person', async () => {
    await sql("UPDATE app.people SET status = 'suspended' WHERE id = $1", [NADIA.personId]);
    try {
      const r = await run(['set-password', NADIA.email], `${NEW_PASSWORD}\n`);
      expect(r.code).toBe(1);
      expect(r.err).toContain('suspended');
    } finally {
      await sql("UPDATE app.people SET status = 'active' WHERE id = $1", [NADIA.personId]);
    }
  });

  it('sets an argon2id hash, signs the person out everywhere, audits it, and the new password signs in', async () => {
    const old = createApiClient(s.url);
    expect((await old.signIn(OMAR.email, PERSONA_PASSWORD)).status).toBe(200);
    expect(await authenticated(old)).toBe(true);
    const other = createApiClient(s.url);
    expect((await other.signIn(NADIA.email, PERSONA_PASSWORD)).status).toBe(200);

    const r = await run(['set-password', OMAR.email.toUpperCase()], `${NEW_PASSWORD}\n`);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Password set for ${OMAR.email}; 1 active session signed out.`);
    expect(r.out).not.toContain(NEW_PASSWORD);

    const hash = await hashOf(OMAR.personId);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(hash, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, PERSONA_PASSWORD)).toBe(false);

    // Omar's old session is gone, somebody else's is untouched
    expect(await authenticated(old)).toBe(false);
    expect(await authenticated(other)).toBe(true);
    const live = await sql<{ n: number }>('SELECT count(*)::int AS n FROM app.sessions WHERE person_id = $1 AND revoked_at IS NULL', [OMAR.personId]);
    expect(live[0]?.n).toBe(0);

    const fresh = createApiClient(s.url);
    expect((await fresh.signIn(OMAR.email, PERSONA_PASSWORD)).status).toBe(401);
    expect((await fresh.signIn(OMAR.email, NEW_PASSWORD)).status).toBe(200);

    const events = await sql<{ payload: Record<string, unknown>; workspace_id: string }>(
      "SELECT payload, workspace_id FROM app.events WHERE type = 'identity.password.admin_set'",
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ personId: OMAR.personId, sessionsRevoked: 1 });
    expect(events[0]?.workspace_id).toBe(OMAR.workspaceId);
    // the password is nowhere in the audit trail
    const trail = await sql<{ t: string }>('SELECT payload::text AS t FROM app.events');
    expect(trail.map((e) => e.t).join('\n')).not.toContain(NEW_PASSWORD);
  });

  it('creates a credential for a person who had none (OIDC-only)', async () => {
    await sql('DELETE FROM app.password_credentials WHERE person_id = $1', [NADIA.personId]);
    const r = await run(['set-password', NADIA.email], NEW_PASSWORD);
    expect(r.code).toBe(0);
    expect(await verifyPassword(await hashOf(NADIA.personId), NEW_PASSWORD)).toBe(true);
  });
});

describe('admin kms-rewrap', () => {
  let s: TestServer;
  beforeAll(async () => {
    // No job worker: the job must stay `ready` so the test can look at it (the worker host has its own test).
    s = await startTestServer({ jobWorkers: false });
  }, 120_000);
  afterAll(async () => {
    await s.close();
  });

  const sql = <T>(text: string, values: unknown[] = []): Promise<T[]> =>
    withSystem(async (tx) => (await tx.query(text, values)).rows as T[], { pool: s.pools.system });

  async function run(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const io: AdminIo = {
      stdin: Object.assign(Readable.from([]), { isTTY: false }),
      out: (l) => void out.push(l),
      err: (l) => void err.push(l),
      env: { NODE_ENV: 'test' },
      pool: () => createSystemPool(s.db.systemUrl, 2),
    };
    const code = await runAdmin(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('queues one kms.rewrap job, and asking again returns that job instead of adding another', async () => {
    expect(s.jobQueues).toEqual([]);
    const first = await run(['kms-rewrap']);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^Key re-wrap queued \(job [0-9a-f-]{36}\)/);
    const jobs = await sql<{ id: string; state: string; queue: string }>(`SELECT id, state, queue FROM app.jobs WHERE queue = 'kms.rewrap'`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ state: 'ready' });
    expect(first.out).toContain(jobs[0]?.id);

    const again = await run(['kms-rewrap']);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/^A key re-wrap is already waiting or running \(job /);
    expect(again.out).toContain(jobs[0]?.id);
    expect(await sql(`SELECT id FROM app.jobs WHERE queue = 'kms.rewrap'`)).toHaveLength(1);
  });

  it('takes no arguments and is named in the usage text', async () => {
    const extra = await run(['kms-rewrap', 'now']);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain('kms-rewrap');
    const unknown = await run(['frobnicate']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('admin kms-rewrap');
  });
});
