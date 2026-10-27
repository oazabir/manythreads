import { randomUUID as randomUuid } from 'node:crypto';
import { emit } from '@manythreads/kernel';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListMessagesResponse } from '@manythreads/shared';
import { applyRhythmOverrides } from '../src/rhythm-run.ts';
import { buildRhythmPrompt } from '../src/router-rhythms.ts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';

// A rhythm's firing starts its bot (PLAN P6-08; SPEC §6.4, §6.5): the `routine` trigger end to end. The stand-in for Hermes is a script that
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
  scratch = mkdtempSync(join(tmpdir(), 'runtime-hermes-rhythms-'));
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
const rhythmBot = (name: string, triggers = ['  - type: routine']): string =>
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

/** A rhythm through the API (a lead makes it); `routines/<slug>.yaml` is committed first for a routine. */
async function makeRhythm(input: { bot: string; name: string; kind: 'heartbeat' | 'routine' | 'task'; contract?: string; slug?: string; extra?: Record<string, unknown> }): Promise<string> {
  let contractPath: string | undefined;
  if (input.contract !== undefined) {
    contractPath = `routines/${input.slug ?? input.name.toLowerCase().replace(/\W+/g, '-')}.yaml`;
    const committed = await w.commit(omar, 'engineering', [{ op: 'put', path: contractPath, content: input.contract }], `Add ${contractPath}`);
    expect(committed.status, JSON.stringify(committed.body)).toBe(201);
  }
  const res = await w.call<{ rhythm: { id: string } }>(omar, 'POST', `${TEAM}/rhythms`, {
    botSlug: input.bot,
    name: input.name,
    kind: input.kind,
    schedule: '0 9 * * *',
    ...(contractPath ? { contractPath } : {}),
    ...(input.extra ?? {}),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.rhythm.id;
}

interface FiringRow {
  id: string;
  status: string;
  run_id: string | null;
  reason: string;
  output_path: string | null;
  ended_at: Date | null;
}
const firingsOf = async (rhythmId: string): Promise<FiringRow[]> =>
  (await ownerSql('SELECT id, status, run_id, reason, output_path, ended_at FROM app.rhythm_runs WHERE rhythm_id = $1 ORDER BY started_at, id', [rhythmId])) as unknown as FiringRow[];
const settled = (rhythmId: string): Promise<FiringRow> =>
  until(async () => {
    const [row] = await firingsOf(rhythmId);
    return row && (row.status === 'done' || row.status === 'failed') ? row : null;
  }, 40_000, 'the firing to settle');

/** The schedule's own tick job, run once; the rhythm is made due first. */
async function tick(rhythmId: string): Promise<void> {
  await ownerSql(`UPDATE app.rhythms SET next_run_at = now() - interval '1 minute' WHERE id = $1`, [rhythmId]);
  await ownerSql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('rhythms.tick', '{}'::jsonb, now())`);
}
const botRunsFor = async (botId: string) => runsOf(botId);
const jobsOfFiring = async (firingId: string): Promise<number> =>
  Number((await ownerSql(`SELECT count(*)::int AS n FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1`, [`%:rhythm:${firingId}`]))[0]?.['n']);

describe('a rhythm firing starts its bot', () => {
  it('a heartbeat on the schedule: one run, a check-in prompt, the ledger queued -> running -> done, one job for two ticks', async () => {
    const bot = await loadBot('rh-beat', rhythmBot('RhBeat'));
    const rhythmId = await makeRhythm({ bot: 'rh-beat', name: 'Morning pulse', kind: 'heartbeat' });
    await tick(rhythmId);
    await tick(rhythmId); // the first tick moved the next slot on, so this one finds nothing due
    const firing = await settled(rhythmId);
    expect(firing).toMatchObject({ status: 'done', reason: '' });
    expect(firing.run_id).not.toBeNull();
    expect(firing.ended_at).not.toBeNull();

    const runs = await botRunsFor(bot.botId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: firing.run_id, trigger_type: 'routine', status: 'done', asker_id: null });
    expect(await firingsOf(rhythmId)).toHaveLength(1);
    expect(await jobsOfFiring(firing.id)).toBe(1);

    const calls = callsOf('rh-beat', firing.run_id as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]!['prompt']).toContain('Scheduled check-in: the "Morning pulse" rhythm fired at ');

    // the ledger walked queued -> running -> done: the three announcements are on the record, in that order
    const states = (await ownerSql(`SELECT payload->>'status' AS s FROM app.events WHERE type = 'rhythms.rhythm.ran' AND payload->>'rhythmRunId' = $1 ORDER BY id`, [firing.id])).map((r) => r['s']);
    expect(states).toEqual(['queued', 'running', 'done']);
    // a heartbeat's reply is not posted: the bot decides whether to say anything
    expect((await ownerSql(`SELECT 1 FROM app.messages WHERE author_id = $1`, [bot.actorId])).length).toBe(0);
  });

  it('a second delivery of the same event starts no second run', async () => {
    const bot = await loadBot('rh-twice', rhythmBot('RhTwice'));
    const rhythmId = await makeRhythm({ bot: 'rh-twice', name: 'Twice', kind: 'heartbeat' });
    expect((await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`)).status).toBe(202);
    const firing = await settled(rhythmId);
    const reset = await ownerSql(
      `UPDATE app.outbox o SET done_at = NULL, available_at = now() FROM app.events e
        WHERE e.id = o.event_id AND e.type = 'rhythms.rhythm.ran' AND e.payload->>'rhythmRunId' = $1 AND e.payload->>'status' = 'queued' AND o.subscriber = 'plugins'
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
    const bot = await loadBot('rh-report', rhythmBot('RhReport'));
    const contract = ['name: Weekly report', 'prompt: Summarise the week for the team.', 'output:', '  page: pages/reports/rh-week.md', '  mode: replace', ''].join('\n');
    const rhythmId = await makeRhythm({ bot: 'rh-report', name: 'Weekly report', kind: 'routine', contract });
    expect((await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`)).status).toBe(202);
    const firing = await settled(rhythmId);
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
    await loadBot('rh-empty', rhythmBot('RhEmpty'));
    const contract = ['name: Empty', 'prompt: NOOUTPUT please', 'output:', '  page: pages/reports/rh-empty.md', ''].join('\n');
    const rhythmId = await makeRhythm({ bot: 'rh-empty', name: 'Empty report', kind: 'routine', contract });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The run produced no output, so nothing was written to pages/reports/rh-empty.md.');
    const blob = await w.call(omar, 'GET', `${TEAM}/repo/blob?path=${encodeURIComponent('pages/reports/rh-empty.md')}`);
    expect(blob.status).toBe(404);
  });

  it('append adds to the page and create refuses a page that exists, and says so', async () => {
    await loadBot('rh-modes', rhythmBot('RhModes'));
    const pagePath = 'pages/reports/rh-modes.md';
    const contractFor = (mode: string) => ['name: Modes', 'prompt: Write.', 'output:', `  page: ${pagePath}`, `  mode: ${mode}`, ''].join('\n');
    const appendId = await makeRhythm({ bot: 'rh-modes', name: 'Modes append', kind: 'routine', contract: contractFor('append') });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${appendId}/run`);
    expect((await settled(appendId)).status).toBe('done');
    await w.call(omar, 'POST', `${TEAM}/rhythms/${appendId}/run`);
    await until(async () => (await firingsOf(appendId)).filter((f) => f.status === 'done').length === 2, 40_000, 'the second append');
    const text = JSON.stringify((await w.call(omar, 'GET', `${TEAM}/repo/blob?path=${encodeURIComponent(pagePath)}`)).body);
    expect(text.match(/# Report/g)).toHaveLength(2);

    const createId = await makeRhythm({ bot: 'rh-modes', name: 'Modes create', kind: 'routine', contract: contractFor('create') });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${createId}/run`);
    const refused = await settled(createId);
    expect(refused.status).toBe('failed');
    expect(refused.reason).toMatch(/^The page could not be written: /);
  });

  it('a bot without a routine trigger fails the firing with a plain reason and starts nothing', async () => {
    const bot = await loadBot('rh-notrig', rhythmBot('RhNoTrig', ['  - type: mention']));
    const rhythmId = await makeRhythm({ bot: 'rh-notrig', name: 'No trigger', kind: 'heartbeat' });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The bot RhNoTrig has no routine trigger in its BOT.md, so a schedule cannot start it.');
    expect(firing.run_id).toBeNull();
    expect(await botRunsFor(bot.botId)).toEqual([]);
    expect(await jobsOfFiring(firing.id)).toBe(0);
  });

  it('an inactive bot fails the firing', async () => {
    const bot = await loadBot('rh-off', rhythmBot('RhOff'));
    const rhythmId = await makeRhythm({ bot: 'rh-off', name: 'Off bot', kind: 'heartbeat' });
    await ownerSql(`UPDATE app.bots SET status = 'disabled' WHERE id = $1`, [bot.botId]);
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing).toMatchObject({ status: 'failed', reason: 'The bot RhOff is not active, so it cannot run.' });
    expect(await jobsOfFiring(firing.id)).toBe(0);
  });

  it('a contract violation still fails the firing and enqueues nothing', async () => {
    const bot = await loadBot('rh-badc', rhythmBot('RhBadC'));
    const rhythmId = await makeRhythm({ bot: 'rh-badc', name: 'Bad contract', kind: 'routine', contract: 'name: Bad\noutput:\n  page: notes/outside.md\n' });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toMatch(/invalid/);
    await quiet(1500);
    expect(await jobsOfFiring(firing.id)).toBe(0);
    expect(await botRunsFor(bot.botId)).toEqual([]);
  });

  it('a task rhythm hands the bot the card it made and posts the reply in the channel', async () => {
    const bot = await loadBot('rh-task', rhythmBot('RhTask'));
    const rhythmId = await makeRhythm({ bot: 'rh-task', name: 'Weekly chore', kind: 'task' });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('done');
    const taskId = String((await ownerSql('SELECT task_id FROM app.rhythm_runs WHERE id = $1', [firing.id]))[0]?.['task_id']);
    expect(taskId).not.toBe('null');
    expect(callsOf('rh-task', firing.run_id as string)[0]!['prompt']).toContain(`(id ${taskId})`);
    const posted = await bodiesIn(await homeChannelId());
    expect(posted.some((m) => m.authorId === bot.actorId && m.body.includes('Done: Scheduled task from the "Weekly chore" rhythm'))).toBe(true);
  });

  it('the rhythm model alias and effort reach the run', async () => {
    await loadBot('rh-model', botMd({ name: 'RhModel', model: 'smart, fast', capabilities: 'messages.post, pages.write', triggers: ['  - type: routine'] }));
    const rhythmId = await makeRhythm({ bot: 'rh-model', name: 'Fast beat', kind: 'heartbeat', extra: { modelAlias: 'fast', effort: 'low' } });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('done');
    const job = (await ownerSql(`SELECT payload FROM app.jobs WHERE queue = 'runtime-hermes.run' AND dedupe_key LIKE $1`, [`%:rhythm:${firing.id}`]))[0]!['payload'] as { rhythm: { modelAlias: string; effort: string } };
    expect(job.rhythm).toMatchObject({ modelAlias: 'fast', effort: 'low' });
  });
});

/** Seed the rows a run leaves: a finished-or-not bot run tied to a job whose key names the firing, as the router's does. */
async function seedFiring(rhythmId: string, status: 'queued' | 'running', minutesAgo = 0): Promise<string> {
  const row = (await ownerSql(`SELECT team_id, workspace_id, bot_id FROM app.rhythms WHERE id = $1`, [rhythmId]))[0]!;
  return String(
    (
      await ownerSql(
        `INSERT INTO app.rhythm_runs (rhythm_id, team_id, status, started_at) VALUES ($1, $2, $3, now() - make_interval(mins => $4)) RETURNING id`,
        [rhythmId, row['team_id'], status, minutesAgo],
      )
    )[0]!['id'],
  );
}
async function seedBotRun(rhythmId: string, firingId: string, status: 'failed' | 'stopped'): Promise<string> {
  const row = (await ownerSql(`SELECT team_id, workspace_id, bot_id FROM app.rhythms WHERE id = $1`, [rhythmId]))[0]!;
  const job = (await ownerSql(`INSERT INTO app.jobs (queue, payload, state, dedupe_key) VALUES ('runtime-hermes.run', '{}'::jsonb, 'done', $1) RETURNING id`, [`runtime-hermes:b:rhythm:${firingId}`]))[0]!['id'];
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
  return (await ownerSql('SELECT id, status, run_id, reason, output_path, ended_at FROM app.rhythm_runs WHERE id = $1', [id]))[0] as unknown as FiringRow;
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
    type: 'runtime.rhythm.started', workspaceId: personas.omar.workspaceId, teamId: TEAM_ID_ENG, botId: bot.botId, rhythmRunId: firingId, runId,
  });
  const TEAM_ID_ENG = TEAM_IDS.Engineering;

  it('a close handled before the start still settles the firing, and a late start does not reopen it', async () => {
    const bot = await loadBot('rh-late', rhythmBot('RhLate'));
    const rhythmId = await makeRhythm({ bot: 'rh-late', name: 'Late', kind: 'heartbeat' });
    const firing = await seedFiring(rhythmId, 'queued');
    const runId = await seedBotRun(rhythmId, firing, 'stopped');
    await emitAs(closedEvent(bot, runId, 'stopped'));
    const failed = await untilStatus(firing, 'failed');
    expect(failed.reason).toMatch(/stopped before it finished/);
    expect(failed.run_id).toBe(runId);
    await emitAs(startedEvent(bot, firing, runId));
    await quiet(1500);
    expect((await firingRow(firing)).status).toBe('failed');
  });

  it('a start that arrives after its run was already closed settles the firing instead of leaving it running', async () => {
    const bot = await loadBot('rh-late2', rhythmBot('RhLate2'));
    const rhythmId = await makeRhythm({ bot: 'rh-late2', name: 'Late two', kind: 'heartbeat' });
    const firing = await seedFiring(rhythmId, 'queued');
    const runId = await seedBotRun(rhythmId, firing, 'failed');
    await emitAs(startedEvent(bot, firing, runId));
    const failed = await untilStatus(firing, 'failed');
    expect(failed.reason).toBe('The run failed before it finished.');
  });

  it('an over-long output page and a page that climbs out of pages/ fail the firing at the contract', async () => {
    await loadBot('rh-paths', rhythmBot('RhPaths'));
    for (const page of [`pages/${'a'.repeat(400)}.md`, 'pages/../bots/x.md']) {
      const contract = ['name: Paths', 'prompt: x', 'output:', `  page: ${page}`, ''].join('\n');
      const id = await makeRhythm({ bot: 'rh-paths', name: `Paths ${page.length}`, kind: 'routine', contract, slug: `paths-${page.length}` });
      await w.call(omar, 'POST', `${TEAM}/rhythms/${id}/run`);
      const firing = await settled(id);
      expect(firing.status).toBe('failed');
      expect(firing.reason).toMatch(/invalid/);
    }
  });

  it('a failed scheduled run posts no notice into the channel', async () => {
    const bot = await loadBot('rh-crash', rhythmBot('RhCrash'));
    const rhythmId = await makeRhythm({ bot: 'rh-crash', name: 'CRASH beat', kind: 'heartbeat' });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing.status).toBe('failed');
    expect(firing.reason).toBe('The run failed before it produced an answer.');
    expect((await bodiesIn(await homeChannelId())).filter((m) => m.authorId === bot.actorId)).toEqual([]);
  });

  it('a bot with no public channel to post in fails the firing with the reason', async () => {
    const bot = await loadBot('rh-nochan', rhythmBot('RhNoChan'));
    const rhythmId = await makeRhythm({ bot: 'rh-nochan', name: 'No channel', kind: 'heartbeat' });
    const archived = await ownerSql(
      `UPDATE app.channels c SET archived_at = now() FROM app.teams t WHERE t.id = c.team_id AND t.slug = 'engineering' AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL RETURNING c.id`,
    );
    try {
      await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
      const firing = await settled(rhythmId);
      expect(firing.status).toBe('failed');
      expect(firing.reason).toBe('The bot RhNoChan cannot post in any public channel of the team, so there is nowhere to put its output.');
      expect(await botRunsFor(bot.botId)).toEqual([]);
    } finally {
      await ownerSql(`UPDATE app.channels SET archived_at = NULL WHERE id = ANY($1::uuid[])`, [archived.map((r) => r['id'])]);
    }
  });

  it('a model alias the bot does not list fails the firing with a clear reason and starts no run', async () => {
    const bot = await loadBot('rh-alias', rhythmBot('RhAlias'));
    const rhythmId = await makeRhythm({ bot: 'rh-alias', name: 'Wrong alias', kind: 'heartbeat', extra: { modelAlias: 'fast' } });
    await w.call(omar, 'POST', `${TEAM}/rhythms/${rhythmId}/run`);
    const firing = await settled(rhythmId);
    expect(firing).toMatchObject({ status: 'failed', reason: 'The model alias fast is not one this bot may use.' });
    expect(await botRunsFor(bot.botId)).toEqual([]);
  });

  it('the watchdog fails a firing stuck queued and one stuck running, and leaves recent ones alone', async () => {
    await loadBot('rh-dog', rhythmBot('RhDog'));
    const rhythmId = await makeRhythm({ bot: 'rh-dog', name: 'Watchdog', kind: 'heartbeat' });
    const oldQueued = await seedFiring(rhythmId, 'queued', 20);
    const oldRunning = await seedFiring(rhythmId, 'running', 200);
    const freshQueued = await seedFiring(rhythmId, 'queued', 1);
    await ownerSql(`INSERT INTO app.jobs (queue, payload, run_at) VALUES ('rhythms.tick', '{}'::jsonb, now())`);
    expect((await untilStatus(oldQueued, 'failed')).reason).toBe('The bot was never started for this firing (nothing picked it up in time).');
    expect((await untilStatus(oldRunning, 'failed')).reason).toBe('The run did not report an end in time, so the firing was closed.');
    expect((await firingRow(freshQueued)).status).toBe('queued');
  });
});

describe('the pieces', () => {
  it('applyRhythmOverrides puts the rhythm alias first and sets the effort, leaving the bot as it was otherwise', () => {
    const def = { frontmatter: { model: { aliases: ['smart', 'fast'], effort: 'high' } }, alias: 'smart' } as unknown as Parameters<typeof applyRhythmOverrides>[0];
    applyRhythmOverrides(def, { rhythmRunId: randomUuid(), kind: 'heartbeat', outputPath: null, outputMode: null, modelAlias: 'fast', effort: 'low' });
    expect(def.alias).toBe('fast');
    expect(def.frontmatter.model).toEqual({ aliases: ['fast', 'smart'], effort: 'low' });
    const same = { frontmatter: { model: { aliases: ['smart'] } }, alias: 'smart' } as unknown as Parameters<typeof applyRhythmOverrides>[0];
    applyRhythmOverrides(same, { rhythmRunId: randomUuid(), kind: 'heartbeat', outputPath: null, outputMode: null, modelAlias: null, effort: null });
    expect(same.alias).toBe('smart');
  });

  it('the prompts: a routine says where its output goes, a task names its card, a heartbeat may stay quiet', () => {
    const base = { name: 'N', firedAt: '2026-01-01T09:00:00.000Z', prompt: '', outputPath: null, outputMode: null, card: null } as const;
    expect(buildRhythmPrompt({ ...base, kind: 'routine', prompt: 'Do X.', outputPath: 'pages/a.md', outputMode: 'append' })).toContain('saved as the page pages/a.md and will be added to the end of the page');
    expect(buildRhythmPrompt({ ...base, kind: 'task', card: { id: 'c1', title: 'T', description: 'D' } })).toContain('The card is "T" (id c1).');
    expect(buildRhythmPrompt({ ...base, kind: 'heartbeat' })).toContain('Nothing to report');
  });
});
