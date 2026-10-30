import { createSystemPool, emit, withActor, withSystem, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { ActorId, WorkspaceId } from '@manythreads/shared';
import { createGitLayer, createRepoService, repoDirFromEnv } from '../../plugins/repo-git/src/index.ts';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, personas, TEAM_IDS } from './personas.ts';

/**
 * Fixed ids and names of seed v6 (PLAN P6-11): the work of the Engineering team. Plain data, so a spec or a screenshot script names a thing
 * here instead of repeating a string. Ids are uuidv7-shaped constants; the page and the contract are paths in the team's repository.
 */
export const SEED_WORK = {
  goal: '00000000-0000-7000-8000-0000000c0001',
  environment: { id: '00000000-0000-7000-8000-0000000c0010', name: 'production' },
  boards: {
    team: { id: '00000000-0000-7000-8000-0000000c0020', name: 'Engineering board' },
    bot: { id: '00000000-0000-7000-8000-0000000c0021', name: 'Bot Board' },
  },
  /** The cards, by column. `bot` cards belong to the Engineering `coder` bot and are written only once its row exists. */
  cards: {
    open: '00000000-0000-7000-8000-0000000c0101',
    rafi: '00000000-0000-7000-8000-0000000c0102',
    nadia: '00000000-0000-7000-8000-0000000c0103',
    verify: '00000000-0000-7000-8000-0000000c0104',
    done: '00000000-0000-7000-8000-0000000c0105',
    doneContent: '00000000-0000-7000-8000-0000000c0106',
    botProgress: '00000000-0000-7000-8000-0000000c0107',
    botWaiting: '00000000-0000-7000-8000-0000000c0108',
    botBoard: '00000000-0000-7000-8000-0000000c0109',
  },
  rhythms: {
    heartbeat: '00000000-0000-7000-8000-0000000c0201',
    routine: '00000000-0000-7000-8000-0000000c0202',
  },
  rhythmRuns: {
    done: '00000000-0000-7000-8000-0000000c0211',
    failed: '00000000-0000-7000-8000-0000000c0212',
  },
  bot: 'coder',
  channel: 'dev',
  testedSha: '3f9c2b7a41d85e60a1b2c3d4e5f60718293a4b5c',
  routinePath: 'routines/weekly-deploy-health.yaml',
  pagePath: 'pages/reports/deploy-health.md',
} as const;

const ROUTINE_COMMIT = 'Add the weekly deploy health routine';
const BOARD_COLUMNS = JSON.stringify([
  { state: 'open', title: 'Open' },
  { state: 'in_progress', title: 'In progress' },
  { state: 'verify', title: 'Verify' },
  { state: 'waiting_on_person', title: 'Waiting on a person' },
  { state: 'done', title: 'Done' },
]);
const PAGE_COMMIT = 'Add the deploy health report';

const ROUTINE_YAML = `name: Weekly deploy health
prompt: |
  Look at last week's deploys to staging and production. Count them, list any that were rolled back
  and why, and say whether the median time from merge to production got better or worse.
  Keep it under one page and link each deploy to its card.
output:
  page: ${SEED_WORK.pagePath}
  mode: replace
`;

const PAGE_MD = `# Deploy health, week of 9 March

Written by the weekly deploy health routine. It replaces this page every Monday morning.

## Last week in numbers

| Environment | Deploys | Rolled back | Median merge to deploy |
| --- | --- | --- | --- |
| staging | 14 | 0 | 12 min |
| production | 3 | 1 | 41 min |

## The rollback

The production deploy of v2.13.2 on Wednesday was rolled back after eight minutes: the new webhook retry
flooded the queue for one customer. v2.13.3 shipped on Thursday with the retry capped at five attempts.

## Worth a look

- Merge to production got slower (31 min the week before). Two of the three deploys waited for approval overnight.
- The \`verify\` column held a card for four days; it needed a second reviewer who was on leave.
`;

export interface SeedWorkOptions {
  /** Where the team repositories live (default: `MANYTHREADS_REPO_DIR`, else `./data/repos`): the server's own directory. */
  repoDir?: string;
  /** The seeded cards are dated from this day (default: Monday 2026-03-16 09:00 UTC), so a screenshot never drifts. */
  baseDate?: Date;
  /** How long to wait for the `coder` bot's row (the bots plugin makes it from `bots/coder/BOT.md` once the server is up). Default 20 s; 0 does not wait. */
  botWaitMs?: number;
  log?: (line: string) => void;
}

export interface SeedWorkResult {
  /** Why nothing was written (a plugin's tables are missing), or null. */
  skipped: string | null;
  /** What was left out for lack of something to attach to (the `coder` bot, the #dev channel): a later run fills it in. */
  notes: string[];
  /** Rows and commits this run wrote (a second run writes none). */
  written: number;
}

const systemActor = (): Actor => ({ kind: 'system', id: '00000000-0000-0000-0000-000000000000' as ActorId, workspaceId: KAHF_WORKSPACE_ID as WorkspaceId });
const omarActor = (): Actor => ({ kind: 'person', id: personas.omar.actorId as ActorId, workspaceId: KAHF_WORKSPACE_ID as WorkspaceId });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Seed v6 (PLAN P6-11): what the phase 6 screens show in a seeded world, for the Engineering team. Written only where nothing is, so a second
 * run changes nothing and a person's later edit is never undone:
 *  - the `production` environment, protected, whose deploys need a person's approval;
 *  - a goal, a team board, and seven cards across the five columns (owned by people and by the `coder` bot), one of them a finished code card
 *    with the commit that was tested; plus the channel "Bot Board" of #dev with one bot card;
 *  - a heartbeat and a weekly routine for `coder`, both **disabled** so a seeded site never starts a bot run on a timer, and two past runs
 *    (one done, one failed with its reason) for the run ledger;
 *  - the routine's contract `routines/weekly-deploy-health.yaml` and its output page `pages/reports/deploy-health.md`, committed through the
 *    repo writer (so history, authorship and events are the production ones). The pages plugin reads a page from git and makes its own
 *    `page_docs` row when somebody opens it, so none is seeded.
 * Seeded once: two commits in the team's history mark the parts as done (the report page: the board, cards, environment and goal; the routine
 * contract: the Bot Board, bot cards and rhythms), so what a person later deletes or moves is never put back. A run that could not do the bot part
 * (no bot row yet, no #dev) does it on a later run. An environment, Bot Board or other row of the same name that a person made first is used, not duplicated.
 * Needs seed v3 and v4 first (the channel #dev, the `coder` bot placeholder). The bot's row is made by the running server from that file: this
 * waits briefly for it, and leaves the bot's cards and rhythms for the next run when it is not there.
 */
export async function seedWork(db: Pick<TestDatabase, 'systemUrl'>, options: SeedWorkOptions = {}): Promise<SeedWorkResult> {
  const log = options.log ?? (() => undefined);
  const result: SeedWorkResult = { skipped: null, notes: [], written: 0 };
  const base = (options.baseDate ?? new Date(Date.UTC(2026, 2, 16, 9, 0, 0))).getTime();
  const at = (hours: number): string => new Date(base + hours * 3_600_000).toISOString();
  const team = TEAM_IDS.Engineering;
  const pool = createSystemPool(db.systemUrl, 3);
  try {
    const ready = await withSystem(
      async (tx) =>
        (
          await tx.query<{ ok: boolean }>(
            `SELECT bool_and(to_regclass('app.' || n) IS NOT NULL) AS ok FROM unnest($1::text[]) AS n`,
            [['tasks', 'environments', 'boards', 'goals', 'task_events', 'task_claims', 'rhythms', 'rhythm_runs', 'repos', 'repo_commits', 'bots', 'channels']],
          )
        ).rows[0]?.ok === true,
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
    if (!ready) {
      result.skipped = 'the tasks, rhythms, bots or repo tables are not there yet (start the server once so its plugin migrations run, then seed again)';
      log(`work skipped: ${result.skipped}`);
      return result;
    }

    const repo = createRepoService({
      repoDir: options.repoDir ?? repoDirFromEnv(),
      git: createGitLayer(),
      authorize: () => Promise.resolve({ allowed: true, reason: 'seed', needsApproval: false }),
      emit: async (tx, event) => {
        await emit(tx as unknown as Tx, { schemaVersion: 1, workspaceId: tx.actor.workspaceId, ...event });
      },
    });
    const run = <T>(actor: Actor, fn: (tx: PluginTx & Tx) => Promise<T>): Promise<T> => withActor(actor, (tx) => fn(tx as PluginTx & Tx), { pool });
    await run(systemActor(), (tx) => repo.ensure(tx, team));
    const committed = (message: string): Promise<boolean> =>
      run(systemActor(), async (tx) => (await tx.query('SELECT 1 FROM app.repo_commits WHERE team_id = $1 AND message = $2 LIMIT 1', [team, message])).rows.length > 0);
    const commit = async (message: string, path: string, content: string): Promise<number> => {
      const written = await run(omarActor(), (tx) => repo.write(tx, team, { id: tx.actor.id, kind: tx.actor.kind }, [{ path, op: 'put' as const, content }], message, [], { proposalId: 'seed' }));
      return written.noop ? 0 : 1;
    };
    // The two commits are the markers that say a part was seeded once, and they stay in the team's history whatever people later delete.
    // Without that, a card, board, environment or rhythm a person deleted would come back with every release.
    const coreDone = await committed(PAGE_COMMIT);
    const botDone = await committed(ROUTINE_COMMIT);

    const sha = (c: string): string => c.repeat(40);
    const omar = personas.omar.actorId;
    const FAR = '2100-01-01T00:00:00.000Z'; // a seeded claim never expires, or the claim sweep would hand the seeded cards back
    const MIN = 600_000;

    interface Card {
      id: string;
      title: string;
      description: string;
      /** The column the card ends in; its history is the legal path there: claimed, then verify, then done. */
      state: 'open' | 'in_progress' | 'verify' | 'waiting_on_person' | 'done';
      kind: 'code' | 'content' | 'ops' | 'other';
      priority: 'low' | 'normal' | 'high';
      owner: string | null;
      branch: string;
      baseSha?: string;
      testedSha?: string;
      blocker?: string;
      board?: string | null;
      environment?: string | null;
      createdBy: string;
      hours: number;
    }
    /** Insert a card and its history the way the tasks functions write it. A card that is already there (same id) is left alone. */
    const insertCard = async (tx: Tx, c: Card): Promise<number> => {
      const path: Card['state'][] = { open: [], in_progress: [], verify: ['verify'], waiting_on_person: ['waiting_on_person'], done: ['verify', 'done'] }[c.state] as Card['state'][];
      const steps = c.state === 'open' ? 0 : 1 + path.length; // the claim, then each move
      const t = (k: number): string => new Date(new Date(at(c.hours)).getTime() + k * MIN).toISOString();
      const doneAt = c.state === 'done' ? t(steps) : null;
      const inserted = await tx.query(
        `INSERT INTO app.tasks (id, workspace_id, team_id, goal_id, title, description, state, kind, priority, owner_id, branch, base_sha, tested_sha,
                                environment_id, blocker_reason, board_id, created_by, created_at, updated_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18::timestamptz, $19::timestamptz, $20::timestamptz)
         ON CONFLICT DO NOTHING`,
        [
          c.id, KAHF_WORKSPACE_ID, team, c.board ? null : SEED_WORK.goal, c.title, c.description, c.state, c.kind, c.priority, c.owner, c.branch,
          c.baseSha ?? null, c.testedSha ?? null, c.environment ?? null, c.blocker ?? '', c.board ?? null, c.createdBy, at(c.hours), t(steps), doneAt,
        ],
      );
      if (!inserted.rowCount) return 0;
      const ev = async (type: string, actor: string, data: Record<string, unknown>, k: number): Promise<void> => {
        await tx.query(`INSERT INTO app.task_events (task_id, team_id, actor_id, type, data, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`, [
          c.id, team, actor, type, JSON.stringify(data), t(k),
        ]);
      };
      await ev('created', c.createdBy, { kind: c.kind, priority: c.priority }, 0);
      let rows = 1;
      if (c.owner && c.state !== 'open') {
        await tx.query(
          `INSERT INTO app.task_claims (task_id, team_id, actor_id, claimed_at, expires_at, released_at) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz)`,
          [c.id, team, c.owner, t(1), FAR, doneAt],
        );
        await ev('claimed', c.owner, { expiresAt: FAR }, 1);
        rows += 1;
        let from: Card['state'] = 'in_progress';
        for (const [i, to] of path.entries()) {
          await ev(to === 'done' ? 'completed' : 'state_changed', c.owner, { from, to }, 2 + i);
          from = to;
        }
      }
      return rows;
    };

    if (!coreDone) {
      result.written += await withSystem(
        async (tx) => {
          let n = 0;
          const rows = async (text: string, params: unknown[]): Promise<number> => (await tx.query(text, params)).rowCount ?? 0;
          // An environment, goal or board a person made first (another id, same name) is the one the cards use: look the id up by its name.
          n += await rows(
            `INSERT INTO app.environments (id, workspace_id, team_id, name, protected, needs_approval, deploy_cap, auto_rollback, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, true, true, 3, true, $5, $6, $6) ON CONFLICT (team_id, name) DO NOTHING`,
            [SEED_WORK.environment.id, KAHF_WORKSPACE_ID, team, SEED_WORK.environment.name, omar, at(-2)],
          );
          const envId = (await tx.query<{ id: string }>(`SELECT id FROM app.environments WHERE team_id = $1 AND name = $2`, [team, SEED_WORK.environment.name])).rows[0]!.id;
          n += await rows(
            `INSERT INTO app.goals (id, workspace_id, team_id, title, description, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, 'Ship v2.14', 'Everything that has to land before the v2.14 release on Friday.', $4, $5, $5) ON CONFLICT DO NOTHING`,
            [SEED_WORK.goal, KAHF_WORKSPACE_ID, team, omar, at(-2)],
          );
          n += await rows(
            `INSERT INTO app.boards (id, workspace_id, team_id, name, columns, created_by, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7) ON CONFLICT DO NOTHING`,
            [SEED_WORK.boards.team.id, KAHF_WORKSPACE_ID, team, SEED_WORK.boards.team.name, BOARD_COLUMNS, omar, at(-2)],
          );
          const rafi = personas.rafi.actorId;
          const nadia = personas.nadia.actorId;
          const cards: Card[] = [
            { id: SEED_WORK.cards.open, title: 'Cap the webhook retry at five attempts', description: 'The retry loop has no ceiling; one slow customer endpoint filled the queue last Wednesday.', state: 'open', kind: 'code', priority: 'high', owner: null, branch: 'card/webhook-retry-cap', createdBy: omar, hours: 0 },
            { id: SEED_WORK.cards.rafi, title: 'Move the build cache to the new volume', description: 'CI restores the cache from the old volume, which is nearly full.', state: 'in_progress', kind: 'ops', priority: 'normal', owner: rafi, branch: 'card/build-cache-volume', createdBy: omar, hours: 2 },
            { id: SEED_WORK.cards.nadia, title: 'Show the deploy window on the release page', description: 'Put the next open deploy window next to the release owner.', state: 'in_progress', kind: 'code', priority: 'normal', owner: nadia, branch: 'card/deploy-window-banner', baseSha: sha('a'), createdBy: nadia, hours: 3 },
            { id: SEED_WORK.cards.verify, title: 'Fix the double notification on thread replies', description: 'A reply in a followed thread notified the author twice.', state: 'verify', kind: 'code', priority: 'normal', owner: rafi, branch: 'card/double-notification', baseSha: sha('b'), testedSha: sha('c'), createdBy: omar, hours: 4 },
            { id: SEED_WORK.cards.done, title: 'Retry failed webhook deliveries with backoff', description: 'Deliveries that fail are retried with exponential backoff.', state: 'done', kind: 'code', priority: 'high', owner: nadia, branch: 'card/webhook-backoff', baseSha: sha('d'), testedSha: SEED_WORK.testedSha, environment: envId, createdBy: omar, hours: 5 },
            { id: SEED_WORK.cards.doneContent, title: 'Write the v2.13 release notes', description: 'Customer-facing notes for the v2.13 release.', state: 'done', kind: 'content', priority: 'low', owner: rafi, branch: 'card/release-notes-v2-13', createdBy: omar, hours: 6 },
          ];
          for (const c of cards) n += await insertCard(tx, c);
          return n;
        },
        { pool, workspaceId: KAHF_WORKSPACE_ID },
      );
      result.written += await commit(PAGE_COMMIT, SEED_WORK.pagePath, PAGE_MD);
    }

    if (!botDone) {
      // The coder bot's row and actor (made by the bots plugin from the v4 placeholder), waited for a moment.
      const findBot = (): Promise<{ id: string; actorId: string | null } | null> =>
        withSystem(
          async (tx) =>
            (
              await tx.query<{ id: string; actor_id: string | null }>(
                `SELECT b.id, a.id AS actor_id FROM app.bots b
                   LEFT JOIN app.actors a ON a.kind = 'bot' AND a.ref_id = b.id AND a.workspace_id = b.workspace_id
                  WHERE b.team_id = $1 AND b.slug = $2`,
                [team, SEED_WORK.bot],
              )
            ).rows.map((r) => ({ id: r.id, actorId: r.actor_id }))[0] ?? null,
          { pool, workspaceId: KAHF_WORKSPACE_ID },
        );
      let bot = await findBot();
      for (const deadline = Date.now() + (options.botWaitMs ?? 20_000); (!bot || !bot.actorId) && Date.now() < deadline; ) {
        await sleep(1000);
        bot = await findBot();
      }
      const dev = await withSystem(
        async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = $2 AND kind = 'channel'`, [team, SEED_WORK.channel])).rows[0]?.id ?? null,
        { pool, workspaceId: KAHF_WORKSPACE_ID },
      );
      if (!bot?.actorId) result.notes.push(`the ${SEED_WORK.bot} bot is not loaded yet: its Bot Board card and rhythms wait for the next seed run`);
      else if (!dev) result.notes.push(`#${SEED_WORK.channel} does not exist yet: the Bot Board and the bot's rhythms wait for the conversations (seed v3)`);
      else {
        const botId = bot.id;
        const botActor = bot.actorId;
        result.written += await withSystem(
          async (tx) => {
            let n = 0;
            const rows = async (text: string, params: unknown[]): Promise<number> => (await tx.query(text, params)).rowCount ?? 0;
            // One Bot Board per channel: one a bot or a person made first is the one the card goes on.
            n += await rows(
              `INSERT INTO app.boards (id, workspace_id, team_id, channel_id, name, columns, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $8) ON CONFLICT (channel_id, name) WHERE channel_id IS NOT NULL DO NOTHING`,
              [SEED_WORK.boards.bot.id, KAHF_WORKSPACE_ID, team, dev, SEED_WORK.boards.bot.name, BOARD_COLUMNS, botActor, at(-1)],
            );
            const botBoard = (await tx.query<{ id: string }>(`SELECT id FROM app.boards WHERE channel_id = $1 AND name = $2`, [dev, SEED_WORK.boards.bot.name])).rows[0]!.id;
            const cards: Card[] = [
              { id: SEED_WORK.cards.botProgress, title: 'Review the open pull requests for the v2.14 branch', description: 'Read each open pull request and leave comments on anything that touches the deploy path.', state: 'in_progress', kind: 'other', priority: 'normal', owner: botActor, branch: 'card/pr-review-v2-14', createdBy: omar, hours: 7 },
              { id: SEED_WORK.cards.botWaiting, title: 'Rotate the staging deploy key', description: 'The key is ninety days old. The rotation needs a person to approve the new key.', state: 'waiting_on_person', kind: 'ops', priority: 'high', owner: botActor, branch: 'card/rotate-staging-key', blocker: 'Waiting for Omar to approve the new staging deploy key.', createdBy: omar, hours: 8 },
              { id: SEED_WORK.cards.botBoard, title: 'Summarise the overnight CI failures', description: 'List the CI runs that failed overnight and the likely cause of each.', state: 'in_progress', kind: 'other', priority: 'normal', owner: botActor, branch: 'card/ci-failures-summary', board: botBoard, createdBy: botActor, hours: 9 },
            ];
            for (const c of cards) n += await insertCard(tx, c);
            // Both rhythms are off (`enabled = false`, no next slot): the seeded site never wakes a bot on a timer. A lead turns them on.
            n += await rows(
              `INSERT INTO app.rhythms (id, workspace_id, team_id, bot_id, name, kind, schedule, effort, enabled, next_run_at, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'Morning check-in', 'heartbeat', '0 8 * * 1-5', 'low', false, NULL, $5, $6, $6) ON CONFLICT DO NOTHING`,
              [SEED_WORK.rhythms.heartbeat, KAHF_WORKSPACE_ID, team, botId, omar, at(-1)],
            );
            n += await rows(
              `INSERT INTO app.rhythms (id, workspace_id, team_id, bot_id, name, kind, schedule, model_alias, effort, contract_path, output_path, enabled, next_run_at, created_by, created_at, updated_at)
               VALUES ($1, $2, $3, $4, 'Weekly deploy health', 'routine', '0 8 * * 1', 'smart', 'medium', $5, $6, false, NULL, $7, $8, $8) ON CONFLICT DO NOTHING`,
              [SEED_WORK.rhythms.routine, KAHF_WORKSPACE_ID, team, botId, SEED_WORK.routinePath, SEED_WORK.pagePath, omar, at(-1)],
            );
            // Two past firings for the run ledger: last Monday's done, the one before it failed.
            const week = 7 * 24;
            n += await rows(
              `INSERT INTO app.rhythm_runs (id, rhythm_id, team_id, status, output_path, reason, started_at, ended_at)
               SELECT $1, $2, $3, 'done', $4, '', $5::timestamptz, $5::timestamptz + interval '4 minutes'
                WHERE EXISTS (SELECT 1 FROM app.rhythms WHERE id = $2) ON CONFLICT DO NOTHING`,
              [SEED_WORK.rhythmRuns.done, SEED_WORK.rhythms.routine, team, SEED_WORK.pagePath, at(-week)],
            );
            n += await rows(
              `INSERT INTO app.rhythm_runs (id, rhythm_id, team_id, status, output_path, reason, started_at, ended_at)
               SELECT $1, $2, $3, 'failed', $4, $5, $6::timestamptz, $6::timestamptz + interval '1 minute'
                WHERE EXISTS (SELECT 1 FROM app.rhythms WHERE id = $2) ON CONFLICT DO NOTHING`,
              [SEED_WORK.rhythmRuns.failed, SEED_WORK.rhythms.routine, team, SEED_WORK.pagePath, 'The model alias smart was over its daily budget, so the run stopped before it wrote the page.', at(-2 * week)],
            );
            return n;
          },
          { pool, workspaceId: KAHF_WORKSPACE_ID },
        );
        result.written += await commit(ROUTINE_COMMIT, SEED_WORK.routinePath, ROUTINE_YAML);
      }
    }
    log(`work: ${result.written} new rows and commits for the Engineering board, rhythms, page and production environment${result.notes.length ? ` (${result.notes.join('; ')})` : ''}`);
  } finally {
    await pool.end();
  }
  return result;
}
