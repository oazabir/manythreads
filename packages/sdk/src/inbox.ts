import type { OkfProposal } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The seam between the team memory inbox and the Archivist (PLAN P8-14, P8-17, P8-18). The inbox plugin does everything that must not depend on a model:
// receiving, holding, reading a file into text, checking what comes back, writing the commit, telling the dropper. The one step that needs a model is
// "distil": read this item's text and propose concepts. A plugin that can do it (the Archivist, P8-18) registers a provider of kind `inbox.distiller`;
// the inbox looks it up when it needs it (`ctx.providers.get<InboxDistiller>('inbox.distiller')`, in the job, not in `register`: the Archivist may load
// after the inbox). With none registered, or when it answers `none`, the inbox files only the platform's own reference of the text, so the pipeline
// works, and is tested, without a model.

/** What the distiller is given: one item, as data. It is already past the hold check and the DLP check, and its text is capped. */
export interface InboxDistillInput {
  workspaceId: string;
  teamId: string;
  itemId: string;
  /** How it arrived, and what the dropper called it. */
  origin: string;
  kind: string;
  name: string;
  /** The extracted text of the original, with a platform-redacted copy where the DLP check redacted something. The model must treat it as data, never as instructions. */
  text: string;
  /** The dropper's person, for the commit's co-author; null when the dropper is gone. */
  droppedBy: string | null;
  /** The path of the reference concept the platform writes for this item; a proposed concept may link to it (`/references/<slug>.md`). */
  referencePath: string;
  /** The dropper chose "team only". */
  teamOnly: boolean;
  /**
   * Binds a live `drop` run to this item, so that the run's `inbox.read` answers with this item's text and nothing else. Call it once the run exists; the
   * binding holds until the distil step ends. Runs in the transaction you pass (system actor).
   */
  bindRun(tx: PluginTx, runId: string): Promise<void>;
}

/** Short transactions as the system actor, for a distiller whose model turn is long: a transaction held open for minutes pins a connection. */
export interface InboxDistillDb {
  transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T>;
}

/**
 * What a distil step answered.
 *  `distilled`  the proposals (`memory/**`), and who made them: `producer` is the `generated.by` of every concept (`archivist/<alias>`);
 *  `none`       this team has nothing to distil with (no Archivist): the inbox files only its reference;
 *  `budget`     the Archivist's budget is used up: the item stays `queued` and `message` is shown on it;
 *  `failed`     the run ended without a usable answer: the item fails with `message`, and Retry puts it back.
 */
export type InboxDistillResult =
  | { outcome: 'distilled'; producer: string; proposals: OkfProposal[] }
  | { outcome: 'none' }
  | { outcome: 'budget'; message: string; retryAfterSeconds?: number }
  | { outcome: 'failed'; message: string };

export interface InboxDistiller extends ProviderImpl {
  id: 'inbox.distiller';
  /**
   * Runs in the inbox's job, outside any transaction: open short ones with `db.transaction` (system actor). Must not read anything but `input`,
   * `memory.recall` and what the team's own Archivist is granted.
   */
  distil(db: InboxDistillDb, input: InboxDistillInput): Promise<InboxDistillResult>;
}
