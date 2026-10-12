import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, RunId, TeamId, WorkspaceId } from '../ids.ts';
import { RunSourceScope } from './bot.ts';

// The memory retain log (PLAN.md A.5, P5-13; SPEC §12.1, §15): what the platform put into a team's memory bank, replaced there, took out of it, or
// refused to put there, and why. Every enum here matches a CHECK of the memory plugin's migration 0001_retain_log.sql (and is listed in the
// kernel's schema-enums map). The log holds ids, hashes and words — never the retained text (the hash that recognises an unchanged re-delivery is a column of the table, not a field of this shape: it is not for a client).

/** Where retained memory went. The team's bank today; `person_file` (`people/<asker>.md`) is written by `memory.write` (P5-26). */
export const MemoryStore = z.enum(['team_bank', 'person_file']);
export type MemoryStore = z.infer<typeof MemoryStore>;

/**
 * What a retained document was made of. The first five are the platform's feed (docs/plugins/memory.md); `run_tool` is a bot's own
 * `memory.retain` call (its source id is the document id the platform derived for it).
 */
export const MemorySourceKind = z.enum(['message', 'thread', 'run', 'approval', 'page', 'run_tool']);
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
  /** The source object's id (a message, thread, run or approval id; `<team id>/<path>` for a page; the document id for a `run_tool`). */
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
