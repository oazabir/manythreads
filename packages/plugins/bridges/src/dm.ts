import type { HttpCaller, MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import type { BridgeAccountRef } from './adapter.ts';
import { releaseWaiting } from './outbound.ts';
import { cleanInbound, cleanLabel } from './text.ts';
import { pgCode } from './util.ts';

// A linked person's direct chat with a bot (PLAN Bundle D, P16-09, decision D28). The first private message makes a session (`bridge_dm_sessions`) tied to the person's conversation channel with
// the chosen bot (the workspace Brain unless they chose another with `/bot <name>`), opened through the same door as the web ("Talk to"), so the same rules apply: the person must be on the
// bot's team, the bot must be active. What the person writes is posted in that channel AS THEM with `meta.via`; the bot answers there as it always does, and the fan-out sends the answer back.
// A message sent within an hour of the last one in the conversation continues its thread, so the bot sees the exchange; a later one starts a new one.

/** A person who proved a chat user is theirs. */
export interface Linked {
  personId: string;
  actorId: string;
  name: string;
}

const THREAD_MINUTES = 60;

const callerOf = (workspaceId: string, who: Linked): HttpCaller => ({ actorId: who.actorId, kind: 'person', workspaceId, personId: who.personId, sessionId: null });

interface BotChoice extends Record<string, unknown> {
  id: string;
  name: string;
  slug: string;
  scope: string;
}

/** The bots the person can talk to: active, with a conversation trigger, in their reach (row-level security says which). The workspace Brain first. */
async function listBots(tx: PluginTx): Promise<BotChoice[]> {
  return (
    await tx.query<BotChoice>(
      `SELECT id, name, slug, scope FROM app.bots
        WHERE status = 'active' AND jsonb_path_exists(triggers, '$[*] ? (@.type == "conversation")')
        ORDER BY (scope = 'workspace') DESC, (slug = 'brain') DESC, name LIMIT 30`,
    )
  ).rows;
}

/** The plain sentence of a database refusal that was written to be read (the conversation door's), else null. */
function sentenceOf(err: unknown): string | null {
  const code = pgCode(err);
  if ((code === '42501' || code === '23514' || code === '22023') && err instanceof Error && err.message.length <= 200) {
    return code === '22023' ? 'That bot is not available.' : err.message.replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/[^.!?]$/, '$&.');
  }
  return null;
}

const statusOf = (err: unknown): number | undefined => {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};

async function saveSession(ctx: PluginContext, ref: BridgeAccountRef, who: Linked, chat: string, botId: string, channelId: string): Promise<void> {
  await ctx.db.system(
    async (sys) => {
      await sys.query(
        `INSERT INTO app.bridge_dm_sessions (workspace_id, account_id, person_id, external_chat_id, bot_id, channel_id, last_inbound_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, now())
         ON CONFLICT (account_id, person_id) DO UPDATE SET external_chat_id = EXCLUDED.external_chat_id, bot_id = EXCLUDED.bot_id, channel_id = EXCLUDED.channel_id, last_inbound_at = now(), updated_at = now()`,
        [ref.workspaceId, ref.id, who.personId, chat, botId, channelId],
      );
      // the person wrote, so WhatsApp's window is open again: what waited goes out
      await releaseWaiting(ctx, sys, ref.workspaceId, ref.id, chat);
    },
    { workspaceId: ref.workspaceId },
  );
}

/**
 * A private message from a linked person: posted as them in their conversation with the bot. Answers the sentence to send back when it could not be done (the person is told why), or null.
 * A failure that is the system's (not the person's) is thrown, so the caller can undo its claim and the chat app delivers the update again.
 */
export async function handleDm(ctx: PluginContext, ref: BridgeAccountRef, who: Linked, chat: string, text: string, claimId: string): Promise<string | null> {
  const body = cleanInbound(text);
  if (body === '') return null;
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) throw new Error('bridges: the message door is not loaded');
  const caller = callerOf(ref.workspaceId, who);

  const session = (await ctx.db.system((sys) => sys.query<{ bot_id: string }>('SELECT bot_id FROM app.bridge_dm_sessions WHERE account_id = $1::uuid AND person_id = $2::uuid', [ref.id, who.personId]), { workspaceId: ref.workspaceId })).rows[0];

  let opened: { botId: string; channelId: string; threadRootId: string | null } | { reply: string };
  try {
    opened = await ctx.db.as(caller, async (tx) => {
      let botId = session?.bot_id;
      if (!botId) {
        const first = (await listBots(tx))[0];
        if (!first) return { reply: 'There is no bot you can talk to yet. Ask an admin to set one up.' };
        botId = first.id;
      }
      const channelId = (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [botId])).rows[0]!.channel_id;
      const last = (
        await tx.query<{ id: string; thread_root_id: string | null; fresh: boolean }>(
          `SELECT id, thread_root_id, (created_at > now() - interval '${THREAD_MINUTES} minutes') AS fresh FROM app.messages WHERE channel_id = $1::uuid AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
          [channelId],
        )
      ).rows[0];
      return { botId, channelId, threadRootId: last?.fresh ? (last.thread_root_id ?? last.id) : null };
    });
  } catch (err) {
    const sentence = sentenceOf(err);
    if (sentence !== null) return sentence;
    throw err;
  }
  if ('reply' in opened) return opened.reply;

  await saveSession(ctx, ref, who, chat, opened.botId, opened.channelId);

  const post = (threadRootId: string | null): Promise<{ id: string }> =>
    ctx.db.as(caller, (tx) => messages.post(tx, { channelId: opened.channelId, body, threadRootId, meta: { via: { provider: ref.provider } } }));
  let posted: { id: string };
  try {
    try {
      posted = await post(opened.threadRootId);
    } catch (err) {
      // the thread's root went away meanwhile: a fresh conversation
      if (opened.threadRootId !== null && statusOf(err) === 409) posted = await post(null);
      else throw err;
    }
  } catch (err) {
    const status = statusOf(err);
    if (status === 403) return 'You cannot write to this bot right now.';
    if (status !== undefined && status < 500) return 'That message could not be sent to the bot.';
    throw err;
  }
  await ctx.db.system((sys) => sys.query('UPDATE app.bridge_messages SET message_id = $2::uuid, channel_id = $3::uuid WHERE id = $1::uuid', [claimId, posted.id, opened.channelId]), { workspaceId: ref.workspaceId });
  return null;
}

/** `/bot` and `/bot <name>`: which bot the person's private chat talks to. Answers the sentence to send back. */
export async function chooseBot(ctx: PluginContext, ref: BridgeAccountRef, who: Linked, chat: string, argument: string): Promise<string> {
  const caller = callerOf(ref.workspaceId, who);
  const bots = await ctx.db.as(caller, listBots);
  if (bots.length === 0) return 'There is no bot you can talk to yet. Ask an admin to set one up.';
  const wanted = cleanLabel(argument, 60).replace(/^@/, '').toLowerCase();
  if (wanted === '') {
    const current = (await ctx.db.system((sys) => sys.query<{ name: string }>(
      'SELECT b.name FROM app.bridge_dm_sessions s JOIN app.bots b ON b.id = s.bot_id WHERE s.account_id = $1::uuid AND s.person_id = $2::uuid', [ref.id, who.personId]), { workspaceId: ref.workspaceId })).rows[0]?.name;
    const names = bots.map((b) => cleanLabel(b.name, 40)).join(', ');
    return `${current ? `You are talking to ${cleanLabel(current, 40)}. ` : ''}Bots you can talk to: ${names}. Send /bot and a name to choose one.`;
  }
  const bot = bots.find((b) => b.name.toLowerCase() === wanted || b.slug.toLowerCase() === wanted);
  if (!bot) return `I do not know that bot. Bots you can talk to: ${bots.map((b) => cleanLabel(b.name, 40)).join(', ')}.`;
  try {
    const channelId = await ctx.db.as(caller, async (tx) => (await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.conversations_open($1::uuid)', [bot.id])).rows[0]!.channel_id);
    await saveSession(ctx, ref, who, chat, bot.id, channelId);
  } catch (err) {
    const sentence = sentenceOf(err);
    if (sentence !== null) return sentence;
    throw err;
  }
  return `You are now talking to ${cleanLabel(bot.name, 40)}. Write your message.`;
}
