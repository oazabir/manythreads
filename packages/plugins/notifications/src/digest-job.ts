import type { PluginContext, PluginLogger, PluginTx, PresenceProvider } from '@manythreads/sdk';
import { DIGEST_DELAY_DEFAULT, DIGEST_DELAY_MAX, NotificationLevel, NotificationsDigestSentEvent, effectiveLevel, levelAllows } from '@manythreads/shared';
import { ACCOUNT_ANCHOR, mailGroups, planDigest, type DigestItem } from './digest.ts';
import { signDigestToken } from './digest-token.ts';
import { quietPeople } from './hold.ts';
import { workspaceDefaultLevel } from './levels.ts';
import { normalizePrefs, wantsInApp } from './prefs.ts';
import { previewOf } from './service.ts';

/** The email digest job: every minute it finds the people who have been away long enough and still have unread mentions or messages, and mails each one a list. */
export const DIGEST_QUEUE = 'notifications.digest';
export const DIGEST_CRON = '* * * * *';

const KINDS = ['mention', 'reply', 'dm'] as const;
/**
 * People looked at per database round, and rounds per run: a run reaches at most this many people, the next minute carries on after the last one. The
 * numbers are properties of one object only so a test can make them small; nothing else changes them.
 */
export const digestTuning = { batch: 200, maxRounds: 5, sendTimeoutMs: 45_000 };
/** Unread items read per person: the mail lists 10 and counts the rest, so a person with thousands costs no more than one with 200. */
const ITEMS_PER_PERSON = 200;
const HOUR = 3_600_000;
/** A person's first digest looks back one day; a later one looks back to the previous digest, but never more than a week. */
const FIRST_LOOKBACK_MS = 24 * HOUR;
const MAX_LOOKBACK_MS = 7 * 24 * HOUR;
/** The longest delay a person can choose: a heartbeat older than this means "away" for everyone, so only newer ones need to be listed. */
const MAX_DELAY_MS = DIGEST_DELAY_MAX * 60_000;
/** No digest is sent until the heartbeat data is this old (after a fresh install or a database crash empties it, every tab looks away for a short while). */
export const WARMUP_MS = 5 * 60_000;
// `digestTuning.sendTimeoutMs`: the most one mail may take before the job gives up on it and puts the claim back. The mail server connection has its own,
// shorter limits (20 seconds for connecting, the greeting and a silent socket); this is the backstop above them, so a stuck send can never stall the run.

/** What one server process remembers between runs. */
interface RunState {
  /** Per workspace: the last person a run that hit its cap got to; the next run starts after them, so people with higher ids are not starved. */
  cursors: Map<string, string>;
  /** The "no mail server" line is written once per process, not once a minute. */
  noMailLogged: boolean;
  warmLogged: boolean;
}
const states = new WeakMap<object, RunState>();
const stateOf = (ctx: PluginContext): RunState => {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { cursors: new Map(), noMailLogged: false, warmLogged: false }));
  return s;
};

/** What went wrong, without its text: a mail server's message can hold an address. */
const errorLabel = (err: unknown): string => {
  if (!(err instanceof Error)) return 'error';
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' ? `${err.name} ${code}` : err.name;
};

/** Rejects when `work` takes longer than `ms`; the timer is always cleared. */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('the mail server took too long')), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface Candidate {
  personId: string;
  workspaceId: string;
  name: string;
  email: string;
  delayMinutes: number;
  lastDigestAt: Date | null;
}

/** A digest that has been claimed (the person's watermark moved) and now has to be mailed. */
interface Claim {
  candidate: Candidate;
  key: string;
  previous: Date | null;
  claimedAt: Date;
  items: DigestItem[];
}

/** Where a candidate's list starts: after the previous digest, but not before the look-back limit. */
function sinceOf(c: Pick<Candidate, 'lastDigestAt'>, now: Date): Date {
  const floor = now.getTime() - MAX_LOOKBACK_MS;
  const start = c.lastDigestAt ? c.lastDigestAt.getTime() : now.getTime() - FIRST_LOOKBACK_MS;
  return new Date(Math.max(start, floor));
}

/**
 * People who get a digest now, judged by the database: active, a verified address that is their primary one, the digest on, the last digest at least
 * their delay ago, nothing held for them by Do not disturb, an unread mention, reply or direct message since the last digest, and AWAY: the latest
 * heartbeat (`seen`, from the presence provider: everyone of the workspace seen within the longest delay) is older than their own delay. Online people
 * are therefore never read, counted or re-checked by the minute. Do not disturb right now and the levels are applied by the caller (not in this table).
 */
async function candidatesAfter(tx: PluginTx, now: Date, after: string | null, workspaceId: string, seen: ReadonlyMap<string, Date>): Promise<Candidate[]> {
  const res = await tx.query<{ person_id: string; workspace_id: string; display_name: string; primary_email: string; delay_minutes: number; last_digest_at: Date | null }>(
    `SELECT p.id AS person_id, p.workspace_id, p.display_name, p.primary_email, coalesce(d.delay_minutes, $5::int) AS delay_minutes, d.last_digest_at
       FROM app.people p
       LEFT JOIN app.notification_digest d ON d.person_id = p.id
       LEFT JOIN unnest($9::uuid[], $10::timestamptz[]) AS s(person_id, seen_at) ON s.person_id = p.id
      WHERE p.workspace_id = $8::uuid AND p.status = 'active' AND ($1::uuid IS NULL OR p.id > $1::uuid)
        AND coalesce(d.enabled, true)
        AND (d.last_digest_at IS NULL OR d.last_digest_at <= now() - make_interval(mins => d.delay_minutes))
        AND (s.seen_at IS NULL OR s.seen_at <= $2::timestamptz - make_interval(mins => coalesce(d.delay_minutes, $5::int)))
        AND EXISTS (SELECT 1 FROM app.person_emails e WHERE e.person_id = p.id AND e.verified_at IS NOT NULL AND lower(e.email) = lower(p.primary_email))
        AND EXISTS (SELECT 1 FROM app.notifications m
                     WHERE m.person_id = p.id AND m.workspace_id = $8::uuid AND m.read_at IS NULL AND m.held_at IS NULL AND m.kind = ANY ($3::text[])
                       AND m.created_at > greatest(coalesce(d.last_digest_at, $2::timestamptz - make_interval(secs => $7::double precision)), $2::timestamptz - make_interval(secs => $6::double precision)))
        AND NOT EXISTS (SELECT 1 FROM app.notifications h WHERE h.person_id = p.id AND h.held_at IS NOT NULL)
      ORDER BY p.id
      LIMIT $4`,
    [after, now, [...KINDS], digestTuning.batch, DIGEST_DELAY_DEFAULT, MAX_LOOKBACK_MS / 1000, FIRST_LOOKBACK_MS / 1000, workspaceId, [...seen.keys()], [...seen.values()]],
  );
  return res.rows.map((r) => ({
    personId: r.person_id,
    workspaceId: r.workspace_id,
    name: r.display_name,
    email: r.primary_email,
    delayMinutes: r.delay_minutes,
    lastDigestAt: r.last_digest_at,
  }));
}

type ItemRow = {
  id: string;
  person_id: string;
  kind: DigestItem['kind'];
  actor_name: string;
  channel_id: string;
  channel_kind: string;
  channel_name: string;
  body_plain: string;
  ref_id: string;
  thread_root_id: string | null;
  created_at: Date;
};

/** Who can read each channel right now, asked once per channel for a whole run (one call is the audience of the channel, however many people ask). */
type AudienceCache = Map<string, Set<string>>;

async function readersOf(tx: PluginTx, channelIds: readonly string[], cache: AudienceCache): Promise<void> {
  for (const id of channelIds) {
    if (cache.has(id)) continue;
    const res = await tx.query<{ person_id: string }>('SELECT person_id FROM app.channel_audience($1::uuid)', [id]);
    cache.set(id, new Set(res.rows.map((r) => r.person_id)));
  }
}

/**
 * The unread items each person still has a right to see in a mail: unread and not held, newer than their `since`, about a message that still exists (its
 * text is read now, so an edit shows and a deletion drops the item), in a channel they can read now (a private channel or a direct message they have left
 * gives nothing), and still allowed by their settings now (the channel level, a muted channel, the per-kind switch). A digest lists only what would have told
 * the person in the app. Up to 200 of the newest unread items are read per person before the access check, so a person whose newest 200 are all in places
 * they have left sees none (they are unread notifications of a channel they cannot open; the digest has nothing safe to say about them).
 */
async function itemsFor(tx: PluginTx, candidates: readonly Candidate[], now: Date, audience: AudienceCache): Promise<Map<string, DigestItem[]>> {
  const out = new Map<string, DigestItem[]>();
  if (candidates.length === 0) return out;
  const personIds = candidates.map((c) => c.personId);
  const found = await tx.query<ItemRow>(
    `SELECT x.* FROM unnest($1::uuid[], $2::timestamptz[]) AS w(person_id, since)
       CROSS JOIN LATERAL (
         SELECT n.id, n.person_id, n.kind, n.actor_name, left(msg.body_plain, 600) AS body_plain, n.channel_id, c.kind AS channel_kind, c.name AS channel_name, n.ref_id, n.thread_root_id, n.created_at
           FROM app.notifications n
           JOIN app.channels c ON c.id = n.channel_id
           JOIN app.messages msg ON msg.id = n.ref_id AND msg.channel_id = n.channel_id AND msg.deleted_at IS NULL
          WHERE n.person_id = w.person_id AND n.read_at IS NULL AND n.held_at IS NULL AND n.kind = ANY ($3::text[]) AND n.created_at > w.since
          ORDER BY n.created_at DESC
          LIMIT $4) x`,
    [personIds, candidates.map((c) => sinceOf(c, now)), [...KINDS], ITEMS_PER_PERSON],
  );
  await readersOf(tx, [...new Set(found.rows.map((r) => r.channel_id))], audience);
  const rows = { rows: found.rows.filter((r) => audience.get(r.channel_id)?.has(r.person_id)) };
  if (rows.rows.length === 0) return out;

  const channelIds = [...new Set(rows.rows.map((r) => r.channel_id))];
  const muted = await tx.query<{ person_id: string; channel_id: string }>(
    'SELECT person_id, channel_id FROM app.channel_members WHERE muted AND person_id = ANY ($1::uuid[]) AND channel_id = ANY ($2::uuid[])',
    [personIds, channelIds],
  );
  const mutedKeys = new Set(muted.rows.map((r) => `${r.person_id}:${r.channel_id}`));
  const levels = await tx.query<{ person_id: string; channel_id: string; level: string }>(
    'SELECT person_id, channel_id, level FROM app.notification_levels WHERE person_id = ANY ($1::uuid[]) AND channel_id = ANY ($2::uuid[])',
    [personIds, channelIds],
  );
  const levelOf = new Map(levels.rows.map((r) => [`${r.person_id}:${r.channel_id}`, NotificationLevel.safeParse(r.level)]));
  const prefsRows = await tx.query<{ person_id: string; prefs: unknown }>('SELECT person_id, prefs FROM app.notification_prefs WHERE person_id = ANY ($1::uuid[])', [personIds]);
  const prefsOf = new Map(prefsRows.rows.map((r) => [r.person_id, normalizePrefs(r.prefs)]));
  const defaults = new Map<string, NotificationLevel>();
  for (const c of candidates) if (!defaults.has(c.workspaceId)) defaults.set(c.workspaceId, await workspaceDefaultLevel(tx, c.workspaceId));
  const workspaceOf = new Map(candidates.map((c) => [c.personId, c.workspaceId]));

  for (const r of rows.rows) {
    const key = `${r.person_id}:${r.channel_id}`;
    if (mutedKeys.has(key)) continue;
    const own = levelOf.get(key);
    const level = effectiveLevel(own?.success ? own.data : null, r.channel_kind, defaults.get(workspaceOf.get(r.person_id) ?? '') ?? 'mentions');
    if (!levelAllows(level, r.kind) || !wantsInApp(prefsOf.get(r.person_id) ?? normalizePrefs(null), r.kind, r.channel_id)) continue;
    out.set(r.person_id, [
      ...(out.get(r.person_id) ?? []),
      {
        notificationId: r.id,
        kind: r.kind,
        actorName: r.actor_name,
        preview: previewOf(r.body_plain),
        channelId: r.channel_id,
        channelKind: r.channel_kind,
        channelName: r.channel_name,
        messageId: r.ref_id,
        threadRootId: r.thread_root_id,
        createdAt: r.created_at,
      },
    ]);
  }
  return out;
}

/**
 * Takes the person's turn: locks their digest row (making it with the defaults if they never changed a setting), checks once more that the digest is on and
 * its window is open, and moves the watermark to now. Null when somebody else got there first or the person switched it off in the meantime. The key
 * for the unsubscribe link comes back with it. Mailing happens after this commits; if the mail fails the watermark is put back (`release`).
 */
async function takeClaim(tx: PluginTx, c: Candidate, items: DigestItem[]): Promise<Claim | null> {
  await tx.query('INSERT INTO app.notification_digest (person_id, workspace_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT (person_id) DO NOTHING', [c.personId, c.workspaceId]);
  const row = (
    await tx.query<{ enabled: boolean; window_open: boolean; last_digest_at: Date | null; unsubscribe_key: string }>(
      `SELECT enabled, last_digest_at, unsubscribe_key,
              (last_digest_at IS NULL OR last_digest_at <= now() - make_interval(mins => delay_minutes)) AS window_open
         FROM app.notification_digest WHERE person_id = $1::uuid FOR UPDATE`,
      [c.personId],
    )
  ).rows[0];
  if (!row || !row.enabled || !row.window_open) return null;
  // The watermark is the database's own time (to the millisecond, so it survives a round trip through JavaScript unchanged): the clock that stamps notifications and
  // heartbeats, so "arrived after the last digest" and "a delay since the last digest" compare like with like.
  const moved = (await tx.query<{ last_digest_at: Date }>(
      "UPDATE app.notification_digest SET last_digest_at = date_trunc('milliseconds', now()) WHERE person_id = $1::uuid RETURNING last_digest_at",
      [c.personId],
    )
  ).rows[0]!;
  return { candidate: c, key: row.unsubscribe_key, previous: row.last_digest_at, claimedAt: moved.last_digest_at, items };
}

/** Puts the watermark back after a mail that could not be handed to the mailer, so the next run tries again. Only if nobody has moved it since. */
async function release(tx: PluginTx, c: Claim): Promise<void> {
  await tx.query('UPDATE app.notification_digest SET last_digest_at = $3::timestamptz WHERE person_id = $1::uuid AND last_digest_at = $2::timestamptz', [
    c.candidate.personId,
    c.claimedAt,
    c.previous,
  ]);
}

/** What the digest job needs from the job it runs in: its logger. (Its transactions are the plugin's own, scoped to one workspace at a time.) */
export interface DigestJobLike {
  log: PluginLogger;
}

export interface DigestRunResult {
  sent: number;
  failed: number;
}

/**
 * One run of the digest job, workspace by workspace (the audience of a channel is answered for one workspace at a time, so every transaction is scoped
 * to it). For each person who is away (no heartbeat for their delay), is not in Do not disturb right now, and has unread items the settings still allow:
 * claim the digest (a transaction of its own), hand ONE mail to the mailer (no transaction open: a mail server can be slow), then write
 * `notifications.digest.sent`. The claim moves the watermark first, so a crash or a second run cannot send the same digest twice; a mail that fails (or
 * takes too long) puts the watermark back. Every workspace and every person is isolated: an error is logged without addresses or text and the run goes on
 * with the next one, so one bad row never loses another person's digest.
 *
 * Nothing is sent, and no watermark moves, when the server has no mail server set up, when the presence plugin is absent, or while the heartbeat data is
 * younger than five minutes (a fresh install or a database crash empties it, and until the open tabs have beaten again everybody would look away).
 */
export async function runDigestJob(ctx: PluginContext, job: DigestJobLike): Promise<DigestRunResult> {
  const now = ctx.runtime.now();
  const state = stateOf(ctx);
  const presence = ctx.providers.get<PresenceProvider>('presence');
  const result: DigestRunResult = { sent: 0, failed: 0 };
  // Without the presence plugin nobody can be known to be away: send nothing rather than mail people who are at their desk.
  if (!presence) return result;
  // The unconfigured mailer resolves without sending: claiming and writing "sent" rows for it would swallow the digests for good.
  if (!ctx.mail.configured) {
    if (!state.noMailLogged) {
      state.noMailLogged = true;
      job.log.info('notifications: no mail server is set up (MANYTHREADS_SMTP_URL), so email digests are not sent');
    }
    return result;
  }
  state.noMailLogged = false;
  const warmSince = await ctx.db.system((tx) => presence.warmSince(tx));
  if (now.getTime() - warmSince.getTime() < WARMUP_MS) {
    if (!state.warmLogged) {
      state.warmLogged = true;
      job.log.info('notifications: the heartbeat data is new (a fresh start or a database restart), so email digests wait a few minutes');
    }
    return result;
  }
  state.warmLogged = false;

  const workspaces = await ctx.db.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id')).rows.map((r) => r.id));
  for (const workspaceId of workspaces) {
    try {
      await runWorkspace(ctx, job, presence, workspaceId, now, result, state);
    } catch (err) {
      result.failed += 1;
      job.log.warn(`notifications: the email digest of one workspace failed (${errorLabel(err)}); the others go on`);
    }
  }
  return result;
}

interface Ready {
  candidate: Candidate;
  items: DigestItem[];
}

async function runWorkspace(ctx: PluginContext, job: DigestJobLike, presence: PresenceProvider, workspaceId: string, now: Date, result: DigestRunResult, state: RunState): Promise<void> {
  const scope = { workspaceId };
  const seen = await ctx.db.system((tx) => presence.seenSince(tx, new Date(now.getTime() - MAX_DELAY_MS), workspaceId), scope);
  const audience: AudienceCache = new Map();
  // A run that stopped at its cap leaves the id it got to; this one carries on after it, and wraps round to the start when it reaches the end.
  let after: string | null = state.cursors.get(workspaceId) ?? null;
  for (let round = 0; round < digestTuning.maxRounds; round++) {
    const batch: { ready: Ready[]; last: string | null; more: boolean } = await ctx.db.system(
      async (tx) => {
        const found = await candidatesAfter(tx, now, after, workspaceId, seen);
        if (found.length === 0) return { ready: [], last: null, more: false };
        // Asked again, after the list was cut: a person who came back since the heartbeats were listed is not away any more.
        const latest = await presence.lastSeen(tx, found.map((c) => c.personId));
        const away = found.filter((c) => {
          const at = latest.get(c.personId);
          return at === undefined || at.getTime() <= now.getTime() - c.delayMinutes * 60_000;
        });
        const quiet = await quietPeople(tx, away.map((c) => c.personId), now);
        const awake = away.filter((c) => !quiet.has(c.personId));
        const items = await itemsFor(tx, awake, now, audience);
        const ready = awake.flatMap((c) => ((items.get(c.personId)?.length ?? 0) > 0 ? [{ candidate: c, items: items.get(c.personId)! }] : []));
        return { ready, last: found[found.length - 1]?.personId ?? null, more: found.length === digestTuning.batch };
      },
      scope,
    );

    // Remembered before anyone is mailed: if this run dies half way, the next one does not start with the same people.
    if (batch.more && batch.last !== null) state.cursors.set(workspaceId, batch.last);
    else state.cursors.delete(workspaceId);
    for (const r of batch.ready) await deliver(ctx, job, r, result);
    if (!batch.more || batch.last === null) return;
    after = batch.last;
  }
}

/**
 * One person's digest from claim to record, with every step isolated: nothing thrown here reaches the other people of the run. An error before the mail
 * is handed over puts the watermark back (the next run tries again); once the mailer has accepted it, nothing is put back, because the mail is out (a
 * failed audit row is logged, never turned into a second mail).
 */
async function deliver(ctx: PluginContext, job: DigestJobLike, ready: Ready, result: DigestRunResult): Promise<void> {
  const c = ready.candidate;
  const scope = { workspaceId: c.workspaceId };
  let claimed: Claim | null;
  try {
    claimed = await ctx.db.system((tx) => takeClaim(tx, c, ready.items), scope);
  } catch (err) {
    result.failed += 1;
    job.log.warn(`notifications: an email digest could not be prepared (${errorLabel(err)}); it will be tried again`);
    return;
  }
  if (!claimed) return;
  const claim = claimed;

  const plan = planDigest(claim.items);
  try {
    const publicUrl = ctx.runtime.publicUrl;
    const token = signDigestToken(c.personId, claim.key);
    await withTimeout(
      ctx.mail.send({
        template: 'digest',
        to: c.email,
        name: c.name,
        groups: mailGroups(plan, publicUrl),
        more: plan.more,
        openUrl: `${publicUrl}/`,
        unsubscribeUrl: `${publicUrl}/api/notifications/digest/unsubscribe/${token}`,
        settingsUrl: `${publicUrl}/account#${ACCOUNT_ANCHOR}`,
        delayMinutes: c.delayMinutes,
      }),
      digestTuning.sendTimeoutMs,
    );
  } catch (err) {
    // Not logged with the address or the text: only that one digest could not be handed over.
    result.failed += 1;
    job.log.warn(`notifications: an email digest could not be sent (${errorLabel(err)}); it will be tried again`);
    try {
      await ctx.db.system((tx) => release(tx, claim), scope);
    } catch (releaseErr) {
      job.log.warn(`notifications: an email digest could not be put back (${errorLabel(releaseErr)}); that person waits for their next window`);
    }
    return;
  }

  result.sent += 1;
  try {
    await ctx.db.system(
      (tx) =>
        ctx.audit.emit(
          tx,
          NotificationsDigestSentEvent.parse({
            type: 'notifications.digest.sent',
            schemaVersion: 1,
            workspaceId: c.workspaceId,
            personId: c.personId,
            itemCount: plan.total,
            shownCount: plan.shown,
            channelCount: plan.groups.length,
          }),
        ),
      scope,
    );
  } catch (err) {
    job.log.warn(`notifications: an email digest was sent but its record could not be written (${errorLabel(err)})`);
  }
}
