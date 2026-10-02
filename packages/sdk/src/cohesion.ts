import type {
  EntityLinkView,
  EntityRef,
  EntitySummary,
  EntityType,
  LinkDirection,
  ReadStateEntry,
  ReadTarget,
  ReadTargetType,
  UnreadSummary,
} from '@manythreads/shared';
import type { PluginTx } from './types.ts';

// The cohesion services of spec §3 (read state, entity links) and the live push, as plugins see them on `ctx`.

/**
 * Counts the messages of `target` that are newer than `after` (a message id), as the caller sees them: the plugin that owns the messages
 * registers one per target type (`ctx.readState.registerCounter`). It runs in the transaction of the person whose state is being
 * recomputed, so RLS decides what counts. Count what a person would see as unread (a channel's counter leaves out thread replies).
 */
export type UnreadCounter = (tx: PluginTx, target: ReadTarget, after: string) => Promise<number>;

/** What `onPosted` needs to know about a new message. The caller works out `recipientPersonIds` (channel members, thread followers). */
export interface PostedInput extends ReadTarget {
  messageId: string;
  /** Who wrote it: an actor id or a person id. Never counted as a recipient. */
  authorId: string;
  /** People (not actor ids) who should see the message as unread. People outside the workspace or not active are ignored. */
  recipientPersonIds: readonly string[];
}

/** Thrown by `markRead` when it needs a counter for the target type and no plugin registered one. */
export class UnreadCounterMissingError extends Error {
  readonly targetType: ReadTargetType;
  constructor(targetType: ReadTargetType) {
    super(`No unread counter is registered for "${targetType}" targets: pass options.remaining or call ctx.readState.registerCounter`);
    this.name = 'UnreadCounterMissingError';
    this.targetType = targetType;
  }
}

export interface PluginReadState {
  /**
   * A message was posted to `target`: add one unread for every recipient except the author, in one statement, then emit
   * `reading.state.changed` (reason `posted`) and push the new counts to each recipient's sockets. Call it in the transaction
   * that inserted the message. Recipients whose read position is already at or past `messageId` are not counted again.
   * Resolves to the entries that changed, one per person.
   */
  onPosted(tx: PluginTx, input: PostedInput): Promise<Array<ReadStateEntry & { personId: string }>>;
  /**
   * `personId` has read `target` up to and including `upToMessageId`. Monotonic: a position older than the stored one changes nothing
   * (the current state comes back). Otherwise `unread_count` is recomputed as the number of newer messages: `options.remaining` when you
   * know it, else the counter registered for the target type (throws when there is none). The row is locked while the count is taken, so
   * a post racing with this call is counted exactly once. `tx` must be that person (or the system actor).
   */
  markRead(
    tx: PluginTx,
    personId: string,
    target: ReadTarget,
    upToMessageId: string,
    options?: { remaining?: number },
  ): Promise<ReadStateEntry>;
  /** Follow or unfollow `target` (the `followed` flag the Threads inbox filters on). Emits and pushes only when it changed. */
  setFollowed(tx: PluginTx, personId: string, target: ReadTarget, followed: boolean): Promise<ReadStateEntry>;
  /** One entry per requested target, in order; a target the person never received anything for is all zeros. At most 500 targets. */
  get(tx: PluginTx, personId: string, targets: readonly ReadTarget[]): Promise<ReadStateEntry[]>;
  /** Unread per channel (only those with unread) and one total for threads. Reads the partial unread index only. */
  unreadSummary(tx: PluginTx, personId: string): Promise<UnreadSummary>;
  /** Owner of the messages of `targetType` says how to count what is newer than a position. One per type; a second registration throws. */
  registerCounter(targetType: ReadTargetType, counter: UnreadCounter): void;
}

/** What a resolver returns for an entity the caller may see; the service adds `type` and `id`. */
export interface ResolvedEntity {
  title: string;
  subtitle?: string | null;
  href?: string | null;
}

/**
 * Looks one entity up for the caller. Runs in the caller's transaction, so RLS filters it: return null for an entity that does not
 * exist or that the caller may not see (never reveal the difference).
 */
export type EntityResolver = (tx: PluginTx, id: string) => Promise<ResolvedEntity | null>;

export interface PluginLinks {
  /**
   * Link `src` to `dst` in `teamId`. Idempotent: the same (src, dst, kind) returns the existing link with `created: false`
   * (one statement, no write on a hit). The caller must be a member of the team (RLS). A link to itself is refused.
   */
  create(
    tx: PluginTx,
    input: { teamId: string; src: EntityRef; dst: EntityRef; kind: string },
  ): Promise<{ link: EntityLinkView; created: boolean }>;
  /** Removes one link; true when it existed. */
  remove(tx: PluginTx, input: { src: EntityRef; dst: EntityRef; kind: string }): Promise<boolean>;
  /** Links of `ref` the caller can see, newest first. `out` = ref is the source, `in` = ref is the destination, `both` (default). */
  list(
    tx: PluginTx,
    ref: EntityRef,
    direction?: LinkDirection,
    options?: { kind?: string; limit?: number },
  ): Promise<EntityLinkView[]>;
  /** Typed summary of one entity through its type's resolver; null when none is registered or the caller may not see it. */
  resolve(tx: PluginTx, ref: EntityRef): Promise<EntitySummary | null>;
  /** The plugin that owns entities of `type` says how to summarise one. One per type; a second registration throws. */
  registerResolver(type: EntityType, resolver: EntityResolver): void;
}

/** Live push to a person's open sockets (every server replica delivers to its own connections). */
export interface PluginRealtime {
  /**
   * Queue `{ type, id, payload }` for every socket `personId` has open; delivered when `tx` commits (a rolled-back change is never
   * pushed). `payload` must stay under about 7 KB: push an id and let the client fetch the rest.
   */
  pushToPerson(tx: PluginTx, personId: string, type: string, payload: Record<string, unknown>): Promise<void>;
}
