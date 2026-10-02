import { createSystemPool, emit, withActor, type Actor, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import type { ActorId, WorkspaceId } from '@manythreads/shared';
import { createGitLayer, createRepoService, repoDirFromEnv, RepoError } from '../../plugins/repo-git/src/index.ts';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, personas, TEAM_IDS, type TeamName } from './personas.ts';
import { seedDocx, seedMp4, seedPng } from './seed-assets.ts';
import { REPO_TEAM_SLUGS, repoLead, repoSteps, type RepoStep } from './seed-repo-content.ts';
import { openSeedStorage, putSeedAttachment, type SeedStorageOptions } from './seed-storage.ts';
import type { SeedAuthor } from './seed-data.ts';

/** Fixed ids of the seed v4 attachments in `#dev` (the Deploy plan PDF of seed v3 is `SEED_IDS.file`). */
export const SEED_REPO_IDS = {
  png: '00000000-0000-7000-8000-0000000f0042',
  mp4: '00000000-0000-7000-8000-0000000f0043',
  docx: '00000000-0000-7000-8000-0000000f0044',
} as const;

export const SEED_REPO_ATTACHMENTS = {
  png: { name: 'latency-before-after.png', mime: 'image/png' },
  mp4: { name: 'canary-rollout.mp4', mime: 'video/mp4' },
  docx: { name: 'release-notes-v2.14.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
} as const;

const TEAM_BY_SLUG: Record<string, TeamName> = { engineering: 'Engineering', 'customer-support': 'Customer support', marketing: 'Marketing' };

export interface SeedRepoOptions extends SeedStorageOptions {
  /** Where the team repositories live (default: `MANYTHREADS_REPO_DIR`, else `./data/repos`): the server's own directory. */
  repoDir?: string;
  /**
   * Upload the PNG, MP4 and Office attachments of `#dev` (default true) through the storage provider. Needs the channels (seed v3 content);
   * without them, or with `false`, only the repositories are written.
   */
  attachments?: boolean;
  log?: (line: string) => void;
}

export interface SeedRepoResult {
  /** Why nothing was written (the repo tables are not there yet), or null. */
  skipped: string | null;
  /** Commits this run made (a second run makes none). */
  commits: number;
  /** Teams whose repository this run touched or checked. */
  teams: number;
  /** Attachments this run uploaded or put back (the PDF of seed v3 is not counted). */
  attachments: number;
}

const authorActor = (who: SeedAuthor | 'system'): Actor =>
  who === 'system'
    ? { kind: 'system', id: '00000000-0000-0000-0000-000000000000' as ActorId, workspaceId: KAHF_WORKSPACE_ID as WorkspaceId }
    : { kind: 'person', id: personas[who].actorId as ActorId, workspaceId: KAHF_WORKSPACE_ID as WorkspaceId };

/**
 * Seed v4 (PLAN P4-13): what each template team's repository holds, committed through the repo writer as the people who would have done it
 * (SPEC section 5.1): pages (a runbook with two commits by two people, a CSV report, a digest, a changelog, a link card), a Mermaid diagram,
 * an embedded app `apps/release-checklist/` (one `index.html`, scripts only, the manythreads bridge), `memory/facts/` and `memory/journal/`,
 * `TEAM.md` from the template, and a bot placeholder under `bots/`. Plus, in `#dev`, a PNG, an MP4 and an Office file as attachments through
 * the storage provider (so with storage-local and storage-s3 alike; the PDF of seed v3 is the fourth).
 *
 * Idempotent: a step whose commit message is already in the team's history is skipped (so a person's later edit is never undone and a second
 * run makes no commit); attachments have fixed ids and are put again only when their bytes are gone. Writes go through `repo.write` as the
 * system role connection with the person as the transaction's actor, so authorship, the writer rules and the `repo.repo.committed` events
 * are the production ones. Needs the personas, the repo tables, and for attachments the channels and files tables.
 */
export async function seedRepo(db: Pick<TestDatabase, 'systemUrl'>, options: SeedRepoOptions = {}): Promise<SeedRepoResult> {
  const log = options.log ?? (() => undefined);
  const result: SeedRepoResult = { skipped: null, commits: 0, teams: 0, attachments: 0 };
  const pool = createSystemPool(db.systemUrl, 3);
  try {
    const run = <T>(who: SeedAuthor | 'system', fn: (tx: PluginTx & Tx) => Promise<T>): Promise<T> =>
      withActor(authorActor(who), (tx) => fn(tx as PluginTx & Tx), { pool });

    const have = await run('system', async (tx) => {
      const res = await tx.query<{ n: string; ok: boolean }>(
        `SELECT n, to_regclass('app.' || n) IS NOT NULL AS ok FROM unnest($1::text[]) AS n`,
        [['repos', 'repo_commits', 'repo_entries', 'channels', 'files']],
      );
      return Object.fromEntries(res.rows.map((r) => [r.n, r.ok])) as Record<string, boolean>;
    });
    if (!have['repos'] || !have['repo_commits'] || !have['repo_entries']) {
      result.skipped = 'the repo tables are not there yet (start the server once so its plugin migrations run, then seed again)';
      log(`repos skipped: ${result.skipped}`);
      return result;
    }

    const repo = createRepoService({
      repoDir: options.repoDir ?? repoDirFromEnv(),
      git: createGitLayer(),
      // Only people and the system write here; bots are checked by the broker in the server, which a seed has no use for.
      authorize: () => Promise.resolve({ allowed: true, reason: 'seed', needsApproval: false }),
      emit: async (tx, event) => {
        await emit(tx as unknown as Tx, { schemaVersion: 1, workspaceId: tx.actor.workspaceId, ...event });
      },
    });

    for (const slug of REPO_TEAM_SLUGS) {
      const teamName = TEAM_BY_SLUG[slug];
      if (!teamName) continue;
      const teamId = TEAM_IDS[teamName];
      await run('system', (tx) => repo.ensure(tx, teamId));
      result.teams += 1;

      // TEAM.md: the template's manifest, when the repository was created before the team carried its template (a minimal manifest then).
      const teamMd = await run('system', async (tx) => {
        const row = (await tx.query<{ md: string | null }>(`SELECT template_definition ->> 'teamMd' AS md FROM app.teams WHERE id = $1`, [teamId])).rows[0];
        const current = await repo.blob(tx, teamId, 'TEAM.md', 'main').catch((err: unknown) => (err instanceof RepoError && err.status === 404 ? null : Promise.reject(err)));
        return { template: row?.md ?? null, current: current ? current.content.toString('utf8') : null };
      });
      const steps: RepoStep[] = repoSteps(slug);
      if (teamMd.template && teamMd.current !== null && teamMd.current !== teamMd.template && !/^template:/m.test(teamMd.current)) {
        steps.unshift({ actor: repoLead(slug), message: 'Adopt the team template manifest', files: [{ path: 'TEAM.md', content: teamMd.template }] });
      }

      for (const step of steps) {
        const done = await run('system', async (tx) => (await tx.query('SELECT 1 FROM app.repo_commits WHERE team_id = $1 AND message = $2 LIMIT 1', [teamId, step.message])).rows.length > 0);
        if (done) continue;
        const written = await run(step.actor, (tx) =>
          repo.write(
            tx,
            teamId,
            { id: tx.actor.id, kind: tx.actor.kind },
            step.files.map((f) => ({ path: f.path, op: 'put' as const, content: f.content })),
            step.message,
            (step.coAuthors ?? []).map((who) => ({ actorId: personas[who].actorId, name: personas[who].name })),
          ),
        );
        if (!written.noop) result.commits += 1;
      }
    }
    log(`repos: ${result.commits} new commits in ${result.teams} team repositories`);

    if (options.attachments !== false && have['channels'] && have['files']) {
      const storage = await openSeedStorage(options);
      const dev = await run('system', async (tx) =>
        (await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = 'dev' AND kind = 'channel'`, [TEAM_IDS.Engineering])).rows[0]?.id ?? null,
      );
      if (!dev) {
        log('attachments skipped: #dev does not exist yet (seed the conversations first)');
      } else {
        const specs = [
          { key: 'png', bytes: seedPng(), who: 'rafi', minute: 5 },
          { key: 'mp4', bytes: seedMp4(), who: 'nadia', minute: 6 },
          { key: 'docx', bytes: seedDocx(), who: 'omar', minute: 7 },
        ] as const;
        // The history starts on a fixed Monday; the files are dated the first week, like the PDF next to them.
        const first = Date.UTC(2026, 2, 3, 9, 0, 0);
        await run('system', async (tx) => {
          for (const s of specs) {
            const meta = SEED_REPO_ATTACHMENTS[s.key];
            const put = await putSeedAttachment(tx, storage, {
              id: SEED_REPO_IDS[s.key],
              workspaceId: KAHF_WORKSPACE_ID,
              channelId: dev,
              folderPath: 'channels/dev/',
              name: meta.name,
              mime: meta.mime,
              bytes: s.bytes,
              uploaderActorId: personas[s.who].actorId,
              createdAt: new Date(first + s.minute * 60_000).toISOString(),
            });
            if (put.action !== 'unchanged') result.attachments += 1;
          }
        });
        log(`attachments in #dev: ${result.attachments} uploaded through the storage provider`);
      }
    }
  } finally {
    await pool.end();
  }
  return result;
}
