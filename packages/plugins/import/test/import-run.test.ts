import type { ImportRun } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildZip } from './zip-builder.ts';
import { createWorld, eventually, personas, type World } from './world.ts';

const { omar, nadia } = personas;

// How a run behaves over time: a second archive that overlaps the first (what a stopped and restarted import looks like), a cancel, a person whose address
// is typed but not verified, and text that must never notify anybody.

let w: World;
beforeAll(async () => {
  w = await createWorld();
}, 120_000);
afterAll(async () => {
  await w.close();
});

const waitFor = (id: string, status: ImportRun['status'][], what: string): Promise<ImportRun> =>
  eventually(async () => {
    const run = (await w.call<ImportRun>(omar, 'GET', `/api/admin/imports/${id}`)).body;
    return status.includes(run.status) ? run : undefined;
  }, 90_000, what);

const ts = (n: number): string => `${1_709_546_400 + n * 60}.${String(n + 1).padStart(6, '0')}`;
const users = [
  { id: 'U1', name: 'omar', profile: { email: 'omar@kahf.example', real_name: 'Omar' } },
  { id: 'U2', name: 'nadia', profile: { email: 'nadia@kahf.example', real_name: 'Nadia' } },
  { id: 'U3', name: 'pending', profile: { email: 'pending@kahf.example', real_name: 'Pending Person' } },
];
/** A room of `count` messages; message 5 starts a thread whose reply is message 150 (so a short archive holds the root and a long one the reply). */
function room(count: number, name = 'resume-room'): Buffer {
  const messages: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    const m: Record<string, unknown> = { type: 'message', user: users[i % 3]!.id, text: `message ${i} about plans`, ts: ts(i) };
    if (i === 5) Object.assign(m, { thread_ts: ts(5), reply_count: 1, text: 'the thread starts here with <@U2> and <!channel> and <https://example.com/x|a link>' });
    if (i === 150) Object.assign(m, { thread_ts: ts(5) });
    if (i === 7) m['reactions'] = [{ name: 'tada', users: ['U1', 'U2', 'U3'], count: 3 }];
    messages.push(m);
  }
  const byDay = new Map<string, Record<string, unknown>[]>();
  for (const m of messages) {
    const day = new Date(Number(String(m['ts']).split('.')[0]) * 1000).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }
  return buildZip([
    { name: 'users.json', data: JSON.stringify(users) },
    { name: 'channels.json', data: JSON.stringify([{ id: 'C1', name, members: ['U1', 'U2'] }]) },
    ...[...byDay].map(([day, list]) => ({ name: `${name}/${day}.json`, data: JSON.stringify(list) })),
  ]);
}

async function importArchive(bytes: Uint8Array): Promise<ImportRun> {
  const up = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', bytes);
  expect(up.status).toBe(201);
  expect((await w.call(omar, 'POST', `/api/admin/imports/${up.body.id}/dry-run`)).status).toBe(202);
  await waitFor(up.body.id, ['analysed'], 'the dry run');
  expect((await w.call(omar, 'POST', `/api/admin/imports/${up.body.id}/start`)).status).toBe(202);
  return waitFor(up.body.id, ['done', 'failed', 'cancelled'], 'the import');
}

const roomId = (): Promise<string> =>
  w.system(async (tx) => (await tx.query<{ id: string }>("SELECT target_id AS id FROM app.import_map WHERE source = 'slack' AND kind = 'channel' AND source_id LIKE '%/C1'")).rows[0]!.id);

describe('a second archive that overlaps the first', () => {
  it('writes only what the first did not, and finds an earlier thread root', async () => {
    const first = await importArchive(room(120));
    expect(first.status).toBe('done');
    expect(first.result!.messages.imported).toBe(120);
    const second = await importArchive(room(250));
    expect(second.status).toBe('done');
    expect(second.result!.messages.alreadyImported).toBe(120);
    expect(second.result!.messages.imported).toBe(130);
    // the reply at message 150 went under the root written by the first run
    const rows = await w.system(async (tx) =>
      (await tx.query<{ n: number; replies: number; root_ok: boolean }>(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE r.thread_root_id IS NOT NULL)::int AS replies,
                bool_and(r.thread_root_id IS NULL OR root.meta -> 'importedFrom' ->> 'id' = $1) AS root_ok
           FROM app.messages r LEFT JOIN app.messages root ON root.id = r.thread_root_id WHERE r.meta ? 'importedFrom'`,
        [`C1:${ts(5)}`],
      )).rows[0]!,
    );
    expect(rows.n).toBe(250);
    expect(rows.replies).toBe(1);
    expect(rows.root_ok).toBe(true);
    const channels = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.channels WHERE name LIKE 'resume-room%'")).rows[0]!.n);
    expect(channels).toBe(1);
  });

  it('wrote mentions, links and reactions as plain content that notifies nobody', async () => {
    const id = await roomId();
    const root = await w.system(async (tx) => (await tx.query<{ body: string }>("SELECT body FROM app.messages WHERE meta -> 'importedFrom' ->> 'id' = $1", [`C1:${ts(5)}`])).rows[0]!);
    expect(root.body).toContain('@nadia');
    expect(root.body).toContain('@channel');
    expect(root.body).toContain('[a link](https://example.com/x)');
    expect(root.body).not.toContain('<@');
    const notified = await w.system(async (tx) => (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM app.notifications WHERE channel_id = $1', [id])).rows[0]!.n);
    expect(notified).toBe(0);
    const events = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'channel.message.posted'")).rows[0]!.n);
    expect(events).toBe(0);
    const seventh = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.messages WHERE meta -> 'importedFrom' ->> 'id' = $1", [`C1:${ts(7)}`])).rows[0]!.id);
    const one = await w.call<{ reactions: { emoji: string; count: number }[] }>(omar, 'GET', `/api/channels/${id}/messages/${seventh}`);
    expect(one.status).toBe(200);
    expect(one.body.reactions).toHaveLength(1);
    expect(one.body.reactions[0]!.count).toBe(3);
  });

  it('does not match a person whose address is typed but not verified, and matches them once it is', async () => {
    const before = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.import_people WHERE email = 'pending@kahf.example'")).rows[0]!.n);
    expect(before).toBe(1);
    // an unverified address is only a claim
    const person = await w.system(async (tx) => {
      const id = (await tx.query<{ id: string }>("INSERT INTO app.people (workspace_id, display_name, primary_email) VALUES ($1, 'Pending', 'pending@kahf.example') RETURNING id", [omar.workspaceId])).rows[0]!.id;
      await tx.query("INSERT INTO app.person_emails (workspace_id, person_id, email) VALUES ($1, $2, 'pending@kahf.example')", [omar.workspaceId, id]);
      await tx.query("INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('person', $1, $2)", [omar.workspaceId, id]);
      return id;
    });
    const unclaimed = await w.system(async (tx) => (await tx.query<{ claimed_at: Date | null }>("SELECT claimed_at FROM app.import_people WHERE email = 'pending@kahf.example'")).rows[0]!);
    expect(unclaimed.claimed_at).toBeNull();
    await w.system(async (tx) => {
      await tx.query('UPDATE app.person_emails SET verified_at = now() WHERE person_id = $1', [person]);
    });
    const claimed = await w.system(async (tx) => (await tx.query<{ claimed_by: string | null }>("SELECT claimed_by FROM app.import_people WHERE email = 'pending@kahf.example'")).rows[0]!);
    expect(claimed.claimed_by).toBe(person);
  });
});

describe('cancelling', () => {
  it('stops a queued import before it writes, keeps what is there, and says so', async () => {
    const up = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', room(300, 'cancel-room'));
    await w.call(omar, 'POST', `/api/admin/imports/${up.body.id}/dry-run`);
    await waitFor(up.body.id, ['analysed'], 'the dry run');
    expect((await w.call(omar, 'POST', `/api/admin/imports/${up.body.id}/start`)).status).toBe(202);
    const cancel = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${up.body.id}/cancel`);
    expect(cancel.status).toBe(202);
    const run = await waitFor(up.body.id, ['cancelled', 'done'], 'the cancel');
    // The job may have finished before the cancel arrived on a fast machine, or not have started (then the cancel ends the run itself and there is no
    // report to read); either way the run ends.
    expect(['cancelled', 'done']).toContain(run.status);
    // a job that had already read the run as queued must not turn the cancelled run back into a running one
    await new Promise((r) => setTimeout(r, 1500));
    expect((await w.call<ImportRun>(omar, 'GET', `/api/admin/imports/${up.body.id}`)).body.status).toBe(run.status);
    if (run.status === 'done') expect(run.result).not.toBeNull();
    if (run.status === 'cancelled' && run.result) expect(run.result.messages.imported).toBeLessThan(300);
    // cancelling something that has ended is refused
    expect((await w.call(omar, 'POST', `/api/admin/imports/${up.body.id}/cancel`)).status).toBe(409);
    expect((await w.call(nadia, 'POST', `/api/admin/imports/${up.body.id}/cancel`)).status).toBe(403);
  });

  it('refuses a second import started while one is running or queued', async () => {
    const a = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', room(40, 'busy-a'));
    const b = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', room(40, 'busy-b'));
    for (const r of [a, b]) {
      await w.call(omar, 'POST', `/api/admin/imports/${r.body.id}/dry-run`);
      await waitFor(r.body.id, ['analysed'], 'the dry run');
    }
    // make a look queued without the job picking it up: a run in status queued blocks the other start
    await w.system(async (tx) => {
      await tx.query("UPDATE app.import_runs SET status = 'running' WHERE id = $1", [a.body.id]);
    });
    const start = await w.call<{ error: { message: string } }>(omar, 'POST', `/api/admin/imports/${b.body.id}/start`);
    expect(start.status).toBe(409);
    expect(start.body.error.message).toMatch(/another import/i);
    await w.system(async (tx) => {
      await tx.query("UPDATE app.import_runs SET status = 'cancelled' WHERE id = $1", [a.body.id]);
    });
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${a.body.id}`)).status).toBe(200);
  });

  it('refuses to delete a run that is still going', async () => {
    const up = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', room(10, 'del-room'));
    await w.system(async (tx) => {
      await tx.query("UPDATE app.import_runs SET status = 'running' WHERE id = $1", [up.body.id]);
    });
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${up.body.id}`)).status).toBe(409);
    await w.system(async (tx) => {
      await tx.query("UPDATE app.import_runs SET status = 'uploaded' WHERE id = $1", [up.body.id]);
    });
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${up.body.id}`)).status).toBe(200);
    expect((await w.call(omar, 'GET', `/api/admin/imports/${up.body.id}`)).status).toBe(404);
  });
});

// Runs that no job holds: a server killed in the middle of a run leaves it queued, analysing or running for ever.
describe('a run that nothing works on any more', () => {
  const setRun = (id: string, status: string, minutesOld = 0): Promise<void> =>
    w.system(async (tx) => {
      await tx.query("UPDATE app.import_runs SET status = $2, updated_at = now() - make_interval(mins => $3) WHERE id = $1", [id, status, minutesOld]);
    });
  const uploaded = async (name: string): Promise<ImportRun> => {
    const up = await w.upload<ImportRun>(omar, 'source=slack&team=engineering', room(10, name));
    expect(up.status).toBe(201);
    return up.body;
  };
  const row = (id: string) => w.system(async (tx) => (await tx.query<{ status: string; error: string | null; blob_key: string | null; finished_at: Date | null }>('SELECT status, error, blob_key, finished_at FROM app.import_runs WHERE id = $1', [id])).rows[0]!);
  const jobState = (id: string) => w.system(async (tx) => (await tx.query<{ state: string }>('SELECT state FROM app.jobs WHERE id = $1', [id])).rows[0]?.state);
  const sweep = async (): Promise<void> => {
    const id = await w.system(async (tx) => {
      const job = (await tx.query<{ id: string }>("SELECT (app.enqueue_job('import.sweep', '{}'::jsonb, now() + interval '1 hour', NULL)).id AS id")).rows[0]!.id;
      await tx.query('UPDATE app.jobs SET run_at = now() WHERE id = $1', [job]);
      await tx.query("SELECT pg_notify('manythreads_jobs', 'import.sweep')");
      return job;
    });
    await eventually(async () => ((await jobState(id)) === 'done' || (await jobState(id)) === 'dead' ? true : undefined), 30_000, 'the sweep');
  };

  it('ends at once when cancelled while queued, and can then be removed', async () => {
    const run = await uploaded('queued-lost');
    await setRun(run.id, 'queued');
    const cancel = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.status).toBe('cancelled');
    expect(cancel.body.finishedAt).not.toBeNull();
    expect((await row(run.id)).blob_key).toBeNull();
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`)).status).toBe(200);
  });

  it('ends at once when cancelled while its dry run is going, and can then be removed', async () => {
    const run = await uploaded('analysing-lost');
    await setRun(run.id, 'analysing');
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`)).status).toBe(409);
    const cancel = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/cancel`);
    expect(cancel.body.status).toBe('cancelled');
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${run.id}`)).status).toBe(200);
  });

  it('asks a running import to stop after its batch instead of ending it from the request', async () => {
    const run = await uploaded('running-held');
    await setRun(run.id, 'running');
    const cancel = await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${run.id}/cancel`);
    expect(cancel.status).toBe(202);
    expect(cancel.body.status).toBe('running');
    expect(cancel.body.cancelRequested).toBe(true);
    await setRun(run.id, 'cancelled');
  });

  it('is ended as failed by the sweep once it is 30 minutes old and no job holds it, which frees the workspace', async () => {
    const lost = await uploaded('lost-running');
    const lostDry = await uploaded('lost-analysing');
    const held = await uploaded('held-running');
    const fresh = await uploaded('fresh-running');
    await setRun(lost.id, 'running', 31);
    await setRun(lostDry.id, 'analysing', 45);
    await setRun(held.id, 'running', 90);
    await setRun(fresh.id, 'running', 5);
    // a job that is still waiting for `held` (far in the future, so nothing picks it up) means somebody is on it
    await w.system(async (tx) => {
      await tx.query("INSERT INTO app.jobs (queue, payload, state, run_at) VALUES ('import.run', $1::jsonb, 'ready', now() + interval '1 day')", [JSON.stringify({ workspaceId: omar.workspaceId, runId: held.id })]);
    });
    const next = await uploaded('next-up');
    await w.call(omar, 'POST', `/api/admin/imports/${next.id}/dry-run`);
    await waitFor(next.id, ['analysed'], 'the dry run');
    const blocked = await w.call<{ error: { message: string } }>(omar, 'POST', `/api/admin/imports/${next.id}/start`);
    expect(blocked.status).toBe(409);

    await sweep();
    const a = await row(lost.id);
    expect(a.status).toBe('failed');
    expect(a.error).toMatch(/server was restarted/);
    expect(a.blob_key).toBeNull();
    expect(a.finished_at).not.toBeNull();
    const b = await row(lostDry.id);
    expect(b.status).toBe('failed');
    expect(b.error).toMatch(/dry run stopped/i);
    expect((await row(held.id)).status).toBe('running');
    expect((await row(fresh.id)).status).toBe('running');
    // the failed ones can be removed, and the audit trail says what happened to the lost import
    expect((await w.call(omar, 'DELETE', `/api/admin/imports/${lost.id}`)).status).toBe(200);
    const events = await w.system(async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM app.events WHERE type = 'import.run.finished' AND payload ->> 'runId' = $1 AND payload ->> 'outcome' = 'failed'", [lost.id])).rows[0]!.n);
    expect(events).toBe(1);
    // still blocked by the two that are held or fresh; cancel them and the next import can start
    for (const r of [held, fresh]) expect((await w.call<ImportRun>(omar, 'POST', `/api/admin/imports/${r.id}/cancel`)).status).toBe(202);
    for (const r of [held, fresh]) await setRun(r.id, 'cancelled');
    expect((await w.call(omar, 'POST', `/api/admin/imports/${next.id}/start`)).status).toBe(202);
    await waitFor(next.id, ['done', 'failed', 'cancelled'], 'the import');
  });
});

describe('the progress bar', () => {
  it('counts the messages the import will write, so it ends full when messages are left out', async () => {
    const day = (n: number): string => new Date((1_709_546_400 + n * 60) * 1000).toISOString().slice(0, 10);
    const messages = Array.from({ length: 12 }, (_, i) => ({ type: 'message', user: 'U1', text: `line ${i}`, ts: ts(i), ...(i % 4 === 3 ? { subtype: 'channel_join' } : {}) }));
    const zip = buildZip([
      { name: 'users.json', data: JSON.stringify(users) },
      { name: 'channels.json', data: JSON.stringify([{ id: 'CPROG', name: 'progress-room', members: ['U1'] }]) },
      { name: `progress-room/${day(0)}.json`, data: JSON.stringify(messages) },
    ]);
    const run = await importArchive(zip);
    expect(run.status).toBe('done');
    expect(run.dryRun!.messages.total).toBe(12);
    expect(run.result!.messages.imported).toBe(9);
    expect(run.progress!.messagesTotal).toBe(9);
    expect(run.progress!.messagesDone).toBe(9);
  });
});
