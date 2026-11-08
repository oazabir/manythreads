import { HttpError, json, type HttpRequest, type MessageProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { BRIDGE_UNLINKED_REPLY_MINUTES, BridgeDoorParams, BridgeDoorResponse, abuseLimit, bridgeChallengeRoute, bridgeDoorRoute, type BridgeRefusalReason } from '@manythreads/shared';
import { accountRef, loadAccount, type AccountRow } from './accounts.ts';
import type { BridgeAccountRef, BridgeRequest, InboundMessage } from './adapter.ts';
import { BRIDGE_ADAPTERS } from './adapters/index.ts';
import { chooseBot, handleDm, type Linked } from './dm.ts';
import type { IdentityService, Redeemed } from './identity.ts';
import { queueReply } from './outbound.ts';
import { asCode, cleanInbound } from './text.ts';
import { createOncePer } from './util.ts';

// The public door a chat service calls (PLAN Bundle D, P16-09, decisions D24 to D26): `POST /hooks/bridges/:provider/:accountId`, and `GET` for a URL check.
// In this order, and nothing is stored before the step that lets it:
//   1. the account must exist and be on: an unknown id and a switched-off account answer the same 404;
//   2. the adapter verifies the signature or secret header over the RAW body: a failure is 401, nothing stored;
//   3. each message is read. WHO said it is looked up first (the chat user's id against the links people proved with a code): a sender who is not linked is dropped before any text is
//      kept, counted, and answered at most once an hour with "link your account first". The one thing an unlinked chat may do is send a code or `/start`;
//   4. a linked sender's text is cleaned (hostile text: control and direction characters out, 4000 characters, @channel made plain) and posted AS THAT PERSON with `meta.via`, in the channel
//      the chat is joined to, or in their conversation with a bot (dm.ts); a command is answered. Mentions in the text work as they do for the person on the web, with their rights only.
// The update id is claimed in `bridge_messages` first, so a service that sends an update twice gets it handled once; if the work then fails for the system's own reason the claim is undone and
// the service's retry does it again. Answers to the chat go through the reply job, so this door never waits for a chat app.

const NOT_FOUND = (): HttpError => new HttpError(404, 'not_found', 'Not found');
const MAX_BODY_BYTES = 1_000_000;
const MAX_MESSAGES = 100;

const TEXT = {
  startUnlinked: 'Hello. To use manythreads here, link your account: open Account, then Chat apps in manythreads, ask for a code and send it to me in this chat.',
  startLinked: 'You are linked. Write a message to talk to a bot, or send /bot to choose one. Send /unlink to remove the link.',
  unlinkedPrivate: 'I do not know you yet. To link your account, open Account, then Chat apps in manythreads, ask for a code and send it to me here.',
  unlinkedGroup: 'I only pass on messages from people who linked their account. Open Account, then Chat apps in manythreads, ask for a code and send it to me in a private chat.',
  wrongCode: 'That code did not work. Check it, or ask for a new one in manythreads.',
  taken: 'This chat account is already linked to someone else. Ask an admin to remove that link first.',
  codeInGroup: 'Send the code to me in a private chat, not in a group.',
  connectInPrivate: 'Send /connect and the code in the group you want to join to a channel.',
  connectNeedsCode: 'Send /connect and the 8 digit code from the channel’s Chat apps tab in manythreads.',
  unlinked: 'Done. Your chat account is no longer linked to manythreads.',
  notLinked: 'This chat account is not linked.',
  privateOnly: 'Send that in a private chat with me.',
  cannotPost: 'You cannot post in that channel.',
  channelGone: 'That channel is not available any more.',
} as const;

/** Reads the body up to `max` bytes; a longer one is refused as soon as the limit is crossed. */
async function readBody(req: HttpRequest, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!req.stream) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.stream) {
    total += chunk.byteLength;
    if (total > max) throw tooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
const tooLarge = (): HttpError => new HttpError(413, 'validation_failed', 'The body is too large', { connection: 'close' });

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

type Step =
  | { kind: 'none' }
  | { kind: 'dropped' }
  | { kind: 'command'; claimId: string; who: Linked | null }
  | { kind: 'code'; claimId: string }
  | { kind: 'group'; claimId: string; who: Linked; channelId: string }
  | { kind: 'dm'; claimId: string; who: Linked };

export function registerInbound(ctx: PluginContext, identity: IdentityService): void {
  const onceAMinute = createOncePer(60_000);
  const pending = new Map<string, number>();
  const now = (): string => ctx.runtime.now().toISOString();

  /** Counts a refusal; one event a minute per account and reason says how many. A failure to write it never changes the answer. */
  const refuse = async (row: Pick<AccountRow, 'id' | 'workspace_id' | 'provider'>, reason: BridgeRefusalReason): Promise<void> => {
    const key = `${row.id}:${reason}`;
    pending.set(key, (pending.get(key) ?? 0) + 1);
    if (!onceAMinute(key)) return;
    const count = pending.get(key) ?? 1;
    pending.delete(key);
    await ctx.db
      .system((sys) => ctx.audit.emit(sys, { type: 'bridges.message.refused', workspaceId: row.workspace_id, accountId: row.id, provider: row.provider, reason, count, at: now() }), { workspaceId: row.workspace_id })
      .catch(() => undefined);
  };

  const reply = (ref: BridgeAccountRef, chat: string, text: string): Promise<void> => ctx.db.system((sys) => queueReply(ctx, sys, { workspaceId: ref.workspaceId, accountId: ref.id, chat, text }), { workspaceId: ref.workspaceId });

  /** The account and, when it is on, its credentials. Unknown and not-on look the same to the caller. */
  async function load(params: unknown): Promise<{ row: AccountRow; ref: BridgeAccountRef | null }> {
    const p = BridgeDoorParams.safeParse(params);
    if (!p.success) throw NOT_FOUND();
    const found = await ctx.db.system(async (sys) => {
      const row = await loadAccount(sys, p.data.provider, p.data.accountId);
      if (!row) return null;
      return { row, ref: row.status === 'on' ? await accountRef(ctx, sys, row) : null };
    });
    if (!found) throw NOT_FOUND();
    if (!found.ref) {
      await refuse(found.row, 'disabled');
      throw NOT_FOUND();
    }
    return found;
  }

  const requestOf = (req: HttpRequest, method: 'GET' | 'POST', rawBody: Uint8Array): BridgeRequest => ({
    method,
    headers: Object.fromEntries(Object.entries(req.headers).flatMap(([k, v]) => (typeof v === 'string' ? [[k.toLowerCase(), v]] : []))),
    query: Object.fromEntries(Object.entries(req.query).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : []))),
    rawBody,
    now: ctx.runtime.now().getTime(),
  });

  /** Who a chat user is: the active person who proved they are theirs, or null. */
  async function findLinked(sys: PluginTx, ref: BridgeAccountRef, externalUserId: string): Promise<Linked | null> {
    const r = (
      await sys.query<{ person_id: string; actor_id: string; display_name: string }>(
        `SELECT i.person_id, a.id AS actor_id, p.display_name
           FROM app.bridge_identities i
           JOIN app.people p ON p.id = i.person_id AND p.workspace_id = i.workspace_id AND p.status = 'active'
           JOIN app.actors a ON a.kind = 'person' AND a.ref_id = i.person_id AND a.workspace_id = i.workspace_id
          WHERE i.account_id = $1::uuid AND i.external_user_id = $2`,
        [ref.id, externalUserId],
      )
    ).rows[0];
    return r ? { personId: r.person_id, actorId: r.actor_id, name: r.display_name } : null;
  }

  /** Step one: look at who it is and what it is, count it, claim its update id. Stores no text. */
  async function classify(sys: PluginTx, ref: BridgeAccountRef, msg: InboundMessage, updateId: string, chat: string, sender: string): Promise<Step> {
    const who = await findLinked(sys, ref, sender);
    const cmd = msg.command;
    const isGroup = msg.chat.kind === 'group';
    const bare = cmd === null && !isGroup && who === null ? asCode(msg.text) : null;
    const link = isGroup ? (await sys.query<{ channel_id: string }>('SELECT channel_id FROM app.bridge_links WHERE account_id = $1::uuid AND external_chat_id = $2', [ref.id, chat])).rows[0] ?? null : null;

    const claim = async (channelId: string | null): Promise<string | null> => {
      const id = (
        await sys.query<{ id: string }>(
          `INSERT INTO app.bridge_messages (workspace_id, account_id, direction, provider_update_id, status, channel_id, external_chat_id, external_message_id)
           VALUES ($1::uuid, $2::uuid, 'in', $3, 'received', $4::uuid, $5, $6)
           ON CONFLICT (account_id, provider_update_id) WHERE direction = 'in' DO NOTHING RETURNING id`,
          [ref.workspaceId, ref.id, updateId, channelId, chat, msg.externalId === null ? null : msg.externalId.slice(0, 300)],
        )
      ).rows[0]?.id;
      if (id === undefined) return null;
      await sys.query('UPDATE app.bridge_accounts SET inbound_count = inbound_count + 1, last_inbound_at = now() WHERE id = $1::uuid', [ref.id]);
      return id;
    };

    if (cmd !== null && (who !== null || cmd.name === 'start' || cmd.name === 'connect')) {
      const claimId = await claim(null);
      return claimId === null ? { kind: 'none' } : { kind: 'command', claimId, who };
    }
    if (bare !== null) {
      const claimId = await claim(null);
      return claimId === null ? { kind: 'none' } : { kind: 'code', claimId };
    }
    if (who === null) {
      // not linked: nothing of the text is kept. An unknown group that is not joined to a channel is not ours to answer.
      if (isGroup && link === null) return { kind: 'none' };
      const due = (
        await sys.query<{ due: boolean }>(
          `INSERT INTO app.bridge_unlinked_chats AS u (account_id, workspace_id, external_chat_id, last_replied_at) VALUES ($1::uuid, $2::uuid, $3, now())
           ON CONFLICT (account_id, external_chat_id) DO UPDATE SET dropped_count = u.dropped_count + 1, last_seen_at = now(),
             last_replied_at = CASE WHEN u.last_replied_at IS NULL OR u.last_replied_at < now() - interval '${BRIDGE_UNLINKED_REPLY_MINUTES} minutes' THEN now() ELSE u.last_replied_at END
           RETURNING (u.last_replied_at = now()) AS due`,
          [ref.id, ref.workspaceId, chat],
        )
      ).rows[0]?.due;
      await sys.query('UPDATE app.bridge_accounts SET dropped_count = dropped_count + 1 WHERE id = $1::uuid', [ref.id]);
      if (due === true) await queueReply(ctx, sys, { workspaceId: ref.workspaceId, accountId: ref.id, chat, text: isGroup ? TEXT.unlinkedGroup : TEXT.unlinkedPrivate });
      return { kind: 'dropped' };
    }
    if (!isGroup) {
      const claimId = await claim(null);
      return claimId === null ? { kind: 'none' } : { kind: 'dm', claimId, who };
    }
    if (link !== null) {
      const claimId = await claim(link.channel_id);
      return claimId === null ? { kind: 'none' } : { kind: 'group', claimId, who, channelId: link.channel_id };
    }
    return { kind: 'none' };
  }

  /** What to say back to a code redemption. */
  const sayRedeemed = <T>(r: Redeemed<T>, ok: (v: T) => string): string => {
    switch (r.kind) {
      case 'ok':
        return ok(r.value);
      case 'wrong':
        return TEXT.wrongCode;
      case 'taken':
        return TEXT.taken;
      case 'locked':
        return `Too many wrong codes. Try again in ${r.minutes} minute${r.minutes === 1 ? '' : 's'}.`;
    }
  };

  async function linkIdentity(ref: BridgeAccountRef, msg: InboundMessage, code: string): Promise<string> {
    if (msg.chat.kind !== 'private') return TEXT.codeInGroup;
    const r = await identity.redeemIdentity(ref, msg.chat.id, msg.sender.id, msg.sender.label, code);
    return sayRedeemed(r, (v) => `Linked. You are connected as ${v.name}. Write a message to talk to a bot, or send /bot to choose one.`);
  }

  async function command(ref: BridgeAccountRef, msg: InboundMessage, who: Linked | null): Promise<string | null> {
    const cmd = msg.command!;
    switch (cmd.name) {
      case 'start': {
        const code = asCode(cmd.argument);
        if (code !== null) return linkIdentity(ref, msg, code);
        return who ? TEXT.startLinked : TEXT.startUnlinked;
      }
      case 'connect': {
        if (msg.chat.kind !== 'group') return TEXT.connectInPrivate;
        const code = asCode(cmd.argument);
        if (code === null) return TEXT.connectNeedsCode;
        const r = await identity.redeemChannel(ref, msg.chat.id, msg.chat.title, code);
        return sayRedeemed(r, (v) => `This chat is now joined to #${v.channelName} in manythreads. Messages here from people who linked their account are posted there, and the channel’s messages show up here.`);
      }
      case 'unlink': {
        if (msg.chat.kind !== 'private') return TEXT.privateOnly;
        if (!who) return TEXT.notLinked;
        return (await identity.unlinkFromChat(ref, who.personId)) ? TEXT.unlinked : TEXT.notLinked;
      }
      case 'bot': {
        if (msg.chat.kind !== 'private') return TEXT.privateOnly;
        if (!who) return TEXT.unlinkedPrivate;
        return chooseBot(ctx, ref, who, msg.chat.id, cmd.argument);
      }
    }
  }

  /** A linked person's words in a joined group: posted as them in the channel. Answers a sentence when it could not be. */
  async function postToChannel(ref: BridgeAccountRef, who: Linked, channelId: string, text: string, claimId: string): Promise<string | null> {
    const body = cleanInbound(text);
    if (body === '') return null;
    const messages = ctx.providers.get<MessageProvider>('messages');
    if (!messages) throw new Error('bridges: the message door is not loaded');
    let posted: { id: string };
    try {
      posted = await ctx.db.as({ actorId: who.actorId, kind: 'person', workspaceId: ref.workspaceId, personId: who.personId, sessionId: null }, (tx) =>
        messages.post(tx, { channelId, body, meta: { via: { provider: ref.provider } } }),
      );
    } catch (err) {
      const status = statusOf(err);
      if (status === 403) return TEXT.cannotPost;
      if (status !== undefined && status < 500) return TEXT.channelGone;
      throw err;
    }
    await ctx.db.system((sys) => sys.query('UPDATE app.bridge_messages SET message_id = $2::uuid WHERE id = $1::uuid', [claimId, posted.id]), { workspaceId: ref.workspaceId });
    return null;
  }

  async function handleMessage(row: AccountRow, ref: BridgeAccountRef, msg: InboundMessage): Promise<void> {
    const chat = msg.chat.id.slice(0, 200);
    const sender = msg.sender.id.slice(0, 200);
    const updateId = msg.updateId.slice(0, 300);
    const step = await ctx.db.system((sys) => classify(sys, ref, msg, updateId, chat, sender), { workspaceId: ref.workspaceId });
    if (step.kind === 'none') return;
    if (step.kind === 'dropped') {
      await refuse(row, 'unverified');
      return;
    }
    let said: string | null = null;
    try {
      switch (step.kind) {
        case 'command':
          said = await command(ref, msg, step.who);
          break;
        case 'code':
          said = await linkIdentity(ref, msg, asCode(msg.text) ?? '');
          break;
        case 'group':
          said = await postToChannel(ref, step.who, step.channelId, msg.text, step.claimId);
          break;
        case 'dm':
          said = await handleDm(ctx, ref, step.who, chat, msg.text, step.claimId);
          break;
      }
    } catch (err) {
      // the system's own failure: undo the claim so the chat app's retry is handled, and let it see the failure
      await ctx.db.system((sys) => sys.query("DELETE FROM app.bridge_messages WHERE id = $1::uuid AND direction = 'in'", [step.claimId]), { workspaceId: ref.workspaceId }).catch(() => undefined);
      throw err;
    }
    if (said !== null) await reply(ref, chat, said);
  }

  ctx.http.route({
    method: bridgeDoorRoute.method,
    path: bridgeDoorRoute.path,
    public: true,
    // csrf is for cookie sessions; a chat service's call carries none
    csrfExempt: true,
    rawBody: true,
    rateLimit: abuseLimit(bridgeDoorRoute.method, bridgeDoorRoute.path),
    rateLimitBy: 'address',
    handler: async (req) => {
      const { row, ref } = await load(req.params);
      if (!ref) throw NOT_FOUND();
      const raw = await readBody(req, MAX_BODY_BYTES);
      const adapter = BRIDGE_ADAPTERS[ref.provider];
      const verdict = adapter.verify(ref, requestOf(req, 'POST', raw));
      if (!verdict.ok) {
        await refuse(row, 'bad_signature');
        throw new HttpError(401, 'unauthenticated', 'The call is not signed by the chat app');
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'validation_failed', 'The body is not JSON');
      }
      for (const msg of adapter.parse(ref, body).slice(0, MAX_MESSAGES)) await handleMessage(row, ref, msg);
      return json(BridgeDoorResponse.parse({ ok: true }));
    },
  });

  // A URL check by GET (WhatsApp's verification): the answer is the plain challenge, only for a valid check.
  ctx.http.route({
    method: bridgeChallengeRoute.method,
    path: bridgeChallengeRoute.path,
    public: true,
    csrfExempt: true,
    rateLimit: abuseLimit(bridgeChallengeRoute.method, bridgeChallengeRoute.path),
    rateLimitBy: 'address',
    handler: async (req) => {
      const { ref } = await load(req.params);
      if (!ref) throw NOT_FOUND();
      const adapter = BRIDGE_ADAPTERS[ref.provider];
      const answer = adapter.challenge ? adapter.challenge(ref, requestOf(req, 'GET', new Uint8Array())) : null;
      if (answer === null) throw new HttpError(403, 'forbidden', 'That check is not valid');
      return { status: 200, body: answer, headers: { 'content-type': 'text/plain; charset=utf-8' } };
    },
  });
}
