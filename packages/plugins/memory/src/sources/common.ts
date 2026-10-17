import type { PluginTx } from '@manythreads/sdk';
import type { FeedItem } from '../render.ts';

// What each kind of source is, read as it is NOW (system transaction). An event only says "this changed"; `resolve*` answers what the bank
// should hold for it today:
//
//   retain   put this document in the bank (the feed compares its hash with the newest log line and does nothing when it is the same)
//   forget   the bank should hold nothing for this source (deleted, emptied, or no longer team-visible); a no-op when it never did
//   withhold the source exists and is team-visible, but something it was made from is narrower than the team (the narrowest-source rule):
//            nothing is retained and the log line says why
//   defer    the decision needs a run that has not closed yet: look again later
//   skip     nothing to do now (a pending approval, a reply that its thread document carries)
//
// A source is team-visible when it lives in a PUBLIC channel of a team (`kind = 'channel'`, not private, has a team) or, for a page, in
// the team's repo. Private channels, DMs and bot conversations are never read into a document: the resolver answers `forget` before it
// looks at the text.

export interface Provenance {
  teamId: string;
  workspaceId: string;
  channelId: string | null;
  runId: string | null;
  actorId: string | null;
  scopes: string[];
  link: string;
  /** Messages of a thread that were left out of its document because the run that wrote them read something narrower: one `withheld` line each. */
  excluded?: Array<{ messageId: string; actorId: string; reason: string }>;
}

export type Resolution =
  | { action: 'retain'; at: Provenance; item: FeedItem }
  | { action: 'forget'; reason: string }
  | { action: 'withhold'; at: Provenance; reason: string }
  | { action: 'defer'; at: Provenance; reason: string }
  | { action: 'skip'; reason: string };

export const forget = (reason: string): Resolution => ({ action: 'forget', reason });
export const skip = (reason: string): Resolution => ({ action: 'skip', reason });

export const iso = (d: Date): string => d.toISOString();

interface AuthoredVerdict extends Record<string, unknown> {
  run_open: boolean;
  retain_refusal: string | null;
  runs: number;
}

/** The narrowest-source verdict for something a bot wrote at `at` (see `app.memory_authored_verdict`). */
export async function authoredVerdict(tx: PluginTx, botActorId: string, at: Date): Promise<AuthoredVerdict> {
  const res = await tx.query<AuthoredVerdict>('SELECT run_open, retain_refusal, runs FROM app.memory_authored_verdict($1::uuid, $2::timestamptz)', [botActorId, at.toISOString()]);
  return res.rows[0] ?? { run_open: false, retain_refusal: null, runs: 0 };
}

export const channelPath = (teamSlug: string, channelName: string): string => `/t/${teamSlug}/c/${encodeURIComponent(channelName)}`;

export interface VerdictRow extends Record<string, unknown> {
  retain_refusal: string | null;
  narrowest_scope: string;
  source_lines: number;
  source_scopes: string[];
}

export interface TeamVisibleRow {
  channel_kind: string;
  channel_private: boolean;
  channel_team_id: string | null;
}

export const teamVisible = (r: TeamVisibleRow): boolean =>
  r.channel_kind === 'channel' && !r.channel_private && r.channel_team_id !== null;
