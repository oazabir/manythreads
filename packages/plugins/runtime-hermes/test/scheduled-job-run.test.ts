import { randomUUID as randomUuid } from 'node:crypto';
import { emit } from '@manythreads/kernel';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { applyScheduledJobOverrides, writePersonalOutput } from '../src/scheduled-job-run.ts';
import { buildScheduledJobPrompt } from '../src/router-scheduled-jobs.ts';
import { buildPersonalRoutinePrompt } from '../src/router-personal-routines.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// A scheduled job's firing starts its bot (PLAN P6-08; SPEC §6.4, §6.5): the `routine` trigger end to end. The stand-in for Hermes is a script that
// records the prompt it read on stdin and answers with page-like text (or with nothing when the prompt says NOOUTPUT); the platform's half
// (the schedule tick, the events, the router, the run job, the page write, the ledger) is what runs.

const { omar } = personas;
vi.setConfig({ testTimeout: 180_000 });

// The stand-in: `node <script> chat ...`, the query on stdin; it records what it was handed and answers with the prompt it read.
const FAKE_HERMES = [
  "import { appendFileSync, readFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "const home = process.env.HERMES_HOME ?? '';",
  "const record = { homeName: home.slice(home.lastIndexOf('/') + 1), prompt };",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify(record) + '\\n');",
  "if (prompt.includes('CRASH')) { process.stdout.write(JSON.stringify({ type: 'result', exit_code: 1, text: '', error: 'model fell over' }) + '\\n'); process.exit(1); }",
  "const reply = prompt.includes('NOOUTPUT') ? '' : '# Report\\n\\nDone: ' + prompt.split('\\n')[0];",
  "process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } }) + '\\n');",
  '',
].join('\n');

/** One definition, with the pieces a test takes away named as parameters. */
const botMd = (parts: { name: string; model?: string; capabilities?: string; triggers?: string[]; handover?: string[]; extra?: string[] }): string =>
  [
    '---',
    'schema: 1',
    `name: ${parts.name}`,
    'role: Answers a mention in the run test',
    'kind: agent',
    'runtime: hermes',
    ...(parts.model ? ['model:', `  aliases: [${parts.model}]`] : []),
    'triggers:',
    ...(parts.triggers ?? ['  - type: mention']),
    ...(parts.handover ? ['handover:', `  mayTag: [${parts.handover.join(', ')}]`] : []),
    ...(parts.capabilities ? ['capabilities:', `  native: [${parts.capabilities}]`] : []),
    ...(parts.extra ?? []),
    '---',
    '',
    `# ${parts.name}`,
    '',
    'Soul text of the run test. Everything below the fence is prose.',
    '',
  ].join('\n');

let w: RepoWorld;
let scratch = '';
let spool = '';
let profilesDir = '';
let channelId = '';
const savedEnv: Record<string, string | undefined> = {
  MANYTHREADS_HERMES_BIN: process.env['MANYTHREADS_HERMES_BIN'],
  MANYTHREADS_HERMES_PREFIX: process.env['MANYTHREADS_HERMES_PREFIX'],
  MANYTHREADS_RUNTIME_DIR: process.env['MANYTHREADS_RUNTIME_DIR'],
  MANYTHREADS_LITELLM_URL: process.env['MANYTHREADS_LITELLM_URL'],
  MANYTHREADS_TEST_CANARY: process.env['MANYTHREADS_TEST_CANARY'],
  HERMES_FAKE_SPOOL: process.env['HERMES_FAKE_SPOOL'],
};

/** Poll until `fn` answers something; the throw is the failure (the loader, the router or the job never got there). */
const until = async <T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

const spoolLines = (): Record<string, string>[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, string>)
    : [];

interface LoadedBot {
  botId: string;
  actorId: string;
}

/** Commit a BOT.md and wait for the loader to put the bot on the roster, active, with its actor. */
async function loadBot(slug: string, md: string): Promise<LoadedBot> {
  const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: `bots/${slug}/BOT.md`, content: md }], `Add ${slug}`);
  expect(committed.status, JSON.stringify(committed.body)).toBe(201);

  const row = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `SELECT b.id FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug = $1 AND b.status = 'active'`,
          [slug],
        );
        return r.rows[0]?.id ?? null;
      }),
    15_000,
    `the loader to load ${slug}`,
  );
  const actorId = await until(
    () =>
      w.system(async (tx) => {
        const r = await tx.query<{ id: string }>(`SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [row]);
        return r.rows[0]?.id ?? null;
      }),
    5_000,
    `the actor of ${slug}`,
  );
  return { botId: row, actorId };
}


/** Prove a negative by waiting: a sleep is a nap, so negatives below wait on the reply that proves the router decided. */
const quiet = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Every run of a bot, oldest first. */
const runsOf = (
  botId: string,
): Promise<{ id: string; status: string; trigger_type: string; asker_id: string | null; delegation_depth: number }[]> =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string; status: string; trigger_type: string; asker_id: string | null; delegation_depth: number }>(
        `SELECT id, status, trigger_type, asker_id, delegation_depth FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at, id`,
        [botId],
      )
    ).rows,
  );

/**
 * The stand-in's records for one run: one line per process, so its length is "how many processes this run started".
 * The profile home is the absolute directory the child got in `HERMES_HOME`; its name is the bot's slug and the run id.
 */
const callsOf = (slug: string, runId: string): Record<string, string>[] =>
  spoolLines().filter((line) => line['homeName'] === `${slug}-${runId}`);


beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-scheduled-jobs-'));
  spool = join(scratch, 'spool.jsonl');
  profilesDir = join(scratch, 'profiles');
  const bin = join(scratch, 'fake-hermes.mjs');
  writeFileSync(bin, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = bin;
  process.env['MANYTHREADS_RUNTIME_DIR'] = profilesDir;
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;
  w = await createRepoWorld();
  expect((await w.call(omar, 'GET', '/api/teams/engineering/channels')).status).toBe(200);
  channelId = await w.system(async (tx) => {
    const r = await tx.query<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
    return r.rows[0]?.id ?? '';
  });
  expect(channelId).not.toBe('');
}, 180_000);

afterAll(async () => {
  await w?.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});


const TEAM = '/api/teams/engineering';
const scheduledJobBot = (name: string, triggers = ['  - type: routine']): string =>
  botMd({ name, model: 'smart', capabilities: 'messages.post, pages.write', triggers });

/** The channel a scheduled run answers in: the team's first public channel (the bot may post in all of them in this world). */
const homeChannelId = (): Promise<string> =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id
          WHERE t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL ORDER BY c.position, c.created_at, c.id LIMIT 1`,
      )
    ).rows[0]!.id,
  );
const bodiesIn = async (channel: string): Promise<{ id: string; authorId: string; body: string }[]> => {
  const res = await w.call(omar, 'GET', `/api/channels/${channel}/messages?limit=100`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return ListMessagesResponse.parse(res.body).items;
};

const ownerSql = (sql: string, params: unknown[] = []) => w.system(async (tx) => (await tx.query(sql, params)).rows as Record<string, unknown>[]);

/** A scheduled job through the API (a lead makes it); `routines/<slug>.yaml` is committed first for a routine. */
async function makeScheduledJob(input: { bot: string; name: string; kind: 'heartbeat' | 'routine' | 'task'; contract?: string; slug?: string; extra?: Record<string, unknown> }): Promise<string> {
  let contractPath: string | undefined;
  if (input.contract !== undefined) {
    contractPath = `routines/${input.slug ?? input.name.toLowerCase().replace(/\W+/g, '-')}.yaml`;
    const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: contractPath, content: input.contract }], `Add ${contractPath}`);
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  }
  const res = await w.call<{ scheduledJob: { id: string } }>(omar, 'POST', `${TEAM}/scheduled-jobs`, {
    botSlug: input.bot,
    name: input.name,
    kind: input.kind,
    schedule: '0 9 * * *',
    ...(contractPath ? { contractPath } : {}),
    ...(input.extra ?? {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.scheduledJob.id;
}

interface FiringRow {
  id: string;
  status: string;
  run_id: string | null;
  reason: string;
  output_path: string | null;
  ended_at: Date | null;
}
const firingsOf = async (scheduledJobId: string): Promise<FiringRow[]> =>
  (await ownerSql('SELECT id, status, run_id, reason, output_path, ended_at FROM app.scheduled_job_runs WHERE scheduled_job_id = $1 ORDER BY started_at, id', [scheduledJobId])) as unknown as FiringRow[];
const settled = (scheduledJobId: string): Promise<FiringRow> =>
  until(async () => {
    const [row] = await firingsOf(scheduledJobId);
    return row && (row.status === 'done' || row.status === 'failed') ? row : null;
  }, 40_000, 'the firing to settle');

/** The schedule's own tick job, run once; the scheduled job is made due first. */
async function tick(scheduledJobId: string): Promise<void> {
  await ownerSql(`UPDATE app.scheduled_jobs SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [scheduledJobId]);
  await ownerSql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('scheduled-jobs.tick', '{}'::jsonb, now())`);
}
const botRunsFor = async (botId: string) => runsOf(botId);
const jobsOfFiring = async (firingId: string): Promise<number> =>
  Number((await ownerSql(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1`, [`%:scheduledJob:${firingId}`]))[0]?.['n']);

describe('a scheduled job firing starts its bot', () => {
  it('a heartbeat on the schedule: one run, a check-in prompt, the ledger queued -> running -> done, one job for two ticks', async () => {
    const bot = await loadBot('rh-beat', scheduledJobBot('RhBeat'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-beat', name: 'Morning pulse', kind: 'heartbeat' });
    await tick(scheduledJobId);
    await tick(scheduledJobId); // the first tick moved the next slot on, so this one finds nothing due
    const firing = await settled(scheduledJobId);
    expect(firing).toMatchObject({ status: 'done', reason: '' });
    expect(firing.run_id).not.toBeNull();
    expect(firing.ended_at).not.toBeNull();

    const runs = await botRunsFor(bot.botId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: firing.run_id, trigger_type: 'routine', status: 'done', asker_id: null });
    expect(await firingsOf(scheduledJobId)).toHaveLength(1);
    expect(await jobsOfFiring(firing.id)).toBe(1);

    const calls = callsOf('rh-beat', firing.run_id as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]!['prompt']).toContain('Scheduled check-in: the "Morning pulse" scheduled job fired at ');

    // the ledger walked queued -> running -> done: the three announcements are on the record, in that order
    const states = (await ownerSql(`SELECT payload->>'status' AS s FROM app.events WHERE type = 'scheduled_jobs.scheduled_job.ran' AND payload->>'scheduledJobRunId' = $1 ORDER BY id`, [firing.id])).map((r) => r['s']);
    expect(states).toEqual(['queued', 'running', 'done']);
    // a heartbeat's reply is not posted: the bot decides whether to say anything
    expect((await ownerSql(`SELECT 1 FROM app.messages WHERE author_id = $1`, [bot.actorId])).length).toBe(0);
  });

  it('a second delivery of the same event starts no second run', async () => {
    const bot = await loadBot('rh-twice', scheduledJobBot('RhTwice'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-twice', name: 'Twice', kind: 'heartbeat' });
    expect((await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`)).status).toBe(202);
    const firing = await settled(scheduledJobId);
    const reset = await ownerSql(
      `UPDATE app.outbox o SET done_at = NULL, available_at = now() FROM app.events e
        WHERE e.id = o.event_id AND e.type = 'scheduled_jobs.scheduled_job.ran' AND e.payload->>'scheduledJobRunId' = $1 AND e.payload->>'status' = 'queued' AND o.subscriber = 'plugins'
        RETURNING o.id`,
      [firing.id],
    );
    expect(reset.length, 'the plugins subscriber had a delivery to repeat').toBeGreaterThan(0);
    await until(async () => (await ownerSql(`SELECT 1 FROM app.outbox WHERE id = ANY($1::uuid[]) AND done_at IS NULL`, [reset.map((r) => r['id'])])).length === 0, 15_000, 'the redelivery');
    await quiet(2000);
    expect(await botRunsFor(bot.botId)).toHaveLength(1);
    expect(await jobsOfFiring(firing.id)).toBe(1);
  });

  it('a routine writes its page as the bot (mode replace) and the channel shows "wrote … · diff"', async () => {
    const bot = await loadBot('rh-report', scheduledJobBot('RhReport'));
    const contract = ['name: Weekly report', 'prompt: Summarise the week for the team.', 'output:', '  page: pages/reports/rh-week.md', '  mode: replace', ''].join('\n');
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-report', name: 'Weekly report', kind: 'routine', contract });
    expect((await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`)).status).toBe(202);
    const firing = await settled(scheduledJobId);
    expect(firing, JSON.stringify(firing)).toMatchObject({ status: 'done', output_path: 'pages/reports/rh-week.md' });

    const calls = callsOf('rh-report', firing.run_id as string);
    expect(calls[0]!['prompt']).toContain('Summarise the week for the team.');
    expect(calls[0]!['prompt']).toContain('saved as the page pages/reports/rh-week.md');

    const blob = await w.call<{ content?: string }>(omar, 'GET', `${TEAM}/repo/blob?path=${encodeURIComponent('pages/reports/rh-week.md')}`);
    expect(blob.status, JSON.stringify(blob.body)).toBe(200);
    expect(JSON.stringify(blob.body)).toContain('# Report');
    const history = await w.call<{ items: { author?: { id?: string }; authorId?: string }[] }>(omar, 'GET', `${TEAM}/repo/history?path=${encodeURIComponent('pages/reports/rh-week.md')}`);
    expect(JSON.stringify(history.body)).toContain(bot.actorId);

    const posted = await bodiesIn(await homeChannelId());
    const wrote = posted.find((m) => m.authorId === bot.actorId);
    expect(wrote?.body).toContain('wrote [pages/reports/rh-week.md](/t/engineering/files?open=pages%2Freports%2Frh-week.md) · [diff](');
  });

  it('a routine whose run produces nothing fails with the reason and writes no page', async () => {
    await loadBot('rh-empty', scheduledJobBot('RhEmpty'));
    const contract = ['name: Empty', 'prompt: NOOUTPUT please', 'output:', '  page: pages/reports/rh-empty.md', ''].join('\n');
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-empty', name: 'Empty report', kind: 'routine', contract });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The run produced no output, so nothing was written to pages/reports/rh-empty.md.');
    const blob = await w.call(omar, 'GET', `${TEAM}/repo/blob?path=${encodeURIComponent('pages/reports/rh-empty.md')}`);
    expect(blob.status).toBe(404);
  });

  it('append adds to the page and create refuses a page that exists, and says so', async () => {
    await loadBot('rh-modes', scheduledJobBot('RhModes'));
    const pagePath = 'pages/reports/rh-modes.md';
    const contractFor = (mode: string) => ['name: Modes', 'prompt: Write.', 'output:', `  page: ${pagePath}`, `  mode: ${mode}`, ''].join('\n');
    const appendId = await makeScheduledJob({ bot: 'rh-modes', name: 'Modes append', kind: 'routine', contract: contractFor('append') });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${appendId}/run`);
    expect((await settled(appendId)).status).toBe('done');
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${appendId}/run`);
    await until(async () => (await firingsOf(appendId)).filter((f) => f.status === 'done').length === 2, 40_000, 'the second append');
    const text = JSON.stringify((await w.call(omar, 'GET', `${TEAM}/repo/blob?path=${encodeURIComponent(pagePath)}`)).body);
    expect(text.match(/# Report/g)).toHaveLength(2);

    const createId = await makeScheduledJob({ bot: 'rh-modes', name: 'Modes create', kind: 'routine', contract: contractFor('create') });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${createId}/run`);
    const refused = await settled(createId);
    expect(refused.status).toBe('failed');
    expect(refused.reason).toMatch(/^The page could not be written: /);
  });

  it('a bot without a routine trigger fails the firing with a plain reason and starts nothing', async () => {
    const bot = await loadBot('rh-notrig', scheduledJobBot('RhNoTrig', ['  - type: mention']));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-notrig', name: 'No trigger', kind: 'heartbeat' });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The bot RhNoTrig has no routine trigger in its BOT.md, so a schedule cannot start it.');
    expect(firing.run_id).toBeNull();
    expect(await botRunsFor(bot.botId)).toEqual([]);
    expect(await jobsOfFiring(firing.id)).toBe(0);
  });

  it('an inactive bot fails the firing', async () => {
    const bot = await loadBot('rh-off', scheduledJobBot('RhOff'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-off', name: 'Off bot', kind: 'heartbeat' });
    await ownerSql(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [bot.botId]);
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing).toMatchObject({ status: 'failed', reason: 'The bot RhOff is not active, so it cannot run.' });
    expect(await jobsOfFiring(firing.id)).toBe(0);
  });

  it('a contract violation still fails the firing and enqueues nothing', async () => {
    const bot = await loadBot('rh-badc', scheduledJobBot('RhBadC'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-badc', name: 'Bad contract', kind: 'routine', contract: 'name: Bad\noutput:\n  page: notes/outside.md\n' });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toMatch(/invalid/);
    await quiet(1500);
    expect(await jobsOfFiring(firing.id)).toBe(0);
    expect(await botRunsFor(bot.botId)).toEqual([]);
  });

  it('a task scheduled job hands the bot the card it made and posts the reply in the channel', async () => {
    const bot = await loadBot('rh-task', scheduledJobBot('RhTask'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-task', name: 'Weekly chore', kind: 'task' });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('done');
    const taskId = String((await ownerSql('SELECT task_id FROM app.scheduled_job_runs WHERE id = $1', [firing.id]))[0]?.['task_id']);
    expect(taskId).not.toBe('null');
    expect(callsOf('rh-task', firing.run_id as string)[0]!['prompt']).toContain(`(id ${taskId})`);
    const posted = await bodiesIn(await homeChannelId());
    expect(posted.some((m) => m.authorId === bot.actorId && m.body.includes('Done: Scheduled task from the "Weekly chore" scheduledJob'))).toBe(true);
  });

  it('the scheduled job model alias and effort reach the run', async () => {
    await loadBot('rh-model', botMd({ name: 'RhModel', model: 'smart, fast', capabilities: 'messages.post, pages.write', triggers: ['  - type: routine'] }));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-model', name: 'Fast beat', kind: 'heartbeat', extra: { modelAlias: 'fast', effort: 'low' } });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('done');
    const job = (await ownerSql(`SELECT payload FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1`, [`%:scheduledJob:${firing.id}`]))[0]!['payload'] as { scheduledJob: { modelAlias: string; effort: string } };
    expect(job.scheduledJob).toMatchObject({ modelAlias: 'fast', effort: 'low' });
  });
});

/** Seed the rows a run leaves: a finished-or-not bot run tied to a job whose key names the firing, as the router's does. */
async function seedFiring(scheduledJobId: string, status: 'queued' | 'running', minutesAgo = 0): Promise<string> {
  const row = (await ownerSql(`SELECT team_id, workspace_id, bot_id FROM app.scheduled_jobs WHERE id = $1`, [scheduledJobId]))[0]!;
  return String(
    (
      await ownerSql(
        `INSERT INTO app.scheduled_job_runs (scheduled_job_id, team_id, status, started_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4)) RETURNING id`,
        [scheduledJobId, row['team_id'], status, minutesAgo],
      )
    )[0]!['id'],
  );
}
async function seedBotRun(scheduledJobId: string, firingId: string, status: 'failed' | 'stopped'): Promise<string> {
  const row = (await ownerSql(`SELECT team_id, workspace_id, bot_id FROM app.scheduled_jobs WHERE id = $1`, [scheduledJobId]))[0]!;
  const job = (await ownerSql(`INSERT INTO app.jobs (queue, payload, state, dedupe_key) VALUES ('runtime-hermes.run', '{}'::jsonb, 'done', $1) RETURNING id`, [`runtime-hermes:b:scheduledJob:${firingId}`]))[0]!['id'];
  return String(
    (
      await ownerSql(
        `INSERT INTO app.bot_runs (workspace_id, bot_id, team_id, trigger_type, status, ended_at, job_id) VALUES ($1, $2, $3, 'routine', $4, now(), $5) RETURNING id`,
        [row['workspace_id'], row['bot_id'], row['team_id'], status, job],
      )
    )[0]!['id'],
  );
}
const emitAs = (event: Record<string, unknown>): Promise<unknown> => w.as(omar, (tx) => emit(tx as never, { schemaVersion: 1, ...event }));
async function firingRow(id: string): Promise<FiringRow> {
  return (await ownerSql('SELECT id, status, run_id, reason, output_path, ended_at FROM app.scheduled_job_runs WHERE id = $1', [id]))[0] as unknown as FiringRow;
}
const untilStatus = (id: string, status: string): Promise<FiringRow> =>
  until(async () => {
    const r = await firingRow(id);
    return r.status === status ? r : null;
  }, 20_000, `the firing to be ${status}`);

describe('the ledger and the guards', () => {
  const closedEvent = (bot: LoadedBot, runId: string, status: string) => ({
    type: 'bots.run.closed', workspaceId: personas.omar.workspaceId, teamId: TEAM_ID_ENG, botId: bot.botId, runId, trigger: 'routine', status,
  });
  const startedEvent = (bot: LoadedBot, firingId: string, runId: string) => ({
    type: 'runtime.scheduled_job.started', workspaceId: personas.omar.workspaceId, teamId: TEAM_ID_ENG, botId: bot.botId, scheduledJobRunId: firingId, runId,
  });
  const TEAM_ID_ENG = TEAM_IDS.Engineering;

  it('a close handled before the start still settles the firing, and a late start does not reopen it', async () => {
    const bot = await loadBot('rh-late', scheduledJobBot('RhLate'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-late', name: 'Late', kind: 'heartbeat' });
    const firing = await seedFiring(scheduledJobId, 'queued');
    const runId = await seedBotRun(scheduledJobId, firing, 'stopped');
    await emitAs(closedEvent(bot, runId, 'stopped'));
    const failed = await untilStatus(firing, 'failed');
    expect(failed.reason).toMatch(/stopped before it finished/);
    expect(failed.run_id).toBe(runId);
    await emitAs(startedEvent(bot, firing, runId));
    await quiet(1500);
    expect((await firingRow(firing)).status).toBe('failed');
  });

  it('a start that arrives after its run was already closed settles the firing instead of leaving it running', async () => {
    const bot = await loadBot('rh-late2', scheduledJobBot('RhLate2'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-late2', name: 'Late two', kind: 'heartbeat' });
    const firing = await seedFiring(scheduledJobId, 'queued');
    const runId = await seedBotRun(scheduledJobId, firing, 'failed');
    await emitAs(startedEvent(bot, firing, runId));
    const failed = await untilStatus(firing, 'failed');
    expect(failed.reason).toBe('The run failed before it finished.');
  });

  it('an over-long output page and a page that climbs out of pages/ fail the firing at the contract', async () => {
    await loadBot('rh-paths', scheduledJobBot('RhPaths'));
    for (const page of [`pages/${'a'.repeat(400)}.md`, 'pages/../bots/x.md']) {
      const contract = ['name: Paths', 'prompt: x', 'output:', `  page: ${page}`, ''].join('\n');
      const id = await makeScheduledJob({ bot: 'rh-paths', name: `Paths ${page.length}`, kind: 'routine', contract, slug: `paths-${page.length}` });
      await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${id}/run`);
      const firing = await settled(id);
      expect(firing.status).toBe('failed');
      expect(firing.reason).toMatch(/invalid/);
    }
  });

  it('a firing turned away by its runner is recorded as a refusal (event and audit), says why in the ledger and posts nothing', async () => {
    await ownerSql(`INSERT INTO app.bot_runners (workspace_id, name, label, kind, enabled, all_teams, status) VALUES ($1, 'rh-off', 'Sleepy host', 'hermes_gateway', false, true, 'ready')`, [omar.workspaceId]);
    const bot = await loadBot('rh-refused', botMd({ name: 'RhRefused', model: 'smart', capabilities: 'messages.post, pages.write', triggers: ['  - type: routine'], extra: ['placement:', '  runs_on: rh-off'] }));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-refused', name: 'Refused beat', kind: 'heartbeat' });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('This bot runs on Sleepy host, which an admin has switched off.');
    const events = await ownerSql(`SELECT payload FROM app.events WHERE type = 'bot_runner.run.refused' AND payload ->> 'botId' = $1`, [bot.botId]);
    expect(events).toHaveLength(1);
    expect(events[0]!['payload']).toMatchObject({ runner: 'rh-off', reason: 'disabled', runId: firing.run_id });
    expect(JSON.stringify(events)).not.toContain('Sleepy');
    await until(async () => (await ownerSql(`SELECT 1 FROM app.audit_events WHERE action = 'bot_runner.run_refused'`)).length > 0, 20_000, 'the audit row');
    expect((await bodiesIn(await homeChannelId())).filter((m) => m.authorId === bot.actorId)).toEqual([]);
  });

  it('a failed scheduled run posts no notice into the channel', async () => {
    const bot = await loadBot('rh-crash', scheduledJobBot('RhCrash'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-crash', name: 'CRASH beat', kind: 'heartbeat' });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The run failed before it produced an answer.');
    expect((await bodiesIn(await homeChannelId())).filter((m) => m.authorId === bot.actorId)).toEqual([]);
  });

  it('a bot with no public channel to post in fails the firing with the reason', async () => {
    const bot = await loadBot('rh-nochan', scheduledJobBot('RhNoChan'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-nochan', name: 'No channel', kind: 'heartbeat' });
    const archived = await ownerSql(
      `UPDATE app.channels c SET archived_at = now() FROM app.teams t WHERE t.id = c.team_id AND t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL RETURNING c.id`,
    );
    try {
      await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
      const firing = await settled(scheduledJobId);
      expect(firing.status).toBe('failed');
      expect(firing.reason).toBe('The bot RhNoChan cannot post in any public channel of the team, so there is nowhere to put its output.');
      expect(await botRunsFor(bot.botId)).toEqual([]);
    } finally {
      await ownerSql(`UPDATE app.channels SET archived_at = NULL WHERE id = ANY($1::uuid[])`, [archived.map((r) => r['id'])]);
    }
  });

  it('a model alias the bot does not list fails the firing with a clear reason and starts no run', async () => {
    const bot = await loadBot('rh-alias', scheduledJobBot('RhAlias'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-alias', name: 'Wrong alias', kind: 'heartbeat', extra: { modelAlias: 'fast' } });
    await w.call(omar, 'POST', `${TEAM}/scheduled-jobs/${scheduledJobId}/run`);
    const firing = await settled(scheduledJobId);
    expect(firing).toMatchObject({ status: 'failed', reason: 'The model alias fast is not one this bot may use.' });
    expect(await botRunsFor(bot.botId)).toEqual([]);
  });

  it('the watchdog fails a firing stuck queued and one stuck running, and leaves recent ones alone', async () => {
    await loadBot('rh-dog', scheduledJobBot('RhDog'));
    const scheduledJobId = await makeScheduledJob({ bot: 'rh-dog', name: 'Watchdog', kind: 'heartbeat' });
    const oldQueued = await seedFiring(scheduledJobId, 'queued', 20);
    const oldRunning = await seedFiring(scheduledJobId, 'running', 200);
    const freshQueued = await seedFiring(scheduledJobId, 'queued', 1);
    await ownerSql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('scheduled-jobs.tick', '{}'::jsonb, now())`);
    expect((await untilStatus(oldQueued, 'failed')).reason).toBe('The bot was never started for this firing (nothing picked it up in time).');
    expect((await untilStatus(oldRunning, 'failed')).reason).toBe('The run did not report an end in time, so the firing was closed.');
    expect((await firingRow(freshQueued)).status).toBe('queued');
  });
});

describe('a person\'s own routine (P20-10)', () => {
  /** A bot of the team that asks to read a Personal space, whose reading omar has agreed to. */
  async function personalBot(slug: string, name: string): Promise<LoadedBot> {
    const bot = await loadBot(slug, botMd({ name, model: 'smart', capabilities: 'messages.post', triggers: ['  - type: mention'] }));
    await ownerSql(`INSERT INTO app.capability_grants (team_id, actor_id, capability) VALUES ($1, $2, 'personal.read') ON CONFLICT DO NOTHING`, [TEAM_IDS.Engineering, bot.actorId]);
    const said = await w.call(omar, 'PUT', `/api/me/bot-consents/${bot.botId}`, { allowed: true });
    expect(said.status, JSON.stringify(said.body)).toBe(200);
    return bot;
  }
  const makeRoutine = async (botSlug: string, name: string, extra: Record<string, unknown> = {}): Promise<string> => {
    const res = await w.call<{ routine: { id: string } }>(omar, 'POST', '/api/me/scheduled-jobs', {
      confirmed: true,
      name,
      words: name,
      botSlug,
      schedule: '0 5 * * 1-5',
      scheduleWords: 'Weekdays at 9:00 AM',
      timeZone: 'Asia/Dubai',
      prompt: `Write the ${name} now.`,
      sources: [],
      outputMode: 'replace',
      ...extra,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.routine.id;
  };
  const fileAt = async (path: string): Promise<{ uploader: string } | null> => {
    const rows = await ownerSql(`SELECT uploader_id FROM app.files WHERE owner_person_id = $1 AND folder_path || name = $2`, [omar.personId, path]);
    return rows[0] ? { uploader: String(rows[0]['uploader_id']) } : null;
  };

  it('runs as the bot with the owner asking, in the owner\'s own conversation, and saves its output in the owner\'s files', async () => {
    const bot = await personalBot('rh-mine', 'RhMine');
    const routineId = await makeRoutine('rh-mine', 'Daily note');
    expect((await w.call(omar, 'POST', `/api/me/scheduled-jobs/${routineId}/run`)).status).toBe(202);
    const firing = await settled(routineId);
    expect(firing, JSON.stringify(firing)).toMatchObject({ status: 'done', output_path: 'Routines/daily-note/output.md' });

    const runs = await botRunsFor(bot.botId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: firing.run_id, trigger_type: 'routine', asker_id: omar.actorId });
    const channel = await ownerSql(`SELECT c.kind FROM app.bot_runs r JOIN app.channels c ON c.id = r.channel_id WHERE r.id = $1`, [firing.run_id]);
    expect(channel[0]!['kind']).toBe('bot_conversation');

    const calls = callsOf('rh-mine', firing.run_id as string);
    expect(calls[0]!['prompt']).toContain('Write the Daily note now.');
    expect(calls[0]!['prompt']).toContain('saved as the file Routines/daily-note/output.md in their own files');

    // the output is a file of the owner, written by the bot, and nothing was announced in a team channel
    const written = await fileAt('Routines/daily-note/output.md');
    expect(written, 'the output file').not.toBeNull();
    expect(written!.uploader).toBe(bot.actorId);
    expect((await ownerSql(`SELECT 1 FROM app.messages WHERE author_id = $1`, [bot.actorId])).length).toBe(0);
  });

  it('fails the firing with the reason when the run produces nothing, and writes no file', async () => {
    await personalBot('rh-mine-empty', 'RhMineEmpty');
    const routineId = await makeRoutine('rh-mine-empty', 'Empty note', { prompt: 'NOOUTPUT please' });
    await w.call(omar, 'POST', `/api/me/scheduled-jobs/${routineId}/run`);
    const firing = await settled(routineId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The run produced no output, so nothing was written to Routines/empty-note/output.md.');
    expect(await fileAt('Routines/empty-note/output.md')).toBeNull();
  });

  it('keeps the action items: a rewrite that drops an action is refused and the list stays as it was', async () => {
    await personalBot('rh-mine-items', 'RhMineItems');
    const add = await w.call<{ list: { revision: string | null } }>(omar, 'PATCH', '/api/me/action-items', { revision: null, change: { op: 'add', what: 'Send the report to Priya' } });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    const routineId = await makeRoutine('rh-mine-items', 'Keep items', { outputPath: 'Action items/action-items.md', prompt: 'Rewrite the list. Keep it short.' });
    await w.call(omar, 'POST', `/api/me/scheduled-jobs/${routineId}/run`);
    const firing = await settled(routineId);
    // the stand-in answers with "# Report ..." which has no actions at all, so the one action would disappear
    expect(firing.status).toBe('failed');
    expect(firing.reason).toMatch(/would have been removed/);
    const list = await w.call<{ items: { what: string }[] }>(omar, 'GET', '/api/me/action-items');
    expect(list.body.items.map((i) => i.what)).toEqual(['Send the report to Priya']);
  });

  it('runs a routine of the workspace Brain, which has no team of its own: the run is made in the owner\'s context team', async () => {
    // the workspace Brain is made by the bots plugin's job (a fresh world has none until it runs)
    await ownerSql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('bots.ensure-workspace-brain', '{}'::jsonb, now())`);
    const brain = await until(async () => {
      const rows = await ownerSql(`SELECT id, team_id FROM app.bots WHERE scope = 'workspace' AND slug = 'brain' AND status = 'active'`);
      return rows.length === 1 ? rows : null;
    }, 30_000, 'the workspace Brain to be loaded');
    await until(async () => (await ownerSql(`SELECT 1 FROM app.actors WHERE kind = 'bot' AND ref_id = $1`, [brain[0]!['id']])).length === 1, 10_000, 'the Brain actor');
    expect(brain[0]!['team_id']).toBeNull();
    const routineId = await makeRoutine('brain', 'Brain note');
    expect((await w.call(omar, 'POST', `/api/me/scheduled-jobs/${routineId}/run`)).status).toBe(202);
    const firing = await settled(routineId);
    expect(firing, JSON.stringify(firing)).toMatchObject({ status: 'done', output_path: 'Routines/brain-note/output.md' });
    const runs = await botRunsFor(String(brain[0]!['id']));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger_type: 'routine', asker_id: omar.actorId });
    const team = await ownerSql(`SELECT r.team_id, c.team_id AS channel_team FROM app.bot_runs r JOIN app.channels c ON c.id = r.channel_id WHERE r.id = $1`, [firing.run_id]);
    expect(team[0]!['team_id']).toBe(team[0]!['channel_team']);
  });

  it('says what the run is for', () => {
    const prompt = buildPersonalRoutinePrompt({ name: 'N', firedAt: '2026-01-01T09:00:00.000Z', prompt: 'Do X.', outputPath: 'Routines/n/output.md', outputMode: 'append' });
    expect(prompt).toContain('saved as the file Routines/n/output.md in their own files and will be added to the end of the file');
    expect(prompt).toContain('waits for the person to say yes');
  });
});

describe('the pieces', () => {
  it('applyScheduledJobOverrides puts the scheduled job alias first and sets the effort, leaving the bot as it was otherwise', () => {
    const def = { frontmatter: { model: { aliases: ['smart', 'fast'], effort: 'high' } }, alias: 'smart' } as unknown as Parameters<typeof applyScheduledJobOverrides>[0];
    applyScheduledJobOverrides(def, { scheduledJobRunId: randomUuid(), kind: 'heartbeat', outputPath: null, outputMode: null, modelAlias: 'fast', effort: 'low' });
    expect(def.alias).toBe('fast');
    expect(def.frontmatter.model).toEqual({ aliases: ['fast', 'smart'], effort: 'low' });
    const same = { frontmatter: { model: { aliases: ['smart'] } }, alias: 'smart' } as unknown as Parameters<typeof applyScheduledJobOverrides>[0];
    applyScheduledJobOverrides(same, { scheduledJobRunId: randomUuid(), kind: 'heartbeat', outputPath: null, outputMode: null, modelAlias: null, effort: null });
    expect(same.alias).toBe('smart');
  });

  it('a rewrite of the action items names the revision it checked, so a change made in between is not overwritten', async () => {
    const seen: unknown[] = [];
    const text = '# Action items\n\n- [ ] Send the report\n';
    const provider = (current: { text: string; revision: string } | null, failWith?: Error) => ({
      read: async () => current,
      write: async (_tx: unknown, _person: string, _path: string, _text: string, options: unknown) => {
        seen.push(options);
        if (failWith) throw failWith;
        return { file: {}, created: false, changed: true };
      },
    });
    const ctxOf = (files: unknown) => ({ providers: { get: () => files } }) as unknown as Parameters<typeof writePersonalOutput>[0];
    const run = { botActorId: 'bot-1' } as unknown as Parameters<typeof writePersonalOutput>[2];
    const tx = {} as Parameters<typeof writePersonalOutput>[1];
    expect(await writePersonalOutput(ctxOf(provider({ text, revision: 'r1' })), tx, run, 'p1', 'Action items/action-items.md', 'replace', text)).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ expectedRevision: 'r1', authorActorId: 'bot-1' });
    // a list that does not exist yet is expected not to exist
    await writePersonalOutput(ctxOf(provider(null)), tx, run, 'p1', 'Action items/action-items.md', 'replace', text);
    expect(seen[1]).toMatchObject({ expectedRevision: null });
    // another file is not checked this way
    await writePersonalOutput(ctxOf(provider(null)), tx, run, 'p1', 'Routines/a/output.md', 'replace', 'x');
    expect(seen[2]).not.toHaveProperty('expectedRevision');
    // a stale save is a failed firing with a sentence, not an overwrite
    const stale = Object.assign(new Error('The file changed since you read it'), { status: 409 });
    const refused = await writePersonalOutput(ctxOf(provider({ text, revision: 'r1' }, stale)), tx, run, 'p1', 'Action items/action-items.md', 'replace', text);
    expect(refused).toMatchObject({ ok: false });
  });

  it('the prompts: a routine says where its output goes, a task names its card, a heartbeat may stay quiet', () => {
    const base = { name: 'N', firedAt: '2026-01-01T09:00:00.000Z', prompt: '', outputPath: null, outputMode: null, card: null } as const;
    expect(buildScheduledJobPrompt({ ...base, kind: 'routine', prompt: 'Do X.', outputPath: 'pages/a.md', outputMode: 'append' })).toContain('saved as the page pages/a.md and will be added to the end of the page');
    expect(buildScheduledJobPrompt({ ...base, kind: 'task', card: { id: 'c1', title: 'T', description: 'D' } })).toContain('The card is "T" (id c1).');
    expect(buildScheduledJobPrompt({ ...base, kind: 'heartbeat' })).toContain('Nothing to report');
  });
});
