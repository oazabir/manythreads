import type { MessagePostInput, MessageProvider, PluginContext, PluginTx } from '@manythreads/sdk';
import type { Task } from '@manythreads/shared';
import { actorOf } from './rows.ts';

/**
 * The visible half of a handover (PLAN P6-03): a message in a thread that says who gave the card to whom, so people watching see
 * "Orchestrator → @coder: <note>". It is written as the sender, through the one message door, and carries `meta.handoff` — the mark that makes
 * every bot router skip it, so the @mention in it starts no run (the assignment's own event wakes the new owner).
 *
 * **Where it goes** (the text of a private place never lands in a public one):
 *  1. Where the handover was asked for: the thread (and channel) a request names, or the one the calling bot run answers in.
 *     - A channel of the card's team, public or private, where the NEW owner may also post: the full card, as a reply in that thread.
 *     - Anything else (a DM, a bot's conversation, a private channel the new owner cannot post in): a short card in the team's first public
 *       channel that carries no note, so nothing said there is copied out of it. Nobody there could be woken to answer it anyway.
 *  2. No origin: the card's own thread (`tasks.thread_root_id`), else the team's first public channel the sender may post in.
 * The message is also the card's thread root when the card had none (`app.tasks_record_card`).
 *
 * A bot sender is first authorized for `messages.post` by the capability broker (a bot that lacks it still hands the card over; nothing is
 * posted). Every way this can fail leaves the handover standing and writes a `not_woken` line on the card's history with a reason code
 * (`app.tasks_note_event`), so a miss is on the record. Plugins have no logger of their own; the card history is the log.
 */
export interface HandoffOrigin {
  channelId?: string;
  threadRootId?: string;
}

interface Place {
  channelId: string;
  rootId: string | null;
  inTeam: boolean;
  private: boolean;
}

async function missed(tx: PluginTx, taskId: string, reason: string): Promise<void> {
  await tx.query('SELECT app.tasks_note_event($1::uuid, $2, $3::jsonb)', [taskId, 'not_woken', JSON.stringify({ reason })]);
}

/** Where the handover was asked for: a named channel/thread, else the channel and thread the calling bot run answers in. */
async function originOf(tx: PluginTx, task: Task, asked: HandoffOrigin | undefined): Promise<Place | 'unreadable' | null> {
  let channelId = asked?.channelId ?? null;
  let rootRef = asked?.threadRootId ?? null;
  if (!channelId && !rootRef) {
    const run = (await tx.query<{ channel_id: string | null; reply_root_id: string | null }>('SELECT channel_id, reply_root_id FROM app.bot_runs WHERE id = app.run_id()')).rows[0];
    channelId = run?.channel_id ?? null;
    rootRef = run?.reply_root_id ?? null;
  }
  const named = channelId !== null || rootRef !== null;
  let rootId: string | null = null;
  if (rootRef) {
    const m = (
      await tx.query<{ root: string; channel_id: string }>(
        'SELECT coalesce(thread_root_id, id) AS root, channel_id FROM app.messages WHERE id = $1::uuid AND deleted_at IS NULL',
        [rootRef],
      )
    ).rows[0];
    if (m && (!channelId || m.channel_id === channelId)) {
      rootId = m.root;
      channelId = m.channel_id;
    }
  }
  // A place was named but cannot be read by the sender (private to others, deleted): treat it as private, never as "no origin".
  if (!channelId) return named ? 'unreadable' : null;
  const c = (
    await tx.query<{ team_id: string | null; kind: string; private: boolean; archived_at: Date | null }>('SELECT team_id, kind, private, archived_at FROM app.channels WHERE id = $1::uuid', [channelId])
  ).rows[0];
  if (!c || c.archived_at) return 'unreadable';
  return { channelId, rootId, inTeam: c.kind === 'channel' && c.team_id === task.teamId, private: c.private };
}

async function firstPublicChannel(tx: PluginTx, teamId: string): Promise<string | null> {
  return (
    (
      await tx.query<{ id: string }>(
        `SELECT c.id FROM app.channels c
          WHERE c.team_id = $1::uuid AND c.kind = 'channel' AND NOT c.private AND c.archived_at IS NULL
            AND c.id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[])
          ORDER BY c.position, c.created_at, c.id LIMIT 1`,
        [teamId],
      )
    ).rows[0]?.id ?? null
  );
}

export async function postHandoffCard(
  ctx: PluginContext,
  tx: PluginTx,
  input: { task: Task; handoffId: string; toActorId: string; note: string; pending: boolean; origin?: HandoffOrigin },
): Promise<void> {
  const { task } = input;
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return missed(tx, task.id, 'no_message_door');
  const from = await actorOf(tx, tx.actor.id);
  const to = await actorOf(tx, input.toActorId);
  if (!from || !to) return;

  // A bot posts only what the broker lets its grants post (no `messages.post`, no card; the handover itself is not affected).
  if (from.kind === 'bot') {
    const decision = await ctx.capabilities.authorize(tx, 'messages.post', {}).catch(() => ({ allowed: false, needsApproval: false, reason: 'no broker' }));
    if (!decision.allowed || decision.needsApproval) return missed(tx, task.id, 'sender_cannot_post');
  }

  const slug = to.kind === 'bot' ? (await tx.query<{ slug: string }>('SELECT slug FROM app.bots WHERE id = $1::uuid', [to.ref_id])).rows[0]?.slug : undefined;
  const note = input.note.trim();
  const target = slug !== undefined && !input.pending ? `@${slug}` : to.name;
  const full = input.pending
    ? `${from.name} would like to hand “${task.title}” to ${to.name} (waiting for approval)${note ? `: ${note}` : ''}`
    : `${from.name} → ${target}: ${note || `“${task.title}”`}`;
  const short = input.pending ? `${from.name} would like to hand “${task.title}” to ${to.name} (waiting for approval)` : `${from.name} handed “${task.title}” to ${target}`;

  await tx.query('SAVEPOINT tasks_card');
  try {
    let place: { channelId: string; rootId: string | null; body: string } | null = null;
    const origin = await originOf(tx, task, input.origin);
    if (origin !== null && origin !== 'unreadable') {
      const receiverCanPost = origin.inTeam && (await tx.query<{ ok: boolean }>('SELECT app.channel_actor_can_post($1::uuid, $2::uuid) AS ok', [input.toActorId, origin.channelId])).rows[0]?.ok === true;
      if (receiverCanPost) place = { channelId: origin.channelId, rootId: origin.rootId, body: full };
    } else if (task.threadRootId) {
      const root = (
        await tx.query<{ channel_id: string }>('SELECT channel_id FROM app.messages WHERE id = $1::uuid AND thread_root_id IS NULL AND deleted_at IS NULL', [task.threadRootId])
      ).rows[0];
      if (root) place = { channelId: root.channel_id, rootId: task.threadRootId, body: full };
    }
    if (!place) {
      const channelId = await firstPublicChannel(tx, task.teamId);
      // From a place the new owner cannot answer in (or none), the card goes to a public channel: with the note only when nothing private is involved.
      if (channelId) place = { channelId, rootId: null, body: origin !== null ? short : full };
    }
    if (!place) {
      await tx.query('RELEASE SAVEPOINT tasks_card');
      return missed(tx, task.id, 'no_channel');
    }
    const meta = { handoff: { taskId: task.id } } as unknown as MessagePostInput['meta'];
    const posted = await messages.post(tx, { channelId: place.channelId, body: place.body, threadRootId: place.rootId, meta });
    await tx.query('SELECT app.tasks_record_card($1::uuid, $2::uuid)', [input.handoffId, posted.id]);
    await tx.query('RELEASE SAVEPOINT tasks_card');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT tasks_card');
    await tx.query('RELEASE SAVEPOINT tasks_card');
    // The error text stays out of the card's history (every team reader sees it): a fixed reason code only.
    void err;
    await missed(tx, task.id, 'post_failed');
  }
}
