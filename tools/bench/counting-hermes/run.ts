/**
 * PLAN P6-10, the Hermes variant of the counting benchmark (SPEC §8): twenty real bots, one counter card. Each bot is woken by one
 * message that mentions all twenty, runs on the team's own Hermes pod with real model calls, and uses its own tools to claim the card,
 * add one line to the log in its description and release it. The run passes when the log reads 1 to 20 with no gap or duplicate and the
 * card never had two owners. Everything goes through the product's HTTP API as a signed-in admin; nothing touches the database.
 *
 *   MANYTHREADS_LIVE_PASSWORD=... pnpm --filter @manythreads/tools-bench bench:counting:hermes [-- --url https://… --dry-run]
 *
 * Flags: --url (default https://manythreads.kahf.to) · --alias (default: the cheapest bound alias, `fast` first) · --timeout seconds
 * (default 1200) · --out (default docs/perf/counting-hermes.md) · --dry-run (sign in and read, change nothing) · --keep (leave the team running).
 * Re-running reuses the team and the bots and makes a fresh card; the team is archived at the end so no pod keeps running.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BOT_COUNT, botMd, slugOf } from './botmd.ts';
import { judge, type CardEvent } from './verify.ts';

const TEAM_SLUG = 'counting-bench';
const TEAM_NAME = 'Counting bench';
const CHANNEL = 'counting';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1]!.startsWith('--') ? process.argv[i + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const BASE = arg('url', 'https://manythreads.kahf.to').replace(/\/+$/, '');
const EMAIL = process.env['MANYTHREADS_LIVE_EMAIL'] ?? 'omar@kahf.example';
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const TIMEOUT_MS = Number(arg('timeout', '1200')) * 1000;
const OUT = resolve(arg('out', resolve(import.meta.dirname, '../../../docs/perf/counting-hermes.md')));
const DRY = flag('dry-run');
const KEEP = flag('keep');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const say = (m: string): void => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

// A tiny session: cookies by hand, and the CSRF cookie's value as the header every write carries.
const jar = new Map<string, string>();
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: T }> {
  // The server clears the plain cookie (an empty value) when it sets the `__Host-` one, so an empty value never counts.
  const csrf = [jar.get('__Host-manythreads_csrf'), jar.get('manythreads_csrf')].find((v) => v !== undefined && v !== '');
  const headers: Record<string, string> = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), origin: BASE };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const res = await fetch(`${BASE}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(';');
    const eq = pair!.indexOf('=');
    jar.set(pair!.slice(0, eq), pair!.slice(eq + 1));
  }
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as T) : ({} as T);
  if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${String(res.status)} ${text.slice(0, 300)}`);
  return { status: res.status, body: parsed };
}

async function signIn(): Promise<void> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set');
  const res = await api('POST', '/api/auth/password/sign-in', { email: EMAIL, password: PASSWORD });
  if (res.body['authenticated'] !== true) throw new Error('sign-in did not authenticate');
}

/** The cheapest bound alias: `fast` when bound, else the first. The price of a model is not on the alias, so the name is the signal. */
async function pickAlias(): Promise<{ alias: string; model: string }> {
  const { body } = await api<{ aliases: { alias: string; model: string }[] }>('GET', '/api/workspace/llm/aliases');
  const asked = arg('alias', '');
  const found = body.aliases.find((a) => a.alias === (asked || 'fast')) ?? (asked ? undefined : body.aliases.find((a) => a.alias !== 'local' && a.alias !== 'embed'));
  if (!found) throw new Error(`no such alias (bound: ${body.aliases.map((a) => a.alias).join(', ')})`);
  return found;
}

type TeamRow = { slug: string; archivedAt: string | null };
const MARKER_PATH = 'pages/counting-bench.md';
const MARKER_TEXT = 'This team was made by tools/bench/counting-hermes and is only used by it. The bench may archive and re-use it.\n';

/** The bench only ever reuses (and archives) a team it made itself: a marker page in the team's repo says so. */
async function hasMarker(): Promise<boolean> {
  const r = await api<{ content: string }>('GET', `/api/teams/${TEAM_SLUG}/repo/blob?path=${encodeURIComponent(MARKER_PATH)}`, undefined, [404]);
  return r.status === 200 && r.body.content === MARKER_TEXT;
}

/** Returns false when a team of that slug exists but is not the bench's: nothing is changed and the run must stop. */
async function ensureTeam(): Promise<boolean> {
  const { body } = await api<{ teams: TeamRow[] }>('GET', '/api/teams?includeArchived=true');
  const team = body.teams.find((t) => t.slug === TEAM_SLUG);
  if (!team) {
    await api('POST', '/api/teams', { name: TEAM_NAME, slug: TEAM_SLUG });
    await api('POST', `/api/teams/${TEAM_SLUG}/repo/commit`, { changes: [{ op: 'put', path: MARKER_PATH, content: MARKER_TEXT, baseBlobSha: null }], message: 'Counting bench: mark the team as the bench\'s own' });
    say(`created team ${TEAM_SLUG}`);
    return true;
  }
  if (!(await hasMarker())) {
    say(`team ${TEAM_SLUG} exists but was not made by this bench (no ${MARKER_PATH} marker): refusing to touch it`);
    return false;
  }
  if (team.archivedAt) {
    await api('POST', `/api/teams/${TEAM_SLUG}/unarchive`, {});
    say(`unarchived team ${TEAM_SLUG}`);
  } else say(`reusing team ${TEAM_SLUG}`);
  return true;
}

async function ensureChannel(): Promise<string> {
  const find = async (): Promise<string | undefined> => {
    const { body } = await api<{ groups: { channels: { id: string; name: string }[] }[] }>('GET', `/api/teams/${TEAM_SLUG}/channels`);
    return body.groups.flatMap((g) => g.channels).find((c) => c.name === CHANNEL)?.id;
  };
  const have = await find();
  if (have) return have;
  const res = await api<{ channel: { id: string } }>('POST', `/api/teams/${TEAM_SLUG}/channels`, { name: CHANNEL, purpose: 'The counting benchmark: twenty bots, one card.' });
  say(`created #${CHANNEL}`);
  return res.body.channel.id;
}

/** One commit with every definition that is new or changed; a definition already in the repo is left alone. */
async function ensureBots(alias: string): Promise<void> {
  const changes: unknown[] = [];
  for (let i = 1; i <= BOT_COUNT; i++) {
    const slug = slugOf(i);
    const content = botMd(slug, alias);
    const path = `bots/${slug}/BOT.md`;
    const cur = await api<{ blobSha: string; content: string }>('GET', `/api/teams/${TEAM_SLUG}/repo/blob?path=${encodeURIComponent(path)}`, undefined, [404]);
    if (cur.status === 404) changes.push({ op: 'put', path, content, baseBlobSha: null });
    else if (cur.body.content !== content) changes.push({ op: 'put', path, content, baseBlobSha: cur.body.blobSha });
  }
  if (changes.length === 0) return say('all twenty definitions are already in the repo');
  // P7-01: bots/ takes no direct commit; each definition is a proposal the bench's admin applies in the same step.
  for (const c of changes as Array<{ op: 'put'; path: string; content: string; baseBlobSha: string | null }>) {
    await api('POST', `/api/teams/${TEAM_SLUG}/proposals`, { path: c.path, op: 'put', content: c.content, baseBlobSha: c.baseBlobSha, title: `Counting bench: ${c.path} (model alias ${alias})`, applyNow: true });
  }
  say(`committed ${String(changes.length)} definitions`);
}

type BotRow = { slug: string; status: string; actorId: string | null; invalid: { message: string } | null };
const listBots = async (): Promise<BotRow[]> => (await api<{ bots: BotRow[] }>('GET', `/api/teams/${TEAM_SLUG}/bots`)).body.bots.filter((b) => b.slug.startsWith('counter-'));

/** Waits for twenty active bots, the team's pod, and every profile known to the gateway. */
async function waitReady(): Promise<void> {
  const deadline = Date.now() + 10 * 60_000;
  let bots: BotRow[] = [];
  while (Date.now() < deadline) {
    bots = await listBots();
    const bad = bots.filter((b) => b.status === 'invalid');
    if (bad.length) throw new Error(`invalid definitions: ${bad.map((b) => `${b.slug}: ${b.invalid?.message ?? '?'}`).join('; ')}`);
    if (bots.length === BOT_COUNT && bots.every((b) => b.status === 'active' && b.actorId)) break;
    await sleep(3000);
  }
  if (bots.length !== BOT_COUNT) throw new Error(`only ${String(bots.length)} bots loaded`);
  say('twenty bots active; waiting for the pod and its profiles');
  let podLine = '';
  while (Date.now() < deadline) {
    const conns = (await api<{ items: { id: string; kind: string; status: string }[] }>('GET', `/api/teams/${TEAM_SLUG}/hermes/connections`)).body.items;
    const managed = conns.find((c) => c.kind === 'managed');
    if (managed) {
      // The connection check is rate limited (20 a minute per person): ask about the first profile until the pod answers, then about
      // all twenty at a pace under the limit, and wait out a 429 instead of failing.
      const test = async (i: number): Promise<{ ok: boolean; error: string }> => {
        const t = await api<{ ok?: boolean; error?: string | null }>('POST', `/api/teams/${TEAM_SLUG}/hermes/connections/${managed.id}/test`, { profile: `mt-${slugOf(i)}` }, [429]);
        if (t.status === 429) {
          await sleep(60_000);
          return { ok: false, error: 'rate limited; waited a minute' };
        }
        return { ok: t.body.ok === true, error: t.body.error ?? '' };
      };
      let known = 0;
      let lastError = '';
      const first = await test(1);
      if (first.ok) {
        known = 1;
        for (let i = 2; i <= BOT_COUNT; i++) {
          await sleep(3200);
          const r = await test(i);
          if (r.ok) known++;
          else lastError = r.error;
        }
      } else {
        lastError = first.error;
      }
      const line = `${String(known)}/${String(BOT_COUNT)} profiles known${lastError ? ` (${lastError.slice(0, 100)})` : ''}`;
      if (line !== podLine) say(line);
      podLine = line;
      if (known === BOT_COUNT) return;
    } else if (podLine !== 'no managed connection yet') {
      podLine = 'no managed connection yet';
      say(podLine);
    }
    await sleep(10_000);
  }
  throw new Error(`the pod was not ready in time (${podLine})`);
}

interface TaskRow { id: string; description: string; ownerId: string | null; state: string }
const getCard = async (id: string): Promise<TaskRow> => (await api<{ task: TaskRow }>('GET', `/api/teams/${TEAM_SLUG}/tasks/${id}`)).body.task;

async function main(): Promise<void> {
  say(`target ${BASE}${DRY ? ' (dry run: nothing is changed)' : ''}`);
  await signIn();
  const { alias, model } = await pickAlias();
  say(`model alias "${alias}" -> ${model}`);
  if (DRY) {
    const { body } = await api<{ teams: TeamRow[] }>('GET', '/api/teams?includeArchived=true');
    say(`team ${TEAM_SLUG}: ${body.teams.find((t) => t.slug === TEAM_SLUG) ? 'exists' : 'not created yet'}`);
    return;
  }
  const started = new Date();
  if (!(await ensureTeam())) {
    process.exitCode = 1;
    return;
  }
  try {
    const channelId = await ensureChannel();
    await ensureBots(alias);
    await waitReady();
    const bots = await listBots();
    const slugToActor = new Map(bots.map((b) => [b.slug, b.actorId!]));

    const created = await api<{ task: { id: string } }>('POST', `/api/teams/${TEAM_SLUG}/tasks`, {
      title: `Counter ${started.toISOString().slice(0, 16)}`,
      description: '',
      kind: 'other',
      branch: `bench/counter-${started.toISOString().slice(0, 16).replace(/[^0-9]/g, '')}`,
    });
    const taskId = created.body.task.id;
    say(`counter card ${taskId}`);

    // Archiving the team does not stop runs already under way, and an earlier timed-out bench leaves some running: they hold the
    // server's run slots (6 at a time) and would delay this race by minutes. Wait until none of the bench bots has a run going.
    const quietBy = Date.now() + 30 * 60_000;
    for (;;) {
      let running = 0;
      for (const b of bots) {
        const r = await api<{ runs: { status: string }[] }>('GET', `/api/teams/${TEAM_SLUG}/bots/${b.slug}`);
        running += r.body.runs.filter((x) => x.status === 'running').length;
      }
      if (running === 0) break;
      if (Date.now() > quietBy) throw new Error(`${String(running)} earlier bench runs are still going after 30 minutes`);
      say(`${String(running)} earlier bench runs still going; waiting`);
      await sleep(30_000);
    }

    // One message names all twenty, so they all wake at once and race for the card.
    const wakeAt = Date.now();
    const mentions = bots.map((b) => `@${b.slug}`).join(' ');
    await api('POST', `/api/channels/${channelId}/messages`, { channelId, threadRootId: null, body: `${mentions} counter card ${taskId}: take your turn.` });
    say('woke all twenty');

    let card = await getCard(taskId);
    let done = false;
    let countedAt: number | null = null;
    let lastLines = -1;
    while (Date.now() - wakeAt < TIMEOUT_MS) {
      await sleep(3000);
      card = await getCard(taskId);
      const n = card.description.split('\n').filter((l) => l.trim() !== '').length;
      if (n !== lastLines) say(`${String(n)}/${String(BOT_COUNT)} counted`);
      lastLines = n;
      if (n >= BOT_COUNT && card.ownerId === null) {
        done = true;
        countedAt = Date.now();
        break;
      }
    }
    if (!done) say('timed out before twenty bots had counted');
    const wallMs = (countedAt ?? Date.now()) - wakeAt;

    // Every bot's run, started by this wake: when it began, how long it took, how it ended.
    await sleep(done ? 5000 : 0);
    const runs = new Map<string, { startedAt: string; endedAt: string | null; status: string }>();
    for (const b of bots) {
      const r = await api<{ runs: { trigger: string; startedAt: string; endedAt: string | null; status: string }[] }>('GET', `/api/teams/${TEAM_SLUG}/bots/${b.slug}`);
      const mine = r.body.runs.filter((x) => x.trigger === 'mention' && Date.parse(x.startedAt) >= wakeAt - 5000).sort((a, c) => Date.parse(a.startedAt) - Date.parse(c.startedAt))[0];
      if (mine) runs.set(b.slug, mine);
    }
    // Oldest first by event id: a uuidv7 drawn when the row is inserted, inside the card's row lock, so it follows the real order of turns
    // (a timestamp is the start of the transaction and can precede the release it waited for).
    const events = (await api<{ items: (CardEvent & { id: string })[] }>('GET', `/api/teams/${TEAM_SLUG}/tasks/${taskId}/events`)).body.items;
    card = await getCard(taskId);
    const verdict = judge({ bots: BOT_COUNT, description: card.description, events, slugToActor });
    const failedRuns = [...runs].filter(([, r]) => r.status === 'failed');
    say(verdict.ok ? `PASS in ${(wallMs / 1000).toFixed(1)} s` : `FAIL: ${verdict.failures.slice(0, 5).join(' | ')}`);

    writeResult({ started, alias, model, taskId, wallMs, done, verdict, bots, runs, events, wakeAt, description: card.description, slugToActor, failedRuns: failedRuns.length });
    say(`wrote ${OUT}`);
    process.exitCode = verdict.ok ? 0 : 1;
  } finally {
    if (KEEP) say('leaving the team running (--keep)');
    else {
      await api('POST', `/api/teams/${TEAM_SLUG}/archive`, {}, [409]).then(() => say(`archived team ${TEAM_SLUG}; its pod scales to zero`)).catch((e: unknown) => say(`could not archive: ${String(e)}`));
    }
  }
}

interface Result {
  started: Date;
  alias: string;
  model: string;
  taskId: string;
  wallMs: number;
  done: boolean;
  verdict: ReturnType<typeof judge>;
  bots: BotRow[];
  runs: Map<string, { startedAt: string; endedAt: string | null; status: string }>;
  events: CardEvent[];
  wakeAt: number;
  description: string;
  slugToActor: Map<string, string>;
  failedRuns: number;
}

function writeResult(r: Result): void {
  const actorSlug = new Map([...r.slugToActor].map(([s, a]) => [a, s]));
  const rel = (iso: string | null): string => (iso ? `${((Date.parse(iso) - r.wakeAt) / 1000).toFixed(1)} s` : '-');
  const rows = r.bots.map((b) => {
    const run = r.runs.get(b.slug);
    const claim = r.events.find((e) => e.type === 'claimed' && e.actorId === b.actorId);
    const release = r.events.find((e) => e.type === 'released' && e.actorId === b.actorId);
    const dur = run?.endedAt ? `${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)} s` : '-';
    const count = r.verdict.lines.find((l) => l.slug === b.slug)?.n ?? '-';
    return `| ${b.slug} | ${run?.status ?? 'no run'} | ${rel(run?.startedAt ?? null)} | ${dur} | ${rel(claim?.createdAt ?? null)} | ${rel(release?.createdAt ?? null)} | ${String(count)} |`;
  });
  const turnLog = r.events
    .filter((e) => e.type === 'claimed' || e.type === 'released')
    .map((e) => `${rel(e.createdAt)} ${e.type} ${actorSlug.get(e.actorId ?? '') ?? e.actorId ?? '?'}`)
    .join('\n');
  const md = `# Counting benchmark, Hermes variant

Twenty real bots on the team's own Hermes pod share one counter card. One message mentions all twenty. Each bot claims the card
(\`tasks.claim\`), reads its description, rewrites it with one more line (\`tasks.describe\`) and releases the card (\`tasks.release\`).
The run passes when the log reads 1 to 20 with no gap or duplicate and the card's history shows one owner at a time. The version with no
model (the rules runtime, SQL doors) is \`packages/plugins/tasks/test/counting.test.ts\`. How to run this one: docs/testing.md.

| | |
| --- | --- |
| Result | **${r.verdict.ok ? 'PASS' : 'FAIL'}** |
| Date | ${r.started.toISOString()} |
| Target | ${BASE} (team \`${TEAM_SLUG}\`, mode B: managed pod) |
| Model alias | \`${r.alias}\` -> \`${r.model}\` |
| Wall time, wake to twenty lines | ${(r.wallMs / 1000).toFixed(1)} s${r.done ? '' : ' (timed out, not all counted)'} |
| Spec target | 60 s (the spec's number is for the no-model variant; real models are expected to be slower) |
| Runs that ended \`failed\` | ${String(r.failedRuns)} |
| Card | \`${r.taskId}\` |

${r.verdict.ok ? '' : `## Why it failed\n\n${r.verdict.failures.slice(0, 30).map((f) => `- ${f}`).join('\n')}\n\n`}## Per bot

Times are seconds after the wake message. "Run" is the bot's run started by that message.

| Bot | Run | Run started | Run length | Claimed | Released | Count |
| --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## The counter log (the card's description)

\`\`\`
${r.description.trim()}
\`\`\`

## The card's turns (from \`task_events\`)

\`\`\`
${turnLog}
\`\`\`
`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, md);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
