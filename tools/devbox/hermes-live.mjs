#!/usr/bin/env node
/*
 * Connect a dev box to a real Hermes and prove the bot surface works (docs/plugins/runtime-hermes.md, "Connecting a dev box").
 *
 * It starts two processes and drives them over HTTP:
 *   1. fake-llm as a LiteLLM stand-in whose chat completions are forwarded to a real gateway (`LIVE_UPSTREAM`), so the platform
 *      still owns only the stand-in's config and keys and a real model answers the agent;
 *   2. the e2e stack server (`e2e/fixtures/stack-server.ts`): a fresh migrated database, the seed and the real plugins.
 * Then it binds the `smart` alias, commits one BOT.md per scenario, and plays the person's part — mentioning, talking in a
 * conversation, posting in a watched channel — reading the runs, replies, approvals and repo commits back from the database.
 *
 * Required environment (never a key on the command line):
 *   LIVE_UPSTREAM          the real gateway, e.g. https://litellm.example/v1
 *   LIVE_UPSTREAM_KEY_ENV  the variable that holds its key, e.g. LITELLM_API_KEY (the key stays in the environment)
 * Optional: LIVE_UPSTREAM_MODEL (default `default`), LIVE_HERMES_BIN (default /root/.local/bin/hermes),
 *   LIVE_RUNTIME_DIR (default /root/.hermes/profiles), LIVE_SEED (default `repo`), LIVE_RELAY_PORT (default 4100),
 *   LIVE_ONLY (comma-separated scenario names, default all).
 *
 * Usage on the devbox, from the repo root:  set -a; . /root/.hermes/.env; set +a; node tools/devbox/hermes-live.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// `pg` is a dependency of the packages, not of the repo root: resolve it from one that has it.
const require = createRequire(new URL('../../packages/test-utils/package.json', import.meta.url));
const pg = require('pg');

const UPSTREAM = (process.env['LIVE_UPSTREAM'] ?? '').trim();
const UPSTREAM_KEY_ENV = (process.env['LIVE_UPSTREAM_KEY_ENV'] ?? '').trim();
const UPSTREAM_MODEL = (process.env['LIVE_UPSTREAM_MODEL'] ?? 'default').trim();
const HERMES_BIN = (process.env['LIVE_HERMES_BIN'] ?? '/root/.local/bin/hermes').trim();
const RUNTIME_DIR = (process.env['LIVE_RUNTIME_DIR'] ?? '/root/.hermes/profiles').trim();
const SEED = (process.env['LIVE_SEED'] ?? 'repo').trim();
const RELAY_PORT = process.env['LIVE_RELAY_PORT'] ?? '4100';
const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
const MASTER = 'sk-live-master';
const ONLY = (process.env['LIVE_ONLY'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

if (UPSTREAM === '' || UPSTREAM_KEY_ENV === '') {
  console.error('LIVE_UPSTREAM and LIVE_UPSTREAM_KEY_ENV are required (see the header of this file).');
  process.exit(2);
}

const children = [];
function start(name, cmd, args, env) {
  const child = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const log = [];
  child.stdout.on('data', (chunk) => log.push(chunk));
  child.stderr.on('data', (chunk) => log.push(chunk));
  child.live = { name, log, text: () => log.join('') };
  children.push(child);
  return child;
}

function waitFor(child, pattern, budgetMs, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: nothing matching ${pattern} in ${budgetMs} ms\n${child.live.text().slice(-2500)}`)), budgetMs);
    const check = () => {
      const m = pattern.exec(child.live.text());
      if (!m) return;
      clearTimeout(timer);
      child.stdout.off('data', check);
      resolve(m);
    };
    child.stdout.on('data', check);
    check();
  });
}

const say = (line) => console.log(`LIVE ${line}`);
const shown = (value) => JSON.stringify(value);
const results = [];
function result(name, ok, detail = '') {
  results.push({ name, ok, detail });
  say(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// The world: relay, stack, database, and one HTTP client per person.

let ready;
let db;
const sql = async (text, params = []) => (await db.query(text, params)).rows;

async function waitForRow(text, params, done, budgetMs, what) {
  const deadline = Date.now() + budgetMs;
  let last = [];
  while (Date.now() < deadline) {
    last = await sql(text, params);
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${what}: gave up after ${budgetMs} ms; last rows ${shown(last)}`);
}

const people = new Map();
async function as(who) {
  if (people.has(who)) return people.get(who);
  const cookies = new Map();
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`${ready.origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(cookies.size === 0 ? {} : { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const at = pair.indexOf('=');
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const text = await res.text();
    let parsed = text;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      // a non-JSON error is still an answer
    }
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 400)}`);
    return parsed;
  };
  if ((await call('POST', '/api/test/session', { email: `${who}@kahf.example` }, { 'x-test-auth': 'live-hermes-token' })) === undefined) {
    throw new Error(`no session for ${who}`);
  }
  const csrf = () => ({ 'x-csrf-token': cookies.get('manythreads_csrf') ?? '' });
  const api = {
    get: (path) => call('GET', path),
    post: (path, body) => call('POST', path, body ?? {}, csrf()),
    put: (path, body) => call('PUT', path, body, csrf()),
    patch: (path, body) => call('PATCH', path, body, csrf()),
  };
  people.set(who, api);
  return api;
}

async function teamId(slug) {
  const rows = await sql(`SELECT id FROM app.teams WHERE slug = $1`, [slug]);
  if (!rows[0]) throw new Error(`no team ${slug}`);
  return rows[0].id;
}

async function channelId(team, name) {
  const rows = await sql(`SELECT id FROM app.channels WHERE team_id = $1 AND name = $2 AND archived_at IS NULL`, [await teamId(team), name]);
  if (!rows[0]) throw new Error(`no #${name} in ${team}`);
  return rows[0].id;
}

/** A BOT.md: the definition is the bot, so every scenario writes one and waits for the loader to accept it. */
async function defineBot(slug, options) {
  const lines = [
    '---',
    'schema: 1',
    `name: ${options.name}`,
    `role: ${options.role ?? 'A test bot for the live Hermes check'}`,
    'kind: agent',
    'runtime: hermes',
    'model:',
    `  aliases: [${(options.aliases ?? ['smart']).join(', ')}]`,
  ];
  if (options.triggers) {
    lines.push('triggers:');
    for (const trigger of options.triggers) {
      lines.push(`  - type: ${trigger.type}`);
      if (trigger.channels) lines.push('    source:', `      channels: [${trigger.channels.map((c) => `"${c}"`).join(', ')}]`);
    }
  }
  if (options.capabilities) lines.push('capabilities:', `  native: [${options.capabilities.join(', ')}]`);
  if (options.needsApproval) lines.push('approvals:', `  needsApproval: [${options.needsApproval.join(', ')}]`);
  if (options.mayTag) lines.push('handover:', `  mayTag: [${options.mayTag.join(', ')}]`);
  if (options.gate) lines.push('guard:', `  gate: [${options.gate.map((g) => `'${g}'`).join(', ')}]`);
  lines.push('limits:', '  timeoutSeconds: 240', '---', '', `# ${options.name}`, '', options.soul.trim(), '');
  const omar = await as('omar');
  await omar.post('/api/teams/engineering/repo/commit', {
    message: `bots/${slug}: ${options.name}`,
    changes: [{ op: 'put', path: `bots/${slug}/BOT.md`, content: lines.join('\n'), encoding: 'utf8', baseBlobSha: null }],
  });
  const rows = await waitForRow(
    `SELECT id, status, model_aliases, invalid_reason, runtime FROM app.bots WHERE slug = $1 ORDER BY created_at DESC`,
    [slug],
    (r) => r.length > 0 && (r[0].status === 'active' || r[0].invalid_reason !== null),
    90_000,
    `${slug} loaded`,
  );
  if (rows[0].invalid_reason) throw new Error(`${slug} did not load: ${rows[0].invalid_reason}`);
  if (options.expectKey !== false) {
    try {
      await waitForRow(`SELECT 1 FROM app.llm_keys WHERE bot_id = $1`, [rows[0].id], (r) => r.length > 0, 60_000, `${slug} key minted`);
    } catch (err) {
      // The key is minted by a job: say what the queue knows before giving up.
      const jobs = await sql(`SELECT name, status, attempts, left(coalesce(last_error, ''), 300) AS err FROM app.jobs ORDER BY created_at DESC LIMIT 8`).catch(() => []);
      throw new Error(`${err instanceof Error ? err.message : String(err)}; jobs ${shown(jobs)}`);
    }
  }
  return rows[0];
}

/** One JSONL line the server logged about a run, for the report. */
const serverLogs = (pattern, limit = 6) =>
  (children.find((c) => c.live?.name === 'stack')?.live.text() ?? '')
    .split('\n')
    .filter((line) => pattern.test(line))
    .slice(-limit);

async function postMessage(who, channel, body, threadRootId = null) {
  const api = await as(who);
  return api.post(`/api/channels/${channel}/messages`, { channelId: channel, threadRootId, body });
}

/** The newest message the bot wrote in a channel, or undefined. */
async function botReply(botId, channel, afterIso) {
  const rows = await sql(
    `SELECT m.id, m.body_plain, m.thread_root_id, m.meta, m.created_at FROM app.messages m
       WHERE m.channel_id = $1 AND m.author_id = (SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $2)
         AND ($3::timestamptz IS NULL OR m.created_at >= $3::timestamptz)
       ORDER BY m.created_at DESC LIMIT 1`,
    [channel, botId, afterIso ?? null],
  );
  return rows[0];
}

async function waitReply(botId, channel, afterIso, budgetMs = 240_000) {
  return (await waitForRow(
    `SELECT m.id, m.body_plain, m.thread_root_id, m.meta, m.meta->'answer' AS answer, m.created_at FROM app.messages m
       WHERE m.channel_id = $1 AND m.author_id = (SELECT id FROM app.actors WHERE kind = 'bot' AND ref_id = $2)
         AND ($3::timestamptz IS NULL OR m.created_at >= $3::timestamptz)
       ORDER BY m.created_at DESC LIMIT 1`,
    [channel, botId, afterIso ?? null],
    (r) => r.length > 0,
    budgetMs,
    'bot reply',
  ))[0];
}

async function waitForValue(fn, budgetMs = 30_000, stepMs = 500) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return undefined;
}

async function waitRun(botId, budgetMs = 240_000, since) {
  return (await waitForRow(
    `SELECT id, status, trigger_type, delegation_depth, started_at, ended_at FROM app.bot_runs
       WHERE bot_id = $1 AND ($2::timestamptz IS NULL OR started_at >= $2::timestamptz)
       ORDER BY started_at DESC`,
    [botId, since ?? null],
    (r) => r.length > 0 && r[0].status !== 'running',
    budgetMs,
    'run ended',
  ))[0];
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenarios. Each one is a person's action and the same path the app takes.

const SCENARIOS = {
  async mention() {
    const bot = await defineBot('probe', {
      name: 'Probe',
      triggers: [{ type: 'mention' }, { type: 'conversation' }],
      capabilities: ['messages.post', 'messages.search'],
      soul: [
        'You are Probe, a test bot in the Engineering team of manythreads.',
        '- You have the tools the platform grants you over MCP. `messages.search` searches the team’s messages.',
        '- When asked to look something up, call `messages.search` and quote one hit in one sentence.',
        '- Answer in the thread you were asked in. Never invent a hit you did not read.',
      ].join('\n'),
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    const asked = await postMessage('omar', dev, '@probe use messages.search for the word "canary" and quote one hit, in one sentence.');
    const run = await waitRun(bot.id, 240_000, since);
    const reply = await waitReply(bot.id, dev, since);
    const sources = await sql(`SELECT source_type, count(*)::int AS n FROM app.run_source_log WHERE run_id = $1 GROUP BY 1`, [run.id]);
    result(
      'mention: a real run answers in the thread and uses the MCP tool',
      run.status === 'done' && reply?.thread_root_id === asked.id && (sources[0]?.n ?? 0) > 0,
      `run ${run.status}, reply ${shown(reply?.body_plain?.slice(0, 120))}, sources ${shown(sources)}`,
    );
  },

  async conversation() {
    const bot = await defineBot('chatty', {
      name: 'Chatty',
      triggers: [{ type: 'conversation' }],
      capabilities: ['messages.post'],
      soul: 'You are Chatty. Answer every message in one short sentence, always mentioning the word "acknowledged".',
    });
    const nadia = await as('nadia');
    const opened = await nadia.post('/api/teams/engineering/bots/chatty/conversation', {});
    const since = new Date().toISOString();
    await nadia.post(`/api/channels/${opened.channelId}/messages`, { channelId: opened.channelId, threadRootId: null, body: 'Are you there?' });
    const run = await waitRun(bot.id, 240_000, since);
    const reply = await waitReply(bot.id, opened.channelId, since);
    result(
      'conversation: a person’s private conversation wakes the bot and the reply lands in it',
      run.status === 'done' && run.trigger_type === 'conversation' && /acknowledged/i.test(reply?.body_plain ?? ''),
      `run ${run.status}/${run.trigger_type}, reply ${shown(reply?.body_plain?.slice(0, 120))}`,
    );
  },

  async channel_message() {
    const bot = await defineBot('watcher', {
      name: 'Watcher',
      triggers: [{ type: 'channel_message', channels: ['#releases'] }],
      capabilities: ['messages.post'],
      soul: 'You are Watcher. When a message arrives, answer in one short sentence that starts with "Noted:".',
    });
    const releases = await channelId('engineering', 'releases');
    const since = new Date().toISOString();
    await postMessage('nadia', releases, 'The canary is holding at 10% for the next half hour.');
    const run = await waitRun(bot.id, 240_000, since);
    const reply = await waitReply(bot.id, releases, since);
    result(
      'channel_message: a message in a watched channel wakes the bot without a mention',
      run.status === 'done' && run.trigger_type === 'channel_message' && /noted/i.test(reply?.body_plain ?? ''),
      `run ${run.status}/${run.trigger_type}, reply ${shown(reply?.body_plain?.slice(0, 120))}`,
    );
  },

  async delegation() {
    const helper = await defineBot('helper', {
      name: 'Helper',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post'],
      soul: 'You are Helper. Answer every message with the single word "confirmed".',
    });
    const lead = await defineBot('lead', {
      name: 'Lead',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post'],
      mayTag: ['helper'],
      soul: 'You are Lead. Your reply must be exactly this line and nothing else: "@helper please confirm."',
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    const asked = await postMessage('omar', dev, '@lead hand this over.');
    const first = await waitRun(lead.id, 240_000, since);
    const second = await waitRun(helper.id, 240_000, since);
    const helperReply = await waitReply(helper.id, dev, since);
    result(
      'delegation: a bot’s @mention of a bot it may tag starts a second run, one hop deep, in the same thread',
      first.status === 'done' && second.status === 'done' && second.delegation_depth === 1 && helperReply?.thread_root_id === asked.id,
      `lead ${first.status}, helper ${second.status} depth ${second.delegation_depth}, reply ${shown(helperReply?.body_plain?.slice(0, 80))}`,
    );
  },

  async answer() {
    const bot = await defineBot('librarian', {
      name: 'Librarian',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post', 'messages.search', 'answer.post'],
      soul: [
        'You are Librarian, the team’s researcher. You always finish with the `answer.post` tool, never with an ordinary text reply:',
        'the tool is your reply, and it is what shows the person which message you read.',
        '1. Call `messages.search` with the query "deploy".',
        '2. Take the first hit. Call `answer.post` once, with a one-sentence summary of that hit followed by " [1]", and sources',
        '   `[{"kind":"message","messageId":"<the first hit id>"}]` (the field is `messageId`, not `id`).',
        '3. After the tool answers, say nothing more.',
      ].join('\n'),
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    await postMessage('omar', dev, '@librarian what has the team said about deploys? Answer through the answer tool, citing what you read.');
    const run = await waitRun(bot.id, 240_000, since);
    const reply = await waitReply(bot.id, dev, since);
    // `meta` is jsonb: pg hands it back parsed, but a stand-in driver may hand back the text, so read either.
    const meta = typeof reply?.meta === 'string' ? JSON.parse(reply.meta) : reply?.meta;
    const answer = meta?.answer ?? reply?.answer;
    const sources = await sql(`SELECT source_type, count(*)::int AS n FROM app.run_source_log WHERE run_id = $1 GROUP BY 1`, [run.id]);
    // The stored payload calls them `citations` (the tool takes `sources`): what a client draws is `meta.answer.citations`.
    result(
      'answer: the run finishes through answer.post and the message carries its citations',
      run.status === 'done' && answer !== undefined && Array.isArray(answer.citations) && answer.citations.length > 0,
      `run ${run.status}, tools read ${shown(sources)}, answer ${answer === undefined ? 'missing' : `${shown(answer.citations.map((c) => `${c.n}:${c.kind}`))} body ${shown(String(answer.body ?? '').slice(0, 90))}`}`,
    );
  },

  async approval() {
    const bot = await defineBot('editor', {
      name: 'Editor',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post', 'pages.write'],
      needsApproval: ['pages.write'],
      soul: [
        'You are Editor. Call `pages.write` with mode "create", path "pages/live-approval.md" and content "Written after a person approved."',
        'After the tool answers, reply with one short sentence saying what happened.',
      ].join('\n'),
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    // Asked by a member, so the team lead can decide it: the asker may never approve their own message.
    await postMessage('nadia', dev, '@editor create that page now.');
    const run = await waitRun(bot.id, 240_000, since);
    const pending = (await waitForRow(`SELECT id, status, tool, source, outcome FROM app.approvals WHERE bot_id = $1 ORDER BY created_at DESC`, [bot.id], (r) => r.length > 0, 60_000, 'approval filed'))[0];
    const omar = await as('omar');
    await omar.post(`/api/teams/engineering/approvals/${pending.id}/approve`, {});
    // The decision is immediate; the call it re-runs is a job, so wait for the outcome as well as the status.
    const done = (
      await waitForRow(
        `SELECT status, outcome, outcome_detail FROM app.approvals WHERE id = $1`,
        [pending.id],
        (r) => r.length > 0 && r[0].status === 'approved' && (r[0].outcome === 'ran' || r[0].outcome === 'failed'),
        180_000,
        'approved call ran',
      )
    )[0];
    // The call the approval re-ran wrote the page: read it back through the repo route, as the app does.
    const page = await waitForValue(async () => {
      const got = await omar.get(`/api/teams/engineering/repo/blob?path=${encodeURIComponent('pages/live-approval.md')}`).catch(() => undefined);
      return got?.content?.includes('approved') === true ? got : undefined;
    }, 30_000).catch(() => undefined);
    result(
      'approval: the call stops for a person, and approving it makes the call once',
      run.status === 'stopped' && pending.tool === 'pages.write' && done.status === 'approved' && done.outcome === 'ran' && page?.content?.includes('approved'),
      `run ${run.status}, approval ${pending.status}/${pending.tool}, decided ${done.status}/${done.outcome} (${done.outcome_detail}), page ${shown(page?.content?.slice(0, 60))}`,
    );
  },

  async gate() {
    const bot = await defineBot('gated', {
      name: 'Gated',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post'],
      gate: ['credential rotation'],
      soul: 'You are Gated. Answer every message in one short sentence.',
    });
    const dev = await channelId('engineering', 'dev');
    await postMessage('nadia', dev, '@gated please start the credential rotation for the build servers.');
    const held = (await waitForRow(`SELECT id, status, tool, source FROM app.approvals WHERE bot_id = $1 AND source = 'dlp' ORDER BY created_at DESC`, [bot.id], (r) => r.length > 0, 90_000, 'gate approval'))[0];
    const firstRun = (await sql(`SELECT status FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at DESC LIMIT 1`, [bot.id]))[0];
    const omar = await as('omar');
    await omar.post(`/api/teams/engineering/approvals/${held.id}/approve`, {});
    const reply = await waitReply(bot.id, dev, new Date(Date.now() - 1_000).toISOString(), 240_000);
    const runs = await sql(`SELECT status FROM app.bot_runs WHERE bot_id = $1 ORDER BY started_at`, [bot.id]);
    result(
      'gate: the words hold the message before any model call, and approving re-runs it',
      held.tool === 'llm.gate' && firstRun?.status === 'stopped' && runs.length >= 2 && reply !== undefined,
      `held as ${held.tool}, run ${firstRun?.status}, runs ${shown(runs.map((r) => r.status))}, reply ${shown(reply?.body_plain?.slice(0, 100))}`,
    );
  },

  async tasks() {
    const bot = await defineBot('board', {
      name: 'Board',
      triggers: [{ type: 'mention' }],
      capabilities: ['messages.post', 'tasks.read', 'tasks.claim'],
      soul: [
        'You are Board. Use the tools:',
        '1. Call `tasks.claim` with the taskId the person gives you.',
        '2. Reply with one short sentence saying whether the claim worked.',
      ].join('\n'),
    });
    const omar = await as('omar');
    const created = await omar.post('/api/teams/engineering/tasks', {
      title: 'Live Hermes board card',
      description: 'Claimed by a real agent run.',
      kind: 'code',
      priority: 'normal',
      branch: 'feature/live-hermes',
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    await postMessage('omar', dev, `@board claim the card ${created.task.id} with tasks.claim, then tell me.`);
    const run = await waitRun(bot.id, 240_000, since);
    const event = await waitForRow(
      `SELECT type, actor_id FROM app.task_events WHERE task_id = $1 AND type = 'claimed'`,
      [created.task.id],
      (r) => r.length > 0,
      60_000,
      'claim event',
    );
    result(
      'tasks: a real run claims a board card, and the board records the claim',
      run.status === 'done' && event.length > 0,
      `run ${run.status}, events ${shown(event.map((e) => e.type))}`,
    );
  },

  async failure() {
    // A bot that may not post: the run happens, and the reply is refused by the broker (P5-10's failure case, live).
    const bot = await defineBot('mute', {
      name: 'Mute',
      triggers: [{ type: 'mention' }],
      capabilities: [],
      soul: 'You are Mute. Answer every message in one short sentence.',
    });
    const dev = await channelId('engineering', 'dev');
    const since = new Date().toISOString();
    await postMessage('omar', dev, '@mute say something.');
    const run = await waitRun(bot.id, 240_000, since);
    const reply = await botReply(bot.id, dev, since);
    result(
      'failure: a bot without messages.post runs and its reply is refused, so nothing is posted',
      run.status === 'failed' && reply === undefined,
      `run ${run.status}, reply ${reply === undefined ? 'none' : shown(reply.body_plain.slice(0, 80))}`,
    );
  },
};

// ---------------------------------------------------------------------------------------------------------------------

async function main() {
  say(`upstream ${UPSTREAM} as model ${UPSTREAM_MODEL}; hermes ${HERMES_BIN}; profiles ${RUNTIME_DIR}`);
  const relay = start('relay', 'pnpm', ['exec', 'tsx', 'tools/fake-llm/src/cli.ts'], {
    FAKE_LLM_PORT: RELAY_PORT,
    FAKE_LLM_MASTER_KEY: MASTER,
    FAKE_LLM_UPSTREAM: UPSTREAM,
    FAKE_LLM_UPSTREAM_KEY_ENV: UPSTREAM_KEY_ENV,
    FAKE_LLM_UPSTREAM_MODEL: UPSTREAM_MODEL,
  });
  await waitFor(relay, /fake-llm ready: (\S+)/, 60_000, 'relay');
  say(`relay ready at ${RELAY}`);

  const stack = start('stack', 'pnpm', ['exec', 'tsx', 'e2e/fixtures/stack-server.ts'], {
    NODE_ENV: 'test',
    MANYTHREADS_STACK_SEED: SEED,
    MANYTHREADS_STACK_API_ONLY: '1',
    MANYTHREADS_TEST_AUTH_TOKEN: 'live-hermes-token',
    MANYTHREADS_STACK_LOG: '1',
    MANYTHREADS_HERMES_BIN: HERMES_BIN,
    MANYTHREADS_HERMES_KILL_GRACE: '5',
    MANYTHREADS_RUNTIME_DIR: RUNTIME_DIR,
    MANYTHREADS_LITELLM_URL: RELAY,
    MANYTHREADS_LITELLM_MASTER_KEY: MASTER,
  });
  const line = await waitFor(stack, /MANYTHREADS_STACK (\{.*\})/, 180_000, 'stack');
  ready = JSON.parse(line[1]);
  say(`stack ready at ${ready.origin} (database ${ready.database})`);

  db = new pg.Client({ connectionString: ready.ownerUrl });
  // The stack drops its database on SIGTERM while this client may still be open: a late error is the harness's own exit.
  db.on('error', () => undefined);
  await db.connect();

  const omar = await as('omar');
  const bound = await omar.put('/api/workspace/llm/aliases/smart', { model: UPSTREAM_MODEL });
  say(`bound alias smart → ${bound.alias?.model ?? UPSTREAM_MODEL}`);

  const names = ONLY.length > 0 ? ONLY : Object.keys(SCENARIOS);
  for (const name of names) {
    const scenario = SCENARIOS[name];
    if (!scenario) throw new Error(`unknown scenario ${name}`);
    const at = Date.now();
    try {
      await scenario();
    } catch (err) {
      result(name, false, `${err instanceof Error ? err.message : String(err)}`);
    }
    say(`(${name} took ${Math.round((Date.now() - at) / 1000)}s)`);
  }

  const failed = results.filter((r) => !r.ok);
  say(`summary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    const lines = serverLogs(/runtime-hermes|"level":(40|50)/i, 30);
    say(`server lines:\n${lines.join('\n')}`);
  }
}

try {
  await main();
} catch (err) {
  say(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  for (const child of children) say(`--- ${child.live.name} tail\n${child.live.text().slice(-3000)}`);
  process.exitCode = 1;
} finally {
  await db?.end().catch(() => undefined);
  for (const child of children) child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 1500));
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  process.exit(process.exitCode ?? (results.some((r) => !r.ok) ? 1 : 0));
}
