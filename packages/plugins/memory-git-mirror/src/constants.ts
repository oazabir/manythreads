/** The queue that drains the mirror's work list: an enqueue behind every change (the latency) and cron every minute (the safety net). */
export const DRAIN_QUEUE = 'memory-git-mirror.drain';
/** Writes a team's bundle root once, on first use (one job per team, deduplicated). */
export const ENSURE_QUEUE = 'memory-git-mirror.ensure';
/** The daily consolidation: finds the teams that had activity yesterday and queues one journal job each. */
export const JOURNAL_QUEUE = 'memory-git-mirror.journal';
/** Writes one team's journal for one day. */
export const JOURNAL_TEAM_QUEUE = 'memory-git-mirror.journal-team';

/** Concepts read per drain, across teams. */
export const DRAIN_BATCH = 100;
/** Items per engine call (the provider takes at most 100). */
export const RETAIN_CHUNK = 25;
/** A change waits this long before it is read, so an edit burst is one document. */
export const DEBOUNCE_MS = 5_000;
/** A concept whose bot-authoring run has not closed yet is looked at again after this. */
export const DEFER_MS = 30_000;
/** ... and for at most this long; then it is withheld as `run_open`, because a run that never closes cannot be judged. */
export const DEFER_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** An engine failure backs off 30 s, 60 s, ... up to 30 minutes; after this many attempts to retain the concept is logged `failed` and dropped. */
export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60 * 1000;
/** A source waiting for a digest key it never got is dropped after this many looks. */
export const KEYLESS_MAX_DEFERRALS = 20;

/** The text of one concept the engine is given: the engine takes 20,000 characters per item; the mirror stays under it with room for the header. */
export const MAX_DOC_CHARS = 18_000;
/** At most this many links in one journal; the rest are counted. */
export const JOURNAL_MAX_LINKS = 200;
