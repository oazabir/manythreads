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

// The fast path of a received bundle (PLAN P8-25). Another team's digest, or an OKF bundle dropped from outside, is already memory-shaped: it needs no model. The
// inbox hands it to a plugin that registers a provider of kind `inbox.importer` (memory-share), which checks the whole bundle, refuses it whole if anything is
// wrong, and otherwise files it under `memory/shared/`. With none registered the item fails with a plain sentence (it is never filed unchecked).

/** One received bundle, as data. A digest delivered by a team has no bytes (`bytes` is null): the importer reads it from the delivery record by `itemId`. */
export interface InboxImportInput {
  workspaceId: string;
  teamId: string;
  itemId: string;
  origin: string;
  kind: string;
  name: string;
  sha256: string;
  /** The original's bytes, for a bundle dropped as a file; null for a delivered digest. */
  bytes: Uint8Array | null;
}

/**
 *  `filed`    every file passed and was committed in one commit; `paths` are the files written (the bundle's own index and log are regenerated, not copied);
 *  `refused`  nothing was filed: `code` is a short code for the audit trail, `message` the plain reason shown on the item.
 */
export type InboxImportResult =
  | { outcome: 'filed'; paths: string[]; commitSha: string; files: number; bytes: number; fromTeamId: string | null }
  | { outcome: 'refused'; code: string; message: string; fromTeamId: string | null };

export interface InboxImporter extends ProviderImpl {
  id: 'inbox.importer';
  /** Runs in the inbox's job transaction (system actor); the commit goes through the repo writer in that transaction. */
  import(tx: PluginTx, input: InboxImportInput): Promise<InboxImportResult>;
}

// ---- Dropping a finished voice room's notes into the memory inbox (PLAN P15-11) -------------------------------------------------------------------------------

/** What the meetings plugin hands over: the notes and transcript as one markdown item. */
export interface InboxDropInput {
  teamId: string;
  /** The item's name in the inbox list, e.g. `Sprint review · 8 Nov`. */
  name: string;
  markdown: string;
  origin: 'meeting';
  /** The people who said yes to being transcribed: the item is theirs to follow, and the filed concept names them as sources. */
  dropperIds: readonly string[];
  /** `external` when a guest was present: the item is held for a lead to release, like any other item that came from outside the team. */
  hold?: 'external';
  /** Where the original text lives (a repo path or a Files path), for the concept's `sources`. */
  sourcePath?: string;
}

export type InboxDropResult = { itemId: string; state: string };

/** Registered by the memory inbox plugin (kind `inbox.dropper`); runs in the caller's system transaction. */
export interface InboxDropper extends ProviderImpl {
  id: 'inbox.dropper';
  drop(tx: PluginTx, input: InboxDropInput): Promise<InboxDropResult>;
}
