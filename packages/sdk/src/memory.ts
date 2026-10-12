import type { PluginTx, ProviderImpl } from './types.ts';

// The team memory engine as other plugins see it (SPEC section 12.1, PLAN P5-12): `ctx.providers.get<MemoryProvider>('memory')`, registered by
// memory-hindsight (`provider.memory`; a community plugin may register another). Look it up when a request arrives, not in `register`.
//
// The one rule of this surface: **nobody names a bank.** There is no `bank`, `bankId` or `team` field on any input below, and a call that carries
// one is refused (`MemoryError` code `bank_not_allowed`). A bank is *derived* by the provider, on the server, from something the caller cannot
// choose: for a bot's run, the team of the run the transaction belongs to (which the pairing token fixed when the run was opened); for the
// platform's own work, a team id handed in a system transaction. A bot therefore cannot read or write another team's memory, and neither can a
// plugin by passing an argument.

/** One recalled fact. */
export interface MemoryHit {
  id: string;
  text: string;
  /** The engine's own kind of fact (`world`, `experience`, `observation` in Hindsight); null when it does not say. */
  type: string | null;
  /** The label the retain call gave the item. */
  context: string | null;
  tags: string[];
  /** The document the fact came from: what a forget or an idempotent re-retain addresses. */
  documentId: string | null;
}

export interface MemoryRecallRequest {
  query: string;
  /** Most hits to answer with (default 10, at most 50). */
  limit?: number;
  /** Only facts carrying all of these tags. */
  tags?: string[];
}

export interface MemoryRecallResult {
  /** The bank that was read, for the source log (`bank:<id>`); informational — a caller cannot pass it back. */
  bank: string;
  hits: MemoryHit[];
}

/** One thing to remember. The engine distils facts from `content`; it is not stored verbatim. */
export interface MemoryRetainItem {
  content: string;
  /** A short label ("meeting notes", "decision"). */
  context?: string;
  tags?: string[];
  /** When it happened (ISO 8601). */
  timestamp?: string;
  /**
   * Groups the item under a document: retaining the same id again replaces the earlier facts (idempotent), and `forget` removes them.
   * A bot's tool call cannot set it (the platform derives one from the run and the content).
   */
  documentId?: string;
  /** Platform-supplied provenance (source, actor, link); the provider adds the run's own. */
  metadata?: Record<string, string>;
}

export interface MemoryRetainOptions {
  /** Return before the engine has finished extracting (large batches, the activity feed). Default false: the facts are recallable on return. */
  async?: boolean;
}

export interface MemoryRetainResult {
  bank: string;
  /** How many items the engine accepted. */
  items: number;
  /** True when the engine will finish in the background. */
  async: boolean;
}

/** A bank already chosen — by the provider, not by you. */
export interface MemoryBank {
  /** The bank's name (`team:<workspace slug>:<team slug>`), for logs and the source log. */
  readonly id: string;
  recall(request: MemoryRecallRequest): Promise<MemoryRecallResult>;
  retain(items: readonly MemoryRetainItem[], options?: MemoryRetainOptions): Promise<MemoryRetainResult>;
  /** Removes everything retained under these document ids. Ids that are not in the bank are fine. Platform use; no bot tool reaches it. */
  forget(documentIds: readonly string[]): Promise<{ forgotten: number }>;
}

export type MemoryErrorCode =
  /** The deployment has no memory engine configured. */
  | 'not_configured'
  /** The call carried a field that names a bank (or a team). */
  | 'bank_not_allowed'
  /** The transaction is not inside a live run, or the run is not the transaction's actor's. */
  | 'no_run'
  /** `forTeam` needs the platform's own (system) transaction. */
  | 'system_required'
  /** The team does not exist. */
  | 'unknown_team'
  /** The run read something that is not provably team-visible, or was started in a private context, so it may not add to the team's bank (SPEC section 12.1). */
  | 'retain_refused'
  | 'invalid_request'
  /** The engine did not answer, or answered with an error. */
  | 'unavailable';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  constructor(code: MemoryErrorCode, message: string) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export interface MemoryProvider extends ProviderImpl {
  /** False when no engine is configured: every bank call then rejects with `not_configured`. */
  readonly enabled: boolean;
  /**
   * The bank of the run `tx` belongs to (the transaction `ctx.runs.asBot` / `asReader` hands out): the team the run was opened for, found from
   * the database by `app.run_id()`, and only while the run is live and `tx.actor` is the run's bot or the person who asked.
   * Rejects `no_run` otherwise.
   */
  forRun(tx: PluginTx): Promise<MemoryBank>;
  /** The bank of a team, for the platform's own work (feeding, the git mirror). A system transaction only; rejects `system_required` otherwise. */
  forTeam(tx: PluginTx, teamId: string): Promise<MemoryBank>;
}
