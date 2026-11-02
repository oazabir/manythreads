import type { PluginContext, PluginLogger, PluginTx, PresenceProvider } from '@manythreads/sdk';
import { DIGEST_DELAY_DEFAULT, NotificationLevel, NotificationsDigestSentEvent, effectiveLevel, levelAllows } from '@manythreads/shared';
import { ACCOUNT_ANCHOR, mailGroups, planDigest, type DigestItem } from './digest.ts';
import { signDigestToken } from './digest-token.ts';
import { quietPeople } from './hold.ts';
import { workspaceDefaultLevel } from './levels.ts';
import { normalizePrefs, wantsInApp } from './prefs.ts';

/** The email digest job: every minute it finds the people who have been away long enough and still have unread mentions or messages, and mails each one a list. */
export const DIGEST_QUEUE = 'notifications.digest';
export const DIGEST_CRON = '* * * * *';

const KINDS = ['mention', 'reply', 'dm'] as const;
/** People looked at per database round, and rounds per run: a run reaches at most this many people, the next minute takes the rest. */
const BATCH = 200;
const MAX_ROUNDS = 5;
/** Unread items read per person: the mail lists 10 and counts the rest, so a person with thousands costs no more than one with 200. */
const ITEMS_PER_PERSON = 200;
const HOUR = 3_600_000;
/** A person's first digest looks back one day; a later one looks back to the previous digest, but never more than a week. */
const FIRST_LOOKBACK_MS = 24 * HOUR;
const MAX_LOOKBACK_MS = 7 * 24 * HOUR;

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
 * People who might get a digest now, judged by the database alone: active, a verified address that is their primary one, the digest on, the last digest
 * at least their delay ago, nothing held for them by Do not disturb, and an unread mention, reply or direct message since the last digest. Presence and the
 * rest of the rules (away, Do not disturb right now, levels) are applied by the caller, because they are not in this table.
 */
async function candidatesAfter(tx: PluginTx, now: Date, after: string | null, workspaceId: string): Promise<Candidate[]> {
  const res = await tx.query<{ person_id: string; workspace_id: string; display_name: string; primary_email: string; delay_minutes: number; last_digest_at: Date | null }>(
    `SELECT p.id AS person_id, p.workspace_id, p.display_name, p.primary_email, coalesce(d.delay_minutes, $5::int) AS delay_minutes, d.last_digest_at
       FROM (SELECT DISTINCT n.person_id FROM app.notifications n
              WHERE n.read_at IS NULL AND n.held_at IS NULL AND n.kind = ANY ($3::text[]) AND n.created_at > $2::timestamptz - make_interval(secs => $6::double precision)
                AND ($1::uuid IS NULL OR n.person_id > $1::uuid)) u
       JOIN app.people p ON p.id = u.person_id AND p.status = 'active' AND p.workspace_id = $8::uuid
       LEFT JOIN app.notification_digest d ON d.person_id = p.id
      WHERE coalesce(d.enabled, true)
        AND (d.last_digest_at IS NULL OR d.last_digest_at <= now() - make_interval(mins => d.delay_minutes))
        AND EXISTS (SELECT 1 FROM app.person_emails e WHERE e.person_id = p.id AND e.verified_at IS NOT NULL AND lower(e.email) = lower(p.primary_email))
        AND EXISTS (SELECT 1 FROM app.notifications m
                     WHERE m.person_id = p.id AND m.read_at IS NULL AND m.held_at IS NULL AND m.kind = ANY ($3::text[])
                       AND m.created_at > greatest(coalesce(d.last_digest_at, $2::timestamptz - make_interval(secs => $7::double precision)), $2::timestamptz - make_interval(secs => $6::double precision)))
        AND NOT EXISTS (SELECT 1 FROM app.notifications h WHERE h.person_id = p.id AND h.held_at IS NOT NULL)
      ORDER BY p.id
      LIMIT $4`,
    [after, now, [...KINDS], BATCH, DIGEST_DELAY_DEFAULT, MAX_LOOKBACK_MS / 1000, FIRST_LOOKBACK_MS / 1000, workspaceId],
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
  preview: string;
  channel_id: string;
  channel_kind: string;
  channel_name: string;
  ref_id: string;
  thread_root_id: string | null;
  created_at: Date;
};

/**
 * The unread items each person still has a right to see in a mail: unread and not held, newer than their `since`, in a channel they can read now
 * (a private channel or a direct message they have left gives nothing), and still allowed by their settings now (the channel level, a muted channel,
 * the per-kind switch). A digest lists only what would have told the person in the app.
 */
async function itemsFor(tx: PluginTx, candidates: readonly Candidate[], now: Date): Promise<Map<string, DigestItem[]>> {
  const out = new Map<string, DigestItem[]>();
  if (candidates.length === 0) return out;
  const personIds = candidates.map((c) => c.personId);
  const rows = await tx.query<ItemRow>(
    `SELECT x.* FROM unnest($1::uuid[], $2::timestamptz[]) AS w(person_id, since)
       CROSS JOIN LATERAL (
         SELECT n.id, n.person_id, n.kind, n.actor_name, n.preview, n.channel_id, c.kind AS channel_kind, c.name AS channel_name, n.ref_id, n.thread_root_id, n.created_at
           FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id
          WHERE n.person_id = w.person_id AND n.read_at IS NULL AND n.held_at IS NULL AND n.kind = ANY ($3::text[]) AND n.created_at > w.since
            AND EXISTS (SELECT 1 FROM app.channel_audience(c.id) a WHERE a.person_id = n.person_id)
          ORDER BY n.created_at DESC
          LIMIT $4) x`,
    [personIds, candidates.map((c) => sinceOf(c, now)), [...KINDS], ITEMS_PER_PERSON],
  );
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
        preview: r.preview,
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
async function claim(tx: PluginTx, c: Candidate, items: DigestItem[]): Promise<Claim | null> {
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
 * to it). For each person who is away (no heartbeat for their delay, asked of the presence provider), is not in Do not disturb right now, and has unread
 * items the settings still allow: claim the digest (one transaction), hand ONE mail to the mailer (no transaction open: a mail server can be slow), then
 * write `notifications.digest.sent`. The claim moves the watermark first, so a crash or a second run cannot send the same digest twice; a mail that
 * fails puts the watermark back.
 */
export async function runDigestJob(ctx: PluginContext, job: DigestJobLike): Promise<DigestRunResult> {
  const now = ctx.runtime.now();
  const presence = ctx.providers.get<PresenceProvider>('presence');
  const result: DigestRunResult = { sent: 0, failed: 0 };
  // Without the presence plugin nobody can be known to be away: send nothing rather than mail people who are at their desk.
  if (!presence) return result;

  const workspaces = await ctx.db.system(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM app.workspaces ORDER BY id')).rows.map((r) => r.id));
  for (const workspaceId of workspaces) await runWorkspace(ctx, job, presence, workspaceId, now, result);
  return result;
}

async function runWorkspace(ctx: PluginContext, job: DigestJobLike, presence: PresenceProvider, workspaceId: string, now: Date, result: DigestRunResult): Promise<void> {
  let after: string | null = null;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const claims: { claims: Claim[]; last: string | null; more: boolean } = await ctx.db.system(
      async (tx) => {
        const found = await candidatesAfter(tx, now, after, workspaceId);
        if (found.length === 0) return { claims: [], last: null, more: false };
        const seen = await presence.lastSeen(tx, found.map((c) => c.personId));
        const away = found.filter((c) => {
          const at = seen.get(c.personId);
          return at === undefined || at.getTime() <= now.getTime() - c.delayMinutes * 60_000;
        });
        const quiet = await quietPeople(tx, away.map((c) => c.personId), now);
        const awake = away.filter((c) => !quiet.has(c.personId));
        const items = await itemsFor(tx, awake, now);
        const taken: Claim[] = [];
        for (const c of awake) {
          const list = items.get(c.personId) ?? [];
          if (list.length === 0) continue;
          const got = await claim(tx, c, list);
          if (got) taken.push(got);
        }
        return { claims: taken, last: found[found.length - 1]?.personId ?? null, more: found.length === BATCH };
      },
      { workspaceId },
    );

    for (const c of claims.claims) {
      if (await send(ctx, job, c)) result.sent += 1;
      else result.failed += 1;
    }
    if (!claims.more || claims.last === null) break;
    after = claims.last;
  }
}

/** Mails one claimed digest and records it. False when the mailer refused; the watermark is then put back. */
async function send(ctx: PluginContext, job: DigestJobLike, c: Claim): Promise<boolean> {
  const plan = planDigest(c.items);
  const publicUrl = ctx.runtime.publicUrl;
  const token = signDigestToken(c.candidate.personId, c.key);
  try {
    await ctx.mail.send({
      template: 'digest',
      to: c.candidate.email,
      name: c.candidate.name,
      groups: mailGroups(plan, publicUrl),
      more: plan.more,
      openUrl: `${publicUrl}/`,
      unsubscribeUrl: `${publicUrl}/api/notifications/digest/unsubscribe/${token}`,
      settingsUrl: `${publicUrl}/account#${ACCOUNT_ANCHOR}`,
    });
  } catch {
    // Not logged with the address or the text: only that one digest could not be handed over.
    job.log.warn('notifications: an email digest could not be sent; it will be tried again');
    await ctx.db.system((tx) => release(tx, c), { workspaceId: c.candidate.workspaceId });
    return false;
  }
  await ctx.db.system(
    (tx) =>
      ctx.audit.emit(
        tx,
        NotificationsDigestSentEvent.parse({
          type: 'notifications.digest.sent',
          schemaVersion: 1,
          workspaceId: c.candidate.workspaceId,
          personId: c.candidate.personId,
          itemCount: plan.total,
          shownCount: plan.shown,
          channelCount: plan.groups.length,
        }),
      ),
    { workspaceId: c.candidate.workspaceId },
  );
  return true;
}
