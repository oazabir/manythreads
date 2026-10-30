import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { PushPayload } from '@manythreads/shared';
import { quietPeople } from './hold.ts';
import { isAllowedPushEndpoint, loadVapid, sendPush, type PushOutcome, type VapidKeys } from './webpush.ts';

/** The job that sends the browser push of one notification (outside the transaction that made it: a push service can be slow). */
export const PUSH_QUEUE = 'notifications.push';

/** What the push says when the text of the message must not leave the site (private channels and direct messages). */
export const PRIVATE_BODY = 'Open manythreads to read it.';
const BODY_MAX = 120;
const TITLE_MAX = 160;

/** What a notification is, as far as its push is concerned. */
export interface PushFacts {
  notificationId: string;
  kind: 'mention' | 'reply' | 'dm' | 'message' | 'reminder';
  keyword: string | null;
  actorName: string;
  preview: string;
  channelId: string;
  channelKind: string;
  channelName: string;
  channelPrivate: boolean;
  messageId: string;
  threadRootId: string | null;
}

const clip = (text: string, max: number): string => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
};

/**
 * The body of a browser push. The title names the channel and the sender. The text of the message goes in only for a channel everyone on the
 * team can read; a private channel or a direct message gets a fixed line instead, because a push passes through the browser maker's push
 * service and shows on a lock screen. (The body is encrypted for the one browser; this is a second guard, not the only one.)
 */
export function buildPushPayload(f: PushFacts): PushPayload {
  const sender = clip(f.actorName, 60) || 'Someone';
  // The channel's name is shown only for a channel everyone on the team can read: a private channel's name is private too, and this line shows on a lock screen.
  const open = f.channelKind === 'channel' && !f.channelPrivate;
  const where = open && f.channelName !== '' ? ` in #${clip(f.channelName.replace(/^#/, ''), 60)}` : '';
  let title: string;
  if (f.kind === 'reminder') title = `Reminder${where}`;
  else if (f.kind === 'dm') title = `${sender} sent you a message`;
  else if (f.kind === 'reply') title = `${sender} replied in a thread${where}`;
  else if (f.kind === 'message') title = where !== '' ? `${sender}${where}` : `${sender} sent you a message`;
  else if (f.keyword !== null) title = `${sender} wrote “${clip(f.keyword, 40)}”${where}`;
  else title = `${sender} mentioned you${where}`;
  const params = new URLSearchParams({ channel: f.channelId, message: f.messageId });
  if (f.threadRootId) params.set('root', f.threadRootId);
  return PushPayload.parse({
    v: 1,
    title: clip(title, TITLE_MAX),
    body: open ? clip(f.preview, BODY_MAX) || PRIVATE_BODY : PRIVATE_BODY,
    tag: `n-${f.notificationId}`,
    url: `/open?${params.toString()}`,
    notificationId: f.notificationId,
  });
}

// Keys ---------------------------------------------------------------------------------------------------------------------------

let cached: { pem: string; subject: string; keys: VapidKeys | null } | null = null;

/**
 * The server's push signing key from the environment (`MANYTHREADS_VAPID_PRIVATE_KEY`, a P-256 key in PEM text; `MANYTHREADS_VAPID_SUBJECT`, a
 * `mailto:` or https address, defaults to the public URL). Null when absent or unusable: push is then reported as unavailable and nothing is sent.
 */
export function vapidFromEnv(env: NodeJS.ProcessEnv, publicUrl: string): VapidKeys | null {
  const pem = env['MANYTHREADS_VAPID_PRIVATE_KEY'] ?? '';
  const subject = (env['MANYTHREADS_VAPID_SUBJECT'] ?? '').trim() || publicUrl;
  if (cached && cached.pem === pem && cached.subject === subject) return cached.keys;
  const keys = loadVapid(pem, subject);
  cached = { pem, subject, keys };
  return keys;
}

/** Extra push-service host suffixes an operator allows (`MANYTHREADS_PUSH_HOSTS`, comma separated). */
export const extraPushHosts = (env: NodeJS.ProcessEnv): string[] => (env['MANYTHREADS_PUSH_HOSTS'] ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '');

// The job -----------------------------------------------------------------------------------------------------------------------

interface JobLike {
  log: { info(m: string): void; warn(m: string): void };
  transaction<T>(fn: (tx: PluginTx) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SUBSCRIPTIONS = 10;
const GIVE_UP_AFTER = 5;

interface Loaded {
  facts: PushFacts;
  subs: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>;
}

async function load(tx: PluginTx, personId: string, notificationId: string, now: Date): Promise<Loaded | null> {
  const n = await tx.query<{
    id: string; kind: PushFacts['kind']; keyword: string | null; actor_name: string; preview: string; channel_id: string; channel_kind: string;
    channel_name: string; channel_private: boolean; ref_id: string; thread_root_id: string | null; held_at: Date | null; read_at: Date | null; can_read: boolean;
  }>(
    `SELECT n.id, n.kind, n.keyword, n.actor_name, n.preview, n.channel_id, c.kind AS channel_kind, c.name AS channel_name, c.private AS channel_private,
            n.ref_id, n.thread_root_id, n.held_at, n.read_at,
            EXISTS (SELECT 1 FROM app.channel_audience(c.id) a WHERE a.person_id = n.person_id) AS can_read
       FROM app.notifications n JOIN app.channels c ON c.id = n.channel_id
      WHERE n.id = $1::uuid AND n.person_id = $2::uuid`,
    [notificationId, personId],
  );
  const r = n.rows[0];
  // Gone (the message was deleted), already read in another tab, still held, or the person can no longer read the channel: nothing to push.
  if (!r || r.held_at !== null || r.read_at !== null || !r.can_read) return null;
  // Do not disturb may have started since the notification was made.
  if ((await quietPeople(tx, [personId], now)).has(personId)) return null;
  const subs = await tx.query<{ id: string; endpoint: string; p256dh: string; auth: string }>(
    'SELECT id, endpoint, p256dh, auth FROM app.push_subscriptions WHERE person_id = $1::uuid AND failures < $2 ORDER BY created_at DESC LIMIT $3',
    [personId, GIVE_UP_AFTER, MAX_SUBSCRIPTIONS],
  );
  if (subs.rows.length === 0) return null;
  return {
    facts: {
      notificationId: r.id,
      kind: r.kind,
      keyword: r.keyword,
      actorName: r.actor_name,
      preview: r.preview,
      channelId: r.channel_id,
      channelKind: r.channel_kind,
      channelName: r.channel_name,
      channelPrivate: r.channel_private,
      messageId: r.ref_id,
      threadRootId: r.thread_root_id,
    },
    subs: subs.rows,
  };
}

export interface PushDeps {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * Sends the push of one notification to every browser its person signed up. A browser the push service reports gone (404, 410) is removed; one
 * that keeps failing is left alone after five failures in a row. When every send failed for a reason that may pass (service down, timeout) the
 * job fails so the queue tries again later.
 */
export async function runPushJob(ctx: PluginContext, payload: Record<string, unknown>, job: JobLike, deps: PushDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const { workspaceId, notificationId, personId } = payload;
  if (typeof workspaceId !== 'string' || typeof notificationId !== 'string' || typeof personId !== 'string' || !UUID.test(notificationId) || !UUID.test(personId)) {
    job.log.warn('notifications: a push job with a payload it cannot read was dropped');
    return;
  }
  const keys = vapidFromEnv(env, ctx.runtime.publicUrl);
  if (!keys) return;
  const now = ctx.runtime.now();
  const loaded = await job.transaction((tx) => load(tx, personId, notificationId, now));
  if (!loaded) return;
  const body = Buffer.from(JSON.stringify(buildPushPayload(loaded.facts)));
  const hosts = extraPushHosts(env);
  const outcomes: Array<{ id: string; outcome: PushOutcome }> = [];
  for (const sub of loaded.subs) {
    if (!isAllowedPushEndpoint(sub.endpoint, hosts)) {
      outcomes.push({ id: sub.id, outcome: { result: 'gone', status: 0 } });
      continue;
    }
    outcomes.push({ id: sub.id, outcome: await sendPush(keys, sub, body, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}), now }) });
  }
  await job.transaction(async (tx) => {
    const sent = outcomes.filter((o) => o.outcome.result === 'sent').map((o) => o.id);
    const gone = outcomes.filter((o) => o.outcome.result === 'gone').map((o) => o.id);
    const failed = outcomes.filter((o) => o.outcome.result === 'rejected').map((o) => o.id);
    if (sent.length > 0) await tx.query('UPDATE app.push_subscriptions SET last_sent_at = now(), failures = 0 WHERE id = ANY ($1::uuid[])', [sent]);
    if (gone.length > 0) await tx.query('DELETE FROM app.push_subscriptions WHERE id = ANY ($1::uuid[])', [gone]);
    if (failed.length > 0) await tx.query('UPDATE app.push_subscriptions SET failures = failures + 1 WHERE id = ANY ($1::uuid[])', [failed]);
  });
  const sentCount = outcomes.filter((o) => o.outcome.result === 'sent').length;
  job.log.info(`notifications: push ${sentCount}/${outcomes.length} sent`);
  if (sentCount === 0 && outcomes.some((o) => o.outcome.result === 'retry')) throw new Error('notifications: the push service could not be reached');
}
