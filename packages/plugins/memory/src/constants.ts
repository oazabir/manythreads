/** The queue that drains the feed's work list: cron every minute (the safety net) and an enqueue behind every change (the latency). */
export const FEED_QUEUE = 'memory.feed';
/** The sweep for documents whose source stopped being team-visible without an event (an operator's SQL): hourly. */
export const RECONCILE_QUEUE = 'memory.reconcile';
/** The catch-up that rebuilds the OKF bundle's frontmatter index from the team's tree, for a repository seeded without a commit event: daily. */
export const CONCEPTS_QUEUE = 'memory.concepts';

/** Sources read per drain, across teams. */
export const DRAIN_BATCH = 200;
/** Items per engine call (the provider takes at most 100). */
export const RETAIN_CHUNK = 25;
/** What one team's bank may be sent per minute by one process; the rest waits in the work list for the next drain. */
export const RETAINS_PER_TEAM_PER_MINUTE = 120;
export const FORGETS_PER_TEAM_PER_MINUTE = 600;
export const WINDOW_MS = 60_000;

/** A change waits this long before it is read, so an edit burst or a thread filling up is one document, not twenty. */
export const DEBOUNCE_MS = 15_000;
/** A source whose run (or whose bot's run) has not closed yet is looked at again after this. */
export const DEFER_MS = 30_000;
/** ... and for at most this long; then it is withheld as `run_open`, because a run that never closes cannot be judged. */
export const DEFER_GIVE_UP_MS = 24 * 60 * 60 * 1000;
/** An engine failure backs off 30 s, 60 s, ... up to 30 minutes; after this many attempts the source is logged `failed` and dropped. */
export const MAX_ATTEMPTS = 8;
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60 * 1000;

/** At most one `not_configured` line per team in this period (the feed would otherwise write one per message). */
export const NOT_CONFIGURED_EVERY_MS = 24 * 60 * 60 * 1000;
