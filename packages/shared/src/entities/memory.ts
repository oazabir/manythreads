import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, RunId, TeamId, WorkspaceId } from '../ids.ts';
import { OkfFrontmatter, OkfStatus, OkfTrustTier, isStale, trustTier } from '../okf/concept.ts';
import { RunSourceScope } from './bot.ts';
import { GitSha } from './repo.ts';

// The memory retain log (PLAN.md A.5, P5-13; SPEC §12.1, §15): what the platform put into a team's memory bank, replaced there, took out of it, or
// refused to put there, and why. Every enum here matches a CHECK of the memory plugin's migration 0001_retain_log.sql (and is listed in the
// kernel's schema-enums map). The log holds ids, hashes and words — never the retained text (the hash that recognises an unchanged re-delivery is a column of the table, not a field of this shape: it is not for a client).

/** Where retained memory went. The team's bank today; `person_file` (`people/<asker>.md`) is written by `memory.write` (P5-26). */
export const MemoryStore = z.enum(['team_bank', 'person_file']);
export type MemoryStore = z.infer<typeof MemoryStore>;

/**
 * What a retained document was made of. The first five are the platform's feed (docs/plugins/memory.md); `run_tool` is a bot's own
 * `memory.retain` call (its source id is the document id the platform derived for it); `concept` is a file of the team's OKF bundle (`memory/`),
 * mirrored into the bank by `memory-git-mirror` (docs/plugins/memory-git-mirror.md; its source id is `<team id>/<path>`).
 */
export const MemorySourceKind = z.enum(['message', 'thread', 'run', 'approval', 'page', 'run_tool', 'concept']);
export type MemorySourceKind = z.infer<typeof MemorySourceKind>;

/**
 * `retained`: the engine took the document in. `forgotten`: it was taken out again (the source was deleted, edited into a new
 * document, or stopped being team-visible). `withheld`: not retained, and `reason` says why (the run read something narrower than the team).
 * `not_configured`: the deployment has no memory engine, so the feed did nothing (one entry per team per day). `failed`: the engine
 * kept refusing it and the platform stopped trying.
 */
export const MemoryRetainOutcome = z.enum(['retained', 'forgotten', 'withheld', 'not_configured', 'failed']);
export type MemoryRetainOutcome = z.infer<typeof MemoryRetainOutcome>;

/** One line of `memory_retain_log`. Readable by the team's leads and by workspace admins. */
export const MemoryRetainLogEntry = z.object({
  id: z.uuid(),
  workspaceId: WorkspaceId,
  teamId: TeamId,
  store: MemoryStore,
  /** The bank it went to, `team:<workspace slug>:<team slug>`, as named at the time. */
  bank: z.string(),
  sourceKind: MemorySourceKind,
  /** The source object's id (a message, thread, run or approval id; `<team id>/<path>` for a page or a concept; the document id for a `run_tool`). */
  sourceId: z.string(),
  /** The engine's document id for `retained` and `forgotten` lines; null otherwise. */
  documentId: z.string().nullable(),
  outcome: MemoryRetainOutcome,
  /** Why, in a word or two (`replaced`, `deleted`, `not_team_visible`, `person_source`, `private_source`, `conversation`, ...). Empty for a plain retain. */
  reason: z.string(),
  /** The run behind it, when it came from one. */
  runId: RunId.nullable(),
  /** The scopes the run's source log carried (`team`, `channel`, `person`); empty when no run or no lines. */
  sourceScopes: z.array(RunSourceScope),
  /** Who did the thing that was retained (an author, a requester, the bot of a run); null for the platform. */
  actorId: ActorId.nullable(),
  /** Where to open the source, relative to the deployment (`/t/engineering/c/dev?message=<id>`); empty when it has no page of its own. */
  link: z.string(),
  createdAt: IsoDateTime,
});
export type MemoryRetainLogEntry = z.infer<typeof MemoryRetainLogEntry>;

/**
 * What retention leaves of a run it pruned (`app.memory_run_memo`, memory migration 0002): the window the run covered, its bot, the refusal the
 * narrowest-source rule gave it at the time (null: it read nothing narrower than the team) and the approvals that were filed from it. Never its
 * source lines. System-only: no route returns it; the shape exists so that the one mapper (`toMemoryRunMemo`) is the only reader of the row.
 */
export const MemoryRunMemo = z.object({
  runId: RunId,
  workspaceId: WorkspaceId,
  teamId: TeamId,
  botId: z.uuid(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  retainRefusal: z.string().nullable(),
  approvalIds: z.array(z.uuid()),
  memoizedAt: IsoDateTime,
});
export type MemoryRunMemo = z.infer<typeof MemoryRunMemo>;

/** A concept of the team's OKF bundle as the platform sees it (PLAN P5-24, SPEC §12.1): path + validated frontmatter + body, with the derived trust tier, staleness and deprecation. */
export const MemoryConcept = z.object({
  path: z.string().min(1).max(500),
  frontmatter: OkfFrontmatter,
  body: z.string(),
  trustTier: OkfTrustTier,
  stale: z.boolean(),
  deprecated: z.boolean(),
});
export type MemoryConcept = z.infer<typeof MemoryConcept>;

/** Builds a `MemoryConcept` from a parsed concept file; `now` judges `stale_after`. */
export function toMemoryConcept(path: string, frontmatter: OkfFrontmatter, body: string, now: Date): MemoryConcept {
  return {
    path,
    frontmatter,
    body,
    trustTier: trustTier(frontmatter),
    stale: isStale(frontmatter, now),
    deprecated: frontmatter.status === 'deprecated',
  };
}

/**
 * A concept as the database's frontmatter index knows it (PLAN Appendix A.5, `memory_concepts`; SPEC §12.1): one row per concept, rebuilt from
 * `repo.committed`, holding everything but the body. The Memory screen, Brain's filters and share selection read it; git stays the truth. `stale`
 * is not a column (it depends on "now"): it is derived from `staleAfter` where it is shown.
 */
export const MemoryConceptSummary = z.object({
  path: z.string().min(1).max(500),
  type: z.string().min(1).max(200),
  title: z.string().max(500),
  description: z.string().max(2_000).nullable(),
  tags: z.array(z.string().max(100)),
  status: OkfStatus,
  staleAfter: IsoDateTime.nullable(),
  trustTier: OkfTrustTier,
  /** The extension key `origin` (`drop`, `share`, `journal`, `person`, ...), empty when the concept carries none. */
  origin: z.string().max(64),
  shareNever: z.boolean(),
  /** The team a received digest came from (the extension key `from`), when it names one. */
  fromTeam: TeamId.nullable(),
  blobSha: GitSha,
  generatedAt: IsoDateTime.nullable(),
});
export type MemoryConceptSummary = z.infer<typeof MemoryConceptSummary>;
