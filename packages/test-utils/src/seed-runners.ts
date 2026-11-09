import { createSystemPool, withSystem } from '@manythreads/kernel';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, OMAR, TEAM_IDS, type Persona } from './personas.ts';

/**
 * Seed v19 (PLAN P19-11, Bundle E decision E11): a populated Runners page with no real sign-in. OPT-IN: nothing calls this from `seedWorld`; only the e2e stack
 * with `MANYTHREADS_STACK_SEED=runners` (e2e/fixtures/stack-server.ts) runs it, so every other stack and baseline stays as it was.
 *
 * Made through the real routes of the running server, by Omar (a workspace admin), and not written to tables:
 *  1. `office-hermes`   a Hermes gateway on a machine of the office (an address and a made-up key). All teams.
 *  2. `team-pods`       the team Hermes pods (no pod exists in a stack). All teams.
 *  3. `claude-shared`   Claude Code, one pod for Engineering and Marketing, signed in with a made-up file.
 *  4. `claude-support`  Claude Code for Customer support only, signed in with a different made-up login.
 *  5. `fast-gateway`    a model called through the platform's LLM gateway on the alias `fast`. All teams.
 *  6. `codex-chatgpt`   Codex, waiting for a sign-in file (made only when this build lets an admin make a Codex runner; otherwise skipped and logged). Engineering.
 * and one bot for each, placed with `placement.runs_on` in a BOT.md applied through a proposal, as a team lead would.
 *
 * The sign-in files are made up: the shape of the real ones, with canary strings (`SEED_RUNNERS.canary`) that must never appear in any answer, event, audit row or
 * log line. No real login is read or written. The seed needs the claude-pods plugin loaded, which in a test server is `NODE_ENV=test` and
 * `MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL` pointing at a stand-in of the Kubernetes API (the e2e stack starts one for the `runners` mode); without it a Claude runner is refused
 * and the seed says so. No pod exists in such a stack, so the status the pod controller would report for the two Claude runners (`ready`) is set directly, once.
 *
 * Idempotent: a runner or a bot that is already there (by name) is left alone, so a second run changes nothing and makes no second sign-in upload.
 */
export const SEED_RUNNERS = {
  /** In every made-up sign-in file, key and token. */
  canary: 'CANARY-SEEDRUNNERS-3c8d',
  /** Where the made-up host Hermes "is". A private address (allowed by default); pass `gateway` for a real stand-in. */
  defaultGatewayUrl: 'http://192.168.50.20:8642',
  runners: {
    host: { name: 'office-hermes', label: 'Office Hermes' },
    teamPod: { name: 'team-pods', label: 'Team pods' },
    claudeShared: { name: 'claude-shared', label: 'Claude Code (Engineering and Marketing)' },
    claudeSupport: { name: 'claude-support', label: 'Claude Code (Customer support)' },
    gateway: { name: 'fast-gateway', label: 'Fast model gateway', alias: 'fast' },
    codex: { name: 'codex-chatgpt', label: 'Codex (ChatGPT)' },
  },
  /** One bot per runner: slug, team slug, the runner key, the tools it asks the runner for (none for the LLM gateway, which has no shell or files). */
  bots: [
    { slug: 'desk-helper', team: 'engineering', runner: 'host', runtime: [] },
    { slug: 'pod-helper', team: 'marketing', runner: 'teamPod', runtime: [] },
    { slug: 'code-helper', team: 'engineering', runner: 'claudeShared', runtime: ['files', 'shell'] },
    { slug: 'triage-helper', team: 'customer-support', runner: 'claudeSupport', runtime: ['files'] },
    { slug: 'quick-writer', team: 'marketing', runner: 'gateway', runtime: [] },
    { slug: 'codex-reviewer', team: 'engineering', runner: 'codex', runtime: ['files', 'shell'] },
  ],
} as const;

export type SeedRunnerKey = keyof typeof SEED_RUNNERS.runners;

/** A made-up Claude sign-in file: the shape of the real one, canary strings, one other sign-in, odd whitespace and a trailing newline. `tag` makes the login different. */
export function madeUpClaudeSignin(tag: string, now: number = Date.now()): string {
  const c = SEED_RUNNERS.canary;
  const body = {
    claudeAiOauth: {
      accessToken: `fake-access-${tag}-${c}`,
      refreshToken: `fake-refresh-${tag}-${c}`,
      expiresAt: now + 8 * 3600_000,
      scopes: ['user:inference', 'user:profile'],
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    },
    mcpOAuth: { 'notion|seed': { accessToken: `n-${c}` } },
  };
  return `${JSON.stringify(body, null, 3)}\n\n`;
}

export interface SeedRunnersOptions {
  /** The running server's address (the stack's API port, not the front). It must have been started with `devAuth`. */
  url: string;
  db: TestDatabase;
  /** The host Hermes the first runner points at: an address the server may call and its key. Default: a made-up private address and key (the runner then reads "Not tested yet"). */
  gateway?: { url: string; key: string };
  /** Waits at most this long for the bots to load (default 90 seconds). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface SeedRunnersResult {
  /** The runners made or found, by their short key (`host`, `teamPod`, `claudeShared`, `claudeSupport`, `gateway`, `codex`). `codex` is missing when this build does not let an admin make one. */
  runners: Partial<Record<SeedRunnerKey, { id: string; name: string }>>;
  /** The bots made or found, by slug, with the runner they are placed on. */
  bots: Array<{ slug: string; team: string; runner: string }>;
}

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the replies of many routes, read by field
}

const header = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

async function call(url: string, who: Persona, method: string, path: string, body?: string | unknown, extra: Record<string, string> = {}): Promise<Reply> {
  const raw = typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...header(who), ...(raw === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
    ...(raw === undefined ? {} : { body: raw }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed };
}

const refused = (what: string, r: Reply): Error => new Error(`seed runners: ${what}: ${String(r.status)} ${JSON.stringify(r.body).slice(0, 300)}`);

const botMd = (name: string, role: string, runsOn: string, runtime: readonly string[]): string =>
  [
    '---',
    'schema: 1',
    `name: ${name}`,
    `role: ${role}`,
    'kind: agent',
    'runtime: hermes',
    'model:',
    '  aliases: [smart]',
    'triggers:',
    '  - type: mention',
    'capabilities:',
    '  native: [messages.post]',
    ...(runtime.length > 0 ? [`  runtime: [${runtime.join(', ')}]`] : []),
    'placement:',
    `  runs_on: ${runsOn}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Stand-in definition for the Runners page: it exists to be placed on a runner.',
    '',
  ].join('\n');

const ROLES: Record<string, string> = {
  'desk-helper': 'Answers on the office Hermes',
  'pod-helper': 'Answers on the team pod',
  'code-helper': 'Works on code on the shared Claude Code runner',
  'triage-helper': 'Sorts support questions on the support Claude Code runner',
  'quick-writer': 'Writes short replies through the LLM gateway',
  'codex-reviewer': 'Reviews code on the Codex runner',
};

/** Seeds the runners and their bots (see the top of this file). Throws with the server's words when a step is refused or the bots do not load in time. */
export async function seedRunners(options: SeedRunnersOptions): Promise<SeedRunnersResult> {
  const { url } = options;
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const R = SEED_RUNNERS.runners;
  const pool = createSystemPool(options.db.systemUrl, 2);
  const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]): Promise<T> => withSystem(fn, { pool, workspaceId: KAHF_WORKSPACE_ID });
  try {
    const listed = await call(url, OMAR, 'GET', '/api/admin/bot-runners');
    if (listed.status !== 200) throw refused('could not read the runner list', listed);
    const found = new Map<string, { id: string; name: string }>((listed.body.items as Array<{ id: string; name: string }>).map((r) => [r.name, { id: r.id, name: r.name }]));
    const runners: SeedRunnersResult['runners'] = {};
    const made = new Set<SeedRunnerKey>();

    const ensure = async (key: SeedRunnerKey, create: Record<string, unknown>, tolerate409 = false): Promise<void> => {
      const spec = R[key];
      const there = found.get(spec.name);
      if (there) {
        runners[key] = there;
        log(`${spec.name}: already there`);
        return;
      }
      const reply = await call(url, OMAR, 'POST', '/api/admin/bot-runners', { name: spec.name, label: spec.label, ...create });
      if (reply.status === 409 && tolerate409) {
        log(`${spec.name}: skipped (${String(reply.body?.error?.message ?? 'not available')})`);
        return;
      }
      if (reply.status === 409 && JSON.stringify(reply.body).includes('claudePod')) {
        throw new Error(
          'seed runners: this server has no Claude pods plugin, so a Claude Code runner is refused. Start it with NODE_ENV=test and MANYTHREADS_CLAUDE_PODS_TEST_K8S_URL pointing at a stand-in of the Kubernetes API (the e2e stack does this for the runners mode).',
        );
      }
      if (reply.status !== 201) throw refused(`could not make ${spec.name}`, reply);
      runners[key] = { id: reply.body.runner.id as string, name: spec.name };
      made.add(key);
      log(`${spec.name}: made`);
    };

    await ensure('host', { kind: 'hermes_gateway', baseUrl: options.gateway?.url ?? SEED_RUNNERS.defaultGatewayUrl, apiKey: options.gateway?.key ?? `seed-hermes-key-${SEED_RUNNERS.canary}`, teams: { all: true } });
    await ensure('teamPod', { kind: 'hermes_pod', teams: { all: true } });
    await ensure('claudeShared', { kind: 'claude_cli', teams: { teams: [TEAM_IDS.Engineering, TEAM_IDS.Marketing] } });
    await ensure('claudeSupport', { kind: 'claude_cli', teams: { teams: [TEAM_IDS['Customer support']] } });
    await ensure('gateway', { kind: 'llm_gateway', modelAlias: R.gateway.alias, teams: { all: true } });
    await ensure('codex', { kind: 'codex_cli', teams: { teams: [TEAM_IDS.Engineering] } }, true);

    // Each Claude runner gets its own made-up login. The file goes through the real upload route, into the Secret of the Kubernetes stand-in, byte for byte.
    for (const [key, tag] of [['claudeShared', 'shared'], ['claudeSupport', 'support']] as const) {
      const runner = runners[key];
      if (!runner || !made.has(key)) continue;
      const put = await call(url, OMAR, 'PUT', `/api/admin/bot-runners/${runner.id}/credentials`, madeUpClaudeSignin(tag), { 'x-terms-ack': '1', 'x-signins-ack': '1' });
      if (put.status !== 200) throw refused(`could not upload the made-up sign-in for ${runner.name}`, put);
      // No pod controller runs in a stack: say what it would say once the pod is up.
      await sys(async (tx) => {
        await tx.query(`UPDATE app.bot_runners SET status = 'ready', status_detail = NULL, updated_at = now() WHERE id = $1::uuid AND status = 'starting'`, [runner.id]);
      });
    }

    // ---- one bot on each runner ---------------------------------------------------------------------------------------------------------------------
    const placed: SeedRunnersResult['bots'] = [];
    for (const bot of SEED_RUNNERS.bots) {
      const runner = runners[bot.runner];
      if (!runner) continue;
      placed.push({ slug: bot.slug, team: bot.team, runner: runner.name });
      const exists = await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2`, [bot.team, bot.slug])).rows.length > 0);
      if (exists) continue;
      const md = botMd(bot.slug, ROLES[bot.slug] ?? 'Placed on a runner', runner.name, bot.runtime);
      const res = await call(url, OMAR, 'POST', `/api/teams/${bot.team}/proposals`, { path: `bots/${bot.slug}/BOT.md`, op: 'put', content: md, title: `Set up ${bot.slug}`, applyNow: true });
      if (res.status >= 300) throw refused(`could not set up the bot ${bot.slug}`, res);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await sys(async (tx) =>
        (await tx.query<{ slug: string; status: string }>(`SELECT b.slug, b.status FROM app.bots b WHERE b.slug = ANY($1::text[]) AND b.workspace_id = $2::uuid`, [placed.map((p) => p.slug), KAHF_WORKSPACE_ID])).rows,
      );
      const active = rows.filter((r) => r.status === 'active').length;
      if (active === placed.length) break;
      if (Date.now() > deadline) throw new Error(`seed runners: timed out waiting for the bots to load (${rows.map((r) => `${r.slug}=${r.status}`).join(', ')})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`${String(placed.length)} bots placed`);
    return { runners, bots: placed };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
