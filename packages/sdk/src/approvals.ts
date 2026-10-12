import type { ApprovalResume, ApprovalSource } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The one handler for `needsApproval` (SPEC §7.3; PLAN P5-20): `ctx.providers.get<ApprovalProvider>('approvals')`, registered by the approvals
// plugin. A call that must wait for a person — whichever of the four sources says so (an Environment with `protected: true`, `dispatch: strict`,
// the DLP `require_approval` outcome, the grant's own flag) — asks for an approval here instead of writing rows of its own. Look it up when a
// request arrives, not in `register` (the approvals plugin may load after you).

/** What a caller gives the handler. The bot, the team, the person who asked and the thread the run answers in are read from the run itself. */
export interface ApprovalRequestInput {
  /** The run that is stopping. */
  runId: string;
  /** Which of the four sources set `needsApproval` (see `approvalSourceFor` in `@manythreads/shared`). */
  source: ApprovalSource;
  /** The capability that waits (`email.send`); `llm.call` for the model call a DLP hold stopped. */
  tool: string;
  /** One line for the Approvals inbox: what is being asked, in words. */
  summary: string;
  /** What an approver is shown of the call: build it with `previewArgs` (clipped, secrets hidden), never the raw arguments. */
  argsPreview: Record<string, unknown>;
  /** What approving does: re-run the tool call (`tool`, done by the approvals plugin) or hand `payload` back to the caller (`handoff`, see `claim`). */
  resume: ApprovalResume;
  /** `role:<tag>` / `person:<id>` principals; omitted means the bot's own `approvals.approvers`, and empty means the team's leads. */
  approvers?: readonly string[];
  /** Asking twice for the same pending thing returns the first approval (a model that retries a call must not fill the inbox). */
  dedupeKey?: string;
}

export interface ApprovalRequestResult {
  approvalId: string;
  /** False when `dedupeKey` matched a pending approval of the same bot: nothing new was written. */
  created: boolean;
}

export interface ApprovalProvider extends ProviderImpl {
  id: string;
  /**
   * Writes a pending approval for the run and tells the team (an `approvals.approval.requested` event and a live push). Runs in the
   * run's own transaction (`ctx.runs.asBot`) or in a system one (a job); the database refuses it from anyone but the run's bot or the
   * system, and from a run of another bot.
   */
  request(tx: PluginTx, input: ApprovalRequestInput): Promise<ApprovalRequestResult>;
  /** How many approvals this run is waiting on. A run with any ends `stopped`, not `done`. */
  pendingForRun(tx: PluginTx, runId: string): Promise<number>;
  /**
   * For the plugin that asked with a `handoff`: when an approved `source` approval of this bot is waiting to be taken back (the
   * `approvals.approval.decided` event says so), answers the payload it stored — exactly once. A replayed event finds it spent and gets
   * null. System transaction only (an event consumer's own); anything else gets null.
   */
  claim(tx: PluginTx, approvalId: string, expect: { botId: string; source: ApprovalSource }): Promise<Record<string, unknown> | null>;
}
