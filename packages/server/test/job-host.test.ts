import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPostgresKms,
  enqueueKmsRewrap,
  getKms,
  getSecret,
  putSecret,
  resetKms,
  withSystem,
  type Tx,
} from '@manythreads/kernel';
import { createPersonas, NADIA, startTestServer, type TestServer } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P3-00: the server hosts job workers for the kernel's kms.rewrap queue and for queues plugins register with ctx.jobs.register.

const keys = { old: randomBytes(32), current: randomBytes(32) };
const saved = { key: process.env['MANYTHREADS_KMS_KEY'], previous: process.env['MANYTHREADS_KMS_PREVIOUS_KEYS'] };

let s: TestServer;
beforeAll(async () => {
  // The process Kms is read from the environment; rotate it before the server's worker first needs it.
  process.env['MANYTHREADS_KMS_KEY'] = keys.current.toString('base64');
  process.env['MANYTHREADS_KMS_PREVIOUS_KEYS'] = keys.old.toString('base64');
  resetKms();
  s = await startTestServer();
  await createPersonas(s.db);
}, 120_000);
afterAll(async () => {
  await s?.close();
  for (const [name, value] of [['MANYTHREADS_KMS_KEY', saved.key], ['MANYTHREADS_KMS_PREVIOUS_KEYS', saved.previous]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetKms();
});

const system = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => withSystem(fn, { pool: s.pools.system });
const until = async <T>(read: () => Promise<T | undefined>, what: string, ms = 20_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const jobState = async (id: string) =>
  (await system((tx) => tx.query<{ state: string; attempts: number }>('SELECT state, attempts FROM app.jobs WHERE id = $1', [id]))).rows[0];
const deliveries = async (note: string) =>
  (await system((tx) => tx.query<{ event: Record<string, unknown> }>(`SELECT event FROM app.test_kernel_deliveries WHERE event->>'note' = $1 ORDER BY created_at`, [note]))).rows.map((r) => r.event);

const post = (path: string, body: unknown) =>
  fetch(`${s.url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: NADIA.actorId, workspaceId: NADIA.workspaceId }),
    },
    body: JSON.stringify(body),
  });

describe('job worker host', () => {
  it('starts a worker for the kernel queue and for each plugin queue', () => {
    const registered = s.host.registries.jobs.list().map((e) => e.value.queue);
    expect([...s.jobQueues].sort()).toEqual(['kms.rewrap', ...registered].sort());
    // Plugins of other tasks add queues of their own: assert the ones this test relies on, not the whole list.
    expect(registered).toEqual(expect.arrayContaining(['test-kernel.record', 'files.blob-gc']));
    expect(s.host.registries.jobs.list().find((e) => e.value.queue === 'test-kernel.record')?.plugin).toBe('test-kernel');
  });

  it('runs a plugin job as the system actor in the payload workspace, then marks it done', async () => {
    const note = `ok-${randomUUID()}`;
    const res = await post('/api/test/jobs', { note });
    expect(res.status).toBe(200);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await until(async () => ((await jobState(jobId))?.state === 'done' ? true : undefined), 'the job to finish')).toBe(true);
    expect(await deliveries(note)).toEqual([{ type: 'job', note, attempt: 1, actor: 'system' }]);
  });

  it('a failing attempt rolls its writes back and is retried; the retry commits', async () => {
    const note = `retry-${randomUUID()}`;
    const { jobId } = (await (await post('/api/test/jobs', { note, fail: true })).json()) as { jobId: string };
    await until(async () => ((await jobState(jobId))?.state === 'done' ? true : undefined), 'the retry to finish');
    // The first attempt inserted a row and then threw: only the second attempt's row exists.
    expect(await deliveries(note)).toEqual([{ type: 'job', note, attempt: 2, actor: 'system' }]);
    expect((await jobState(jobId))?.attempts).toBe(2);
  });

  it('the kms.rewrap queue moves a secret from the previous master key to the current one', async () => {
    const oldKms = createPostgresKms({ masterKey: keys.old });
    const id = await system((tx) => putSecret(tx, 'hunter2', oldKms));
    const keyOf = async () => (await system((tx) => tx.query<{ key_id: string }>('SELECT key_id FROM app.secrets WHERE id = $1', [id]))).rows[0]?.key_id;
    expect(await keyOf()).toBe(oldKms.keyId);

    const job = await system((tx) => enqueueKmsRewrap(tx));
    await until(async () => ((await jobState(job.id))?.state === 'done' ? true : undefined), 'kms.rewrap to finish');
    expect(await keyOf()).toBe(getKms().keyId);
    expect(getKms().keyId).not.toBe(oldKms.keyId);
    expect(await system((tx) => getSecret(tx, id))).toBe('hunter2');
  });
});
