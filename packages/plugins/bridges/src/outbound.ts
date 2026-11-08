import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { BRIDGE_MAX_TEXT, BRIDGE_WHATSAPP_WINDOW_HOURS, ChannelMessagePostedEvent, type BridgeProvider } from '@manythreads/shared';
import { z } from 'zod';
import { ACCOUNT_COLUMNS, accountRef, setAccountState, type AccountRow } from './accounts.ts';
import type { BridgeAccountRef } from './adapter.ts';
import { BRIDGE_ADAPTERS } from './adapters/index.ts';
import { BRIDGE_BASES, BridgeSendError, fakeBase } from './door.ts';
import { cut, outboundLine } from './text.ts';

// What leaves (PLAN Bundle D, P16-09, decisions D26 to D29). Three small jobs:
//   * fan-out: a message posted in a channel that is joined to outside chats (or the answer of a bot in a person's direct chat) becomes one `bridge_messages` row per chat, except the chat it came from;
//   * send: one row is sent, with no database transaction open while the chat app is waited for. The `pre_egress` chain (destination `bridge`) judges the text first, then the one outbound door
//     (door.ts) makes the call: three tries with backoff, then dead. A refused token puts the account in `attention`. WhatsApp answers only within 24 hours of the person's last message: later
//     ones wait, and go out when the person writes again;
//   * reply: the bridge's own short answers ("link your account first", "linked") go the same way, so the public door never waits for a chat app.
// The loop guard: a message that came across a bridge (`meta.via`) is never sent back to the chat it came from; the chat is found through the message map. If the map row is not there yet
// (the post and the map row are two steps) the fan-out tries again a little later, and gives up rather than risk sending it back.

export const FANOUT_QUEUE = 'bridges.fanout';
export const SEND_QUEUE = 'bridges.send';
export const REPLY_QUEUE = 'bridges.reply';
export const PURGE_QUEUE = 'bridges.purge';
export const MAX_SEND_ATTEMPTS = 3;
const FANOUT_ATTEMPTS = 5;
const PURGE_CRON = '23 3 * * *';
const KEEP = '30 days';
/** A message that waited for the WhatsApp window is dropped after this long. */
const WAITING_KEEP = '7 days';
const DESTINATION = 'bridge';
const WINDOW_MS = BRIDGE_WHATSAPP_WINDOW_HOURS * 3_600_000;

type InTx = <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;

const FanoutPayload = z.object({ workspaceId: z.string().uuid(), messageId: z.string().uuid() });
const SendPayload = z.object({ workspaceId: z.string().uuid(), accountId: z.string().uuid(), rowId: z.string().uuid() });
const ReplyPayload = z.object({ workspaceId: z.string().uuid(), accountId: z.string().uuid(), chat: z.string().min(1).max(200), text: z.string().min(1).max(1000) });

/** Queues a short answer of the bridge to a chat. In the caller's transaction, so it is sent only if the work around it was kept. */
export async function queueReply(ctx: PluginContext, tx: PluginTx, input: { workspaceId: string; accountId: string; chat: string; text: string }): Promise<void> {
  await ctx.jobs.enqueue(tx, REPLY_QUEUE, { workspaceId: input.workspaceId, accountId: input.accountId, chat: input.chat, text: input.text });
}

/** The person wrote again, so WhatsApp's window is open: what waited goes out now (oldest first, at most 20). */
export async function releaseWaiting(ctx: PluginContext, tx: PluginTx, workspaceId: string, accountId: string, chat: string): Promise<number> {
  const rows = (
    await tx.query<{ id: string }>(
      `UPDATE app.bridge_messages SET status = 'pending', next_attempt_at = now(), updated_at = now()
        WHERE id IN (SELECT id FROM app.bridge_messages WHERE account_id = $1::uuid AND external_chat_id = $2 AND direction = 'out' AND status = 'waiting'
                        AND created_at > now() - interval '${WAITING_KEEP}' ORDER BY id LIMIT 20)
        RETURNING id`,
      [accountId, chat],
    )
  ).rows;
  for (const r of rows.sort((a, b) => a.id.localeCompare(b.id))) await ctx.jobs.enqueue(tx, SEND_QUEUE, { workspaceId, accountId, rowId: r.id }, { dedupeKey: `bridge-send:${r.id}` });
  return rows.length;
}

/** The sentence an account shows when the chat app refused it. */
const ATTENTION = 'The chat app did not accept the token. Put a new one in and turn the app on again.';

/** A send failed for a reason that concerns the account: say so on the account (once), so the admin sees it. */
async function noteFailure(ctx: PluginContext, inTx: InTx, ref: BridgeAccountRef, err: unknown): Promise<void> {
  if (!(err instanceof BridgeSendError) || !err.attention) return;
  await inTx(async (sys) => {
    const was = (await sys.query<{ status: string }>('SELECT status FROM app.bridge_accounts WHERE id = $1::uuid', [ref.id])).rows[0]?.status;
    if (was !== 'on') return;
    await setAccountState(sys, ref.id, { status: 'attention', error: ATTENTION });
    await ctx.audit.emit(sys, { type: 'bridges.account.changed', workspaceId: ref.workspaceId, accountId: ref.id, provider: ref.provider, change: 'switched', status: 'attention', actorId: sys.actor.id, at: ctx.runtime.now().toISOString() });
  });
}

const countOut = (sys: PluginTx, accountId: string): Promise<unknown> =>
  sys.query('UPDATE app.bridge_accounts SET outbound_count = outbound_count + 1, last_outbound_at = now() WHERE id = $1::uuid', [accountId]);

/** The workspace's guard preset and egress allowlist (kept by the model gateway; `standard` and none when it keeps none). */
async function loadEgressSetup(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

/** The host the guard is told about: the service's constant host (the fake's, outside production). */
function hostOf(provider: BridgeProvider): string {
  return new URL(fakeBase(provider) ?? BRIDGE_BASES[provider]).hostname.toLowerCase();
}

// ---- fan-out ------------------------------------------------------------------------------------------------------------------------------------

interface MessageFacts extends Record<string, unknown> {
  id: string;
  channel_id: string;
  body: string;
  deleted: boolean;
  meta: Record<string, unknown> | null;
  private: boolean;
  archived: boolean;
  channel_kind: string;
  author_kind: string;
}

interface Target extends Record<string, unknown> {
  account_id: string;
  external_chat_id: string;
  how: 'link' | 'dm';
}

/** One message to the chats it should reach. Pure of the network. Returns the number of rows queued. */
export async function fanOut(ctx: PluginContext, tx: PluginTx, input: z.infer<typeof FanoutPayload>, attempt: number): Promise<number> {
  const m = (
    await tx.query<MessageFacts>(
      `SELECT m.id, m.channel_id, m.body, (m.deleted_at IS NOT NULL) AS deleted, m.meta, c.private, (c.archived_at IS NOT NULL) AS archived, c.kind AS channel_kind, a.kind AS author_kind
         FROM app.messages m JOIN app.channels c ON c.id = m.channel_id JOIN app.actors a ON a.id = m.author_id
        WHERE m.id = $1::uuid AND m.workspace_id = $2::uuid`,
      [input.messageId, input.workspaceId],
    )
  ).rows[0];
  if (!m || m.deleted || m.body.trim() === '' || (m.meta && 'importedFrom' in m.meta)) return 0;

  const via = m.meta && typeof m.meta['via'] === 'object' && m.meta['via'] !== null ? (m.meta['via'] as { provider?: unknown }).provider : undefined;
  let source: { account: string; chat: string } | null = null;
  if (via !== undefined) {
    const mapped = (await tx.query<{ account_id: string; external_chat_id: string }>("SELECT account_id, external_chat_id FROM app.bridge_messages WHERE message_id = $1::uuid AND direction = 'in' LIMIT 1", [m.id])).rows[0];
    if (!mapped) {
      // the map row is written a moment after the post: try again later; at the last try send nowhere rather than back to where it came from
      if (attempt < FANOUT_ATTEMPTS) throw new Error('bridges: the message map is not written yet');
      return 0;
    }
    source = { account: mapped.account_id, chat: mapped.external_chat_id };
  }

  const targets = (
    await tx.query<Target>(
      `SELECT l.account_id, l.external_chat_id, 'link' AS how FROM app.bridge_links l JOIN app.bridge_accounts x ON x.id = l.account_id
        WHERE l.channel_id = $1::uuid AND x.status = 'on'
       UNION ALL
       SELECT s.account_id, s.external_chat_id, 'dm' AS how FROM app.bridge_dm_sessions s JOIN app.bridge_accounts x ON x.id = s.account_id
        WHERE s.channel_id = $1::uuid AND x.status = 'on'`,
      [m.channel_id],
    )
  ).rows;

  let queued = 0;
  for (const t of targets) {
    if (source && t.account_id === source.account && t.external_chat_id === source.chat) continue;
    // a public, live channel only; and a person's direct chat carries the bot's answers only (their own words came from the chat or are theirs to read on the web)
    if (t.how === 'link' && (m.private || m.archived || m.channel_kind !== 'channel')) continue;
    if (t.how === 'dm' && m.author_kind !== 'bot') continue;
    const row = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.bridge_messages (workspace_id, account_id, direction, status, channel_id, message_id, external_chat_id, next_attempt_at)
         SELECT $1::uuid, $2::uuid, 'out', 'pending', $3::uuid, $4::uuid, $5, now()
          WHERE NOT EXISTS (SELECT 1 FROM app.bridge_messages b WHERE b.direction = 'out' AND b.account_id = $2::uuid AND b.message_id = $4::uuid AND b.external_chat_id = $5)
         RETURNING id`,
        [input.workspaceId, t.account_id, m.channel_id, m.id, t.external_chat_id],
      )
    ).rows[0];
    if (!row) continue;
    await ctx.jobs.enqueue(tx, SEND_QUEUE, { workspaceId: input.workspaceId, accountId: t.account_id, rowId: row.id }, { dedupeKey: `bridge-send:${row.id}` });
    queued++;
  }
  return queued;
}

// ---- send ---------------------------------------------------------------------------------------------------------------------------------------

type Plan = { kind: 'skip' } | { kind: 'send'; ref: BridgeAccountRef; chat: string; text: string };

interface SendRow extends Record<string, unknown> {
  id: string;
  status: string;
  channel_id: string | null;
  message_id: string | null;
  external_chat_id: string | null;
  team_id: string | null;
  body: string | null;
  deleted: boolean | null;
  author_name: string | null;
  author_kind: string | null;
  meta: Record<string, unknown> | null;
  is_link: boolean;
  is_dm: boolean;
  last_inbound_at: Date | null;
}

const settle = (sys: PluginTx, id: string, status: 'dead' | 'waiting' | 'sent', error: string | null, externalId: string | null = null): Promise<unknown> =>
  sys.query(
    `UPDATE app.bridge_messages SET status = $2::text, error = $3, external_message_id = coalesce($4, external_message_id), attempts = least(attempts + CASE WHEN $2::text = 'waiting' THEN 0 ELSE 1 END, 10), updated_at = now() WHERE id = $1::uuid`,
    [id, status, error === null ? null : error.slice(0, 200), externalId === null ? null : externalId.slice(0, 300)],
  );

/** Everything a send depends on, looked at again now, in one short transaction. */
async function planSend(ctx: PluginContext, sys: PluginTx, p: z.infer<typeof SendPayload>): Promise<Plan> {
  const row = (
    await sys.query<SendRow>(
      `SELECT b.id, b.status, b.channel_id, b.message_id, b.external_chat_id, c.team_id, m.body, (m.deleted_at IS NOT NULL) AS deleted,
              CASE WHEN a.kind = 'person' THEN pe.display_name WHEN a.kind = 'bot' THEN coalesce(bo.name, bo.slug) ELSE 'System' END AS author_name, a.kind AS author_kind, m.meta,
              EXISTS (SELECT 1 FROM app.bridge_links l WHERE l.account_id = b.account_id AND l.channel_id = b.channel_id AND l.external_chat_id = b.external_chat_id) AS is_link,
              s.id IS NOT NULL AS is_dm, s.last_inbound_at
         FROM app.bridge_messages b
         LEFT JOIN app.messages m ON m.id = b.message_id
         LEFT JOIN app.channels c ON c.id = b.channel_id
         LEFT JOIN app.actors a ON a.id = m.author_id
         LEFT JOIN app.people pe ON a.kind = 'person' AND pe.id = a.ref_id AND pe.workspace_id = a.workspace_id
         LEFT JOIN app.bots bo ON a.kind = 'bot' AND bo.id = a.ref_id AND bo.workspace_id = a.workspace_id
         LEFT JOIN app.bridge_dm_sessions s ON s.account_id = b.account_id AND s.external_chat_id = b.external_chat_id AND s.channel_id = b.channel_id
        WHERE b.id = $1::uuid AND b.account_id = $2::uuid AND b.direction = 'out' FOR UPDATE OF b`,
      [p.rowId, p.accountId],
    )
  ).rows[0];
  if (!row || row.status !== 'pending' || row.external_chat_id === null) return { kind: 'skip' };
  const acct = (await sys.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM app.bridge_accounts a WHERE a.id = $1::uuid`, [p.accountId])).rows[0];
  if (!acct || acct.status !== 'on') {
    await settle(sys, row.id, 'dead', 'The chat app was off');
    return { kind: 'skip' };
  }
  if (row.body === null || row.deleted === true) {
    await settle(sys, row.id, 'dead', 'The message is gone');
    return { kind: 'skip' };
  }
  if (!row.is_link && !row.is_dm) {
    await settle(sys, row.id, 'dead', 'The chat is not linked any more');
    return { kind: 'skip' };
  }
  // WhatsApp answers only inside 24 hours of the person's last message; a later answer waits for the next one
  if (acct.provider === 'whatsapp' && (row.last_inbound_at === null || ctx.runtime.now().getTime() - row.last_inbound_at.getTime() > WINDOW_MS)) {
    await settle(sys, row.id, 'waiting', 'Waiting for the person to write first');
    return { kind: 'skip' };
  }
  let text = row.is_dm ? cut(row.body, BRIDGE_MAX_TEXT) : outboundLine(row.author_name ?? 'Someone', row.body);
  const files = Array.isArray(row.meta?.['attachments']) ? (row.meta['attachments'] as unknown[]).length : 0;
  if (files > 0) text = cut(`${text}\n[${files} ${files === 1 ? 'file' : 'files'} attached in manythreads]`, BRIDGE_MAX_TEXT);
  if (text.trim() === '') {
    await settle(sys, row.id, 'dead', 'Nothing to send');
    return { kind: 'skip' };
  }
  // the guard chain judges the text and the place before anything leaves; nothing leaves unguarded
  const setup = await loadEgressSetup(sys, p.workspaceId);
  const decision = await ctx.hooks.runPreEgress(sys, {
    destination: DESTINATION,
    workspaceId: p.workspaceId,
    teamId: row.team_id,
    text,
    preset: setup.preset,
    allowlist: setup.allowlist,
    targets: [{ name: acct.provider, host: hostOf(acct.provider), local: false }],
    recorded: false,
  });
  if (decision.hooks === 0 || decision.outcome === 'block' || decision.outcome === 'require_approval') {
    await settle(sys, row.id, 'dead', 'The workspace guard did not let this message go');
    return { kind: 'skip' };
  }
  if (decision.outcome === 'redact') text = cut(decision.text, BRIDGE_MAX_TEXT);
  return { kind: 'send', ref: await accountRef(ctx, sys, acct), chat: row.external_chat_id, text };
}

export async function runSend(ctx: PluginContext, inTx: InTx, p: z.infer<typeof SendPayload>, attempt: number): Promise<'sent' | 'skipped' | 'dead'> {
  const plan = await inTx((sys) => planSend(ctx, sys, p));
  if (plan.kind === 'skip') return 'skipped';
  try {
    const externalId = await BRIDGE_ADAPTERS[plan.ref.provider].send(plan.ref, plan.chat, plan.text);
    await inTx(async (sys) => {
      await settle(sys, p.rowId, 'sent', null, externalId);
      await countOut(sys, p.accountId);
    });
    return 'sent';
  } catch (err) {
    const e = err instanceof BridgeSendError ? err : null;
    const final = !(e?.retry ?? true) || attempt >= MAX_SEND_ATTEMPTS;
    await noteFailure(ctx, inTx, plan.ref, err);
    await inTx(async (sys) => {
      if (final) await settle(sys, p.rowId, 'dead', e?.message ?? 'The message could not be sent');
      else await sys.query('UPDATE app.bridge_messages SET attempts = least(attempts + 1, 10), error = $2, updated_at = now() WHERE id = $1::uuid', [p.rowId, (e?.message ?? 'The message could not be sent').slice(0, 200)]);
    });
    // a try that can pass again is retried by the queue, with backoff
    if (!final) throw new Error(`bridges: send failed (try ${attempt})`);
    return 'dead';
  }
}

// ---- reply --------------------------------------------------------------------------------------------------------------------------------------

export async function runReply(ctx: PluginContext, inTx: InTx, p: z.infer<typeof ReplyPayload>, attempt: number): Promise<void> {
  const ref = await inTx(async (sys) => {
    const acct = (await sys.query<AccountRow>(`SELECT ${ACCOUNT_COLUMNS} FROM app.bridge_accounts a WHERE a.id = $1::uuid`, [p.accountId])).rows[0];
    return acct && acct.status === 'on' ? accountRef(ctx, sys, acct) : null;
  });
  if (!ref) return;
  try {
    await BRIDGE_ADAPTERS[ref.provider].send(ref, p.chat, p.text);
    await inTx((sys) => countOut(sys, p.accountId));
  } catch (err) {
    await noteFailure(ctx, inTx, ref, err);
    if (err instanceof BridgeSendError && err.retry && attempt < MAX_SEND_ATTEMPTS) throw new Error(`bridges: reply failed (try ${attempt})`);
  }
}

// ---- wiring -------------------------------------------------------------------------------------------------------------------------------------

export function registerOutbound(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const e = ChannelMessagePostedEvent.safeParse(raw);
    if (!e.success) return;
    // one indexed look: does anything outside listen to this channel?
    const listening = (
      await tx.query(
        `SELECT 1 FROM app.bridge_links WHERE channel_id = $1::uuid
         UNION ALL SELECT 1 FROM app.bridge_dm_sessions WHERE channel_id = $1::uuid LIMIT 1`,
        [e.data.channelId],
      )
    ).rows.length > 0;
    if (!listening) return;
    await ctx.jobs.enqueue(tx, FANOUT_QUEUE, { workspaceId: e.data.workspaceId, messageId: e.data.messageId }, { dedupeKey: `bridge-fanout:${e.data.messageId}` });
  });

  ctx.jobs.register(
    FANOUT_QUEUE,
    async (payload, tx, job) => {
      await fanOut(ctx, tx, FanoutPayload.parse(payload), job.attempt);
    },
    { concurrency: 2, maxAttempts: FANOUT_ATTEMPTS },
  );

  // `detached`: the chat app is waited for with no transaction open. One send per account at a time keeps a chat's messages in order.
  ctx.jobs.register(
    SEND_QUEUE,
    async (payload, _tx, job) => {
      await runSend(ctx, (fn) => job.transaction(fn), SendPayload.parse(payload), job.attempt);
    },
    { concurrency: 2, maxAttempts: MAX_SEND_ATTEMPTS, detached: true, serialKey: 'accountId' },
  );

  ctx.jobs.register(
    REPLY_QUEUE,
    async (payload, _tx, job) => {
      await runReply(ctx, (fn) => job.transaction(fn), ReplyPayload.parse(payload), job.attempt);
    },
    { concurrency: 2, maxAttempts: MAX_SEND_ATTEMPTS, detached: true, serialKey: 'accountId' },
  );

  // The ledger is ids only and is kept a month; what waited for a WhatsApp window more than a week is let go; expired codes and old counters go too.
  ctx.jobs.register(
    PURGE_QUEUE,
    async (_payload, tx, job) => {
      const dead = await tx.query(`UPDATE app.bridge_messages SET status = 'dead', error = 'The person did not write again in time', updated_at = now() WHERE status = 'waiting' AND created_at < now() - interval '${WAITING_KEEP}' RETURNING id`);
      const old = await tx.query(`DELETE FROM app.bridge_messages WHERE status IN ('received', 'sent', 'dead') AND updated_at < now() - interval '${KEEP}' RETURNING id`);
      const codes = await tx.query(`DELETE FROM app.bridge_link_codes WHERE expires_at < now() - interval '1 day' RETURNING id`);
      const chats = await tx.query(`DELETE FROM app.bridge_unlinked_chats WHERE last_seen_at < now() - interval '${KEEP}' RETURNING account_id`);
      job.log.info(`bridges: ${dead.rows.length} waiting message(s) let go, ${old.rows.length} ledger row(s), ${codes.rows.length} code(s) and ${chats.rows.length} chat counter(s) removed`);
    },
    { cron: PURGE_CRON, maxAttempts: 1 },
  );
}
