import { createSystemPool, withSystem } from '@manythreads/kernel';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, OMAR, type Persona } from './personas.ts';
import { SEED_RUNNERS } from './seed-runners.ts';

/**
 * Seed v25 (PLAN P25-12): the bots of the run card and the to-do card, on top of seed v19. OPT-IN: nothing calls this from `seedWorld`; only the e2e stack with
 * `MANYTHREADS_STACK_SEED=runs` (e2e/fixtures/stack-server.ts) runs it, after `seedRunners`, so every other stack and baseline stays as it was.
 *
 * Three Engineering bots, made through the real routes by Omar (a workspace admin), all placed on the seeded Claude Code runner (`claude-shared`), whose far end a spec points at a
 * real agent bridge that plays tools/fake-acp-agent (the profile is `engineering--<slug>`):
 *  1. `run-demo`    the bot a person asks: it works, calls a helper, makes a plan, asks to run a command, and answers (the script of the spec says which).
 *  2. `run-lead`    an orchestrator: it keeps the thread's to-do list (`tasks.todo` is a default capability) and hands cards to the helper.
 *  3. `run-helper`  the bot a card is handed to; it is the owner of the item that follows the card.
 * What each of them does in a run is the script of the fake agent, set by the spec (e2e/runs/scripts.ts); the seed only makes the bots.
 *
 * Idempotent: a bot that is already there (by team and slug) is left alone.
 */
export const SEED_RUNS = {
  team: 'engineering',
  runner: SEED_RUNNERS.runners.claudeShared.name,
  bots: [
    { slug: 'run-demo', role: 'Works on a request and shows its work in the thread', runtime: ['files', 'shell'] },
    { slug: 'run-lead', role: 'Plans a request, keeps its to-do list and hands the parts on', runtime: ['files'] },
    { slug: 'run-helper', role: 'Takes a card from run-lead and builds it', runtime: ['files', 'shell'] },
  ],
} as const;

export interface SeedRunsOptions {
  /** The running server's address (the stack's API port). It must have been started with `devAuth`, and `seedRunners` must have run. */
  url: string;
  db: TestDatabase;
  /** Waits at most this long for the bots to load (default 90 seconds). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

const header = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

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
    '  - type: conversation',
    'capabilities:',
    '  native: [messages.post, tasks.todo]',
    `  runtime: [${runtime.join(', ')}]`,
    'placement:',
    `  runs_on: ${runsOn}`,
    '---',
    '',
    `# ${name}`,
    '',
    'A bot of the run card proofs: its work is a script, not a model.',
    '',
  ].join('\n');

/** Makes the three bots (see the top of this file). Throws with the server's words when a step is refused or the bots do not load in time. */
export async function seedRuns(options: SeedRunsOptions): Promise<{ bots: string[] }> {
  const log = options.log ?? (() => undefined);
  const pool = createSystemPool(options.db.systemUrl, 2);
  const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]): Promise<T> => withSystem(fn, { pool, workspaceId: KAHF_WORKSPACE_ID });
  try {
    for (const bot of SEED_RUNS.bots) {
      const exists = await sys(async (tx) => (await tx.query(`SELECT 1 FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = $1 AND b.slug = $2`, [SEED_RUNS.team, bot.slug])).rows.length > 0);
      if (exists) continue;
      const res = await fetch(`${options.url}/api/teams/${SEED_RUNS.team}/proposals`, {
        method: 'POST',
        headers: { ...header(OMAR), 'content-type': 'application/json' },
        body: JSON.stringify({ path: `bots/${bot.slug}/BOT.md`, op: 'put', content: botMd(bot.slug, bot.role, SEED_RUNS.runner, bot.runtime), title: `Set up ${bot.slug}`, applyNow: true }),
      });
      if (res.status >= 300) throw new Error(`seed runs: could not set up the bot ${bot.slug}: ${String(res.status)} ${(await res.text()).slice(0, 300)}`);
    }
    const slugs = SEED_RUNS.bots.map((b) => b.slug);
    const deadline = Date.now() + (options.timeoutMs ?? 90_000);
    for (;;) {
      const rows = await sys(async (tx) => (await tx.query<{ slug: string; status: string }>(`SELECT b.slug, b.status FROM app.bots b WHERE b.slug = ANY($1::text[]) AND b.workspace_id = $2::uuid`, [slugs, KAHF_WORKSPACE_ID])).rows);
      if (rows.filter((r) => r.status === 'active').length === slugs.length) break;
      if (Date.now() > deadline) throw new Error(`seed runs: timed out waiting for the bots to load (${rows.map((r) => `${r.slug}=${r.status}`).join(', ')})`);
      await new Promise((r) => setTimeout(r, 200));
    }
    log(`${String(slugs.length)} bots placed on ${SEED_RUNS.runner}`);
    return { bots: slugs };
  } finally {
    await pool.end().catch(() => undefined);
  }
}
