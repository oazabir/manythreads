import type { ImportChannelInput, ImportedChannel, MessageEditInput, MessageEdited, MessagePostInput as ProviderPostInput, MessagePosted, MessageProvider, MessageReactInput, MessageReacted, PluginTx } from '@manythreads/sdk';
import { AnswerPayload, importChannelName, isSubsequence, repairBotMarkdown } from '@manythreads/shared';
import { z } from 'zod';
import { conflict, forbidden, invalid } from './http.ts';
import { CHANNEL_COLUMNS, type ChannelRow } from './rows.ts';
import { editChannelMessage, postChannelMessage, pushChannelCreated, reactToMessage, requireChannel, type Deps } from './service.ts';

// What a bot may do with channel messages (SPEC §7.1 lists `messages.*` among a bot's native capabilities; PLAN P5-10). A
// capability is how one plugin calls another's behaviour — plugins never import each other — so the reply a runtime posts
// into a thread arrives here and goes through `postChannelMessage`, the same function the post route calls. Nothing about
// the write changes because a bot made it: the author is the transaction's actor (the run's bot), the permission is
// `app.channel_can(channel, 'post')` (a bot is a member of its team, so its team's public channels — never a private channel or a
// DM; the one exception is the bot conversation channel its own live run answers in, channels migration 0006), and the message is a
// normal message: mention resolution, unread counters, live push, `channel.message.posted`.
//
// `messages.search` lives in the search plugin (it owns the index); this file is only the write side.

/** The tool's arguments, exactly as the MCP gateway's catalog describes them to a model. */
export const PostMessageInput = z.strictObject({
  /** Absent inside a run that has a reply place: the channel the run answers in. */
  channelId: z.uuid().optional(),
  body: z.string().min(1).max(40_000),
  /** The thread to reply in: the root message id. Absent posts a new top-level message, except inside a run (see `runReplyPlace`). */
  threadRootId: z.uuid().nullish(),
});
export type PostMessageInput = z.infer<typeof PostMessageInput>;

/**
 * `messages.update`: replace the text of a message the bot posted itself (a checklist it keeps current). Same length limit as a post.
 * An edit never wakes anyone: mentions and links are not re-read, so a name added by an edit is plain text.
 */
export const UpdateMessageInput = z.strictObject({
  /** Absent inside a run that has a reply place: the channel the run answers in. */
  channelId: z.uuid().optional(),
  messageId: z.uuid(),
  body: z.string().min(1).max(40_000),
});
export type UpdateMessageInput = z.infer<typeof UpdateMessageInput>;

/** The answer: ids, never the message text back (the run already knows what it wrote). */
export interface PostMessageAnswer {
  ok: true;
  messageId: string;
  channelId: string;
  threadRootId: string | null;
}

/**
 * Where the bot run this transaction acts for answers (its own row; a bot reads its live run), or null outside a run or for a run with no place to answer. A run answers in a
 * thread (`replyRootId`), or at the top of its channel when it is an `inbox` run: only then does a top-level post name the run (`meta.runId`), which is how the connections plugin
 * ties a mail to the bot's post. Any other run with a channel but no thread (a routine, a scheduled job, a task) has no place here: stamping its top-level posts would make the runtime
 * believe the run already answered and skip its final reply.
 */
async function runReplyPlace(tx: PluginTx): Promise<{ runId: string; channelId: string; replyRootId: string | null } | null> {
  const here = (await tx.query<{ run_id: string | null }>(`SELECT app.run_id()::text AS run_id`)).rows[0]?.run_id ?? null;
  if (here === null) return null;
  const row = (
    await tx.query<{ channel_id: string | null; reply_root_id: string | null; trigger_type: string }>(
      `SELECT channel_id::text AS channel_id, reply_root_id::text AS reply_root_id, trigger_type FROM app.bot_runs WHERE id = $1::uuid`,
      [here],
    )
  ).rows[0];
  if (!row?.channel_id || (!row.reply_root_id && row.trigger_type !== 'inbox')) return null;
  return { runId: here, channelId: row.channel_id, replyRootId: row.reply_root_id };
}

/**
 * When the repair changed a bot's text, write `channel.markdown.repaired` (counts only) as the bot, with the run it belongs to, so the bot's page can say how
 * often it slips. Nothing is written for text that needed no repair. The record is part of the same transaction as the message.
 */
async function recordRepair(
  deps: Deps,
  tx: PluginTx,
  input: { channelId: string; messageId: string; via: 'post' | 'update'; counts: { paths: number; fences: number } },
): Promise<void> {
  if (input.counts.paths === 0 && input.counts.fences === 0) return;
  const runId = (await tx.query<{ run_id: string | null }>(`SELECT app.run_id()::text AS run_id`)).rows[0]?.run_id ?? null;
  const teamId = (await requireChannel(tx, input.channelId)).team_id;
  await deps.ctx.audit.emit(tx, {
    type: 'channel.markdown.repaired',
    channelId: input.channelId,
    teamId,
    messageId: input.messageId,
    botActorId: tx.actor.id,
    runId,
    via: input.via,
    paths: input.counts.paths,
    fences: input.counts.fences,
  });
}

export function registerMessageCapabilities(deps: Deps): void {
  const { ctx } = deps;
  ctx.capabilities.register('messages.post', async (input: Record<string, unknown>, tx: PluginTx): Promise<PostMessageAnswer> => {
    const parsed = PostMessageInput.parse(input);
    const place = await runReplyPlace(tx);
    const channelId = parsed.channelId ?? place?.channelId;
    if (channelId === undefined) throw invalid('channelId: name the channel to post in');
    // Inside a run that answers in a thread, a post to that same channel with no thread belongs in that thread (an explicit thread, or another
    // channel, is left alone). The message names its run, which is how the runtime knows the run already spoke and posts no second reply.
    const threadRootId = parsed.threadRootId ?? (place !== null && place.channelId === channelId ? place.replyRootId : null);
    // A bot's text goes through the Markdown repair: a bare file name or path becomes code, and a fence it left open is closed.
    const fixed = repairBotMarkdown(parsed.body);
    const posted = await postChannelMessage(deps, tx, {
      channelId,
      body: fixed.text,
      threadRootId,
      ...(place === null ? {} : { meta: { runId: place.runId } }),
    });
    await recordRepair(deps, tx, { channelId: posted.channelId, messageId: posted.id, via: 'post', counts: fixed });
    return { ok: true, messageId: posted.id, channelId: posted.channelId, threadRootId: posted.threadRootId };
  });
  // Only the bot's own messages (editChannelMessage refuses any other author), audited as `channel.message.edited` like a person's edit and
  // pushed live as `message.edited`. Mentions are not re-read (`syncRefs: false`): an edit notifies and wakes nobody.
  ctx.capabilities.register('messages.update', async (input: Record<string, unknown>, tx: PluginTx): Promise<PostMessageAnswer> => {
    const parsed = UpdateMessageInput.parse(input);
    const channelId = parsed.channelId ?? (await runReplyPlace(tx))?.channelId;
    if (channelId === undefined) throw invalid('channelId: name the channel the message is in');
    const fixed = repairBotMarkdown(parsed.body);
    const edited = await editChannelMessage(deps, tx, { channelId, messageId: parsed.messageId, body: fixed.text, syncRefs: false });
    await recordRepair(deps, tx, { channelId: edited.channelId, messageId: edited.id, via: 'update', counts: fixed });
    return { ok: true, messageId: edited.id, channelId: edited.channelId, threadRootId: edited.threadRootId };
  });
}

/**
 * What the `messages` provider accepts as `meta` (PLAN P5-18): the platform's own bookkeeping, validated here so a plugin cannot store a
 * payload the clients would not read. `answer` is an `AnswerPayload` (the answer plugin stamps it), `runId` the bot run that wrote the message.
 */
const ProviderMeta = z.strictObject({
  answer: AnswerPayload.optional(),
  runId: z.uuid().optional(),
  /** The tasks plugin's mark on the message announcing a card handover: bot routers read the key's presence and start no run from it. */
  handoff: z.strictObject({ taskId: z.uuid() }).optional(),
  /** The surface a bot drew in its run (surfaces plugin, P9-04): the client draws that surface in this message. Only a bot inside a run may set it. */
  surfaceRef: z.uuid().optional(),
  /** The category of the short notice a failed run leaves in the thread (runtime-hermes): at most one per run, found again by this key. */
  runFailure: z.enum(['gateway', 'runner_offline', 'runner_refused', 'hermes_unreachable', 'timeout', 'limit', 'steps', 'too_long', 'approval', 'not_allowed', 'not_on_team', 'other']).optional(),
});

/**
 * The `messages` provider: how a plugin posts a message with more than text. It is the same `postChannelMessage` the route and the capability
 * call, so a message made this way is indistinguishable from any other except for its `meta` — and it is not a capability, so no model can be
 * granted it and call it with a payload of its own (docs/plugins/answer.md).
 *
 * The provider does not take a caller's word for what the meta says. `meta.runId` is the transaction's own run (`app.run_id()`, which the
 * kernel sets when the run's bot acts), and an `answer` is the answer of that run, by the bot that is posting it, with the text that is the
 * message: a call cannot post one run's Answer as another's, as another bot's, or with a text that differs from the payload clients draw. This
 * is a check against the transaction, not a defence against plugin code that sets `app.run_id` itself: plugins are first-party code the
 * platform trusts (CLAUDE.md), and a hostile one could do much more.
 */
/** The keys of a JSON value in a stable order, so two values with the same content compare equal whatever order they were built in. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A person's copy of an answer (P5-17): checked against the stored answer of their own conversation. The copy may be LESS than the original and
 * nothing more: the text is a subsequence of it, every citation is one of its own by number (kept exactly as it was, or masked), no chips, and the
 * lineage and "Sources reached" are subsets. Whom it was for, by which bot and run, is the original's, and the caller is that person.
 */
async function checkAnswerCopy(tx: PluginTx, copyOf: string, copy: AnswerPayload, body: string): Promise<void> {
  const row = (
    await tx.query<{ answer: unknown; person_id: string | null }>(
      `SELECT x.meta -> 'answer' AS answer, app.person_id()::text AS person_id
         FROM app.messages x JOIN app.channels c ON c.id = x.channel_id
        WHERE x.id = $1 AND x.deleted_at IS NULL AND c.kind = 'bot_conversation' AND c.created_by = app.actor() AND x.meta ? 'answer'`,
      [copyOf],
    )
  ).rows[0];
  if (!row || row.person_id === null) throw forbidden('copyOf is an answer of the caller’s own conversation, and no other');
  const parsed = AnswerPayload.safeParse(row.answer);
  if (!parsed.success) throw invalid('copyOf: the original answer does not read');
  const original = parsed.data;
  if (copy.answeredFor.personId !== row.person_id) throw forbidden('meta.answer.answeredFor.personId is the person who shares, and no other');
  if (stable(copy.answeredFor) !== stable(original.answeredFor)) throw invalid('meta.answer.answeredFor is the original answer’s');
  if (copy.body !== body) throw invalid('meta.answer.body is the text of the message');
  if (!isSubsequence(copy.body, original.body)) throw invalid('meta.answer.body is the original text with claims taken out, and nothing added');
  if (copy.chips.length > 0) throw invalid('a copy of an answer carries no chips');
  const originals = new Map(original.citations.map((c) => [c.n, c] as const));
  for (const c of copy.citations) {
    const was = originals.get(c.n);
    if (!was) throw invalid(`meta.answer.citations: ${String(c.n)} is not a citation of the original`);
    if (c.kind === 'masked') continue;
    if (was.kind !== c.kind || stable({ ...was, label: '' }) !== stable({ ...c, label: '' })) {
      throw invalid(`meta.answer.citations: ${String(c.n)} is not the original citation`);
    }
  }
  // the lineage: an entry per citation the copy has (and for none it has not), the original's but for its label and age (re-read) and with the
  // bot's quote kept or gone; a masked entry is exactly the entry of a masked citation, and the masked citation says what kind of source it was
  const lineageOf = new Map(original.lineage.map((l) => [l.n, l] as const));
  const citationOf = new Map(copy.citations.map((c) => [c.n, c] as const));
  for (const l of copy.lineage) {
    const was = lineageOf.get(l.n);
    if (!was) throw invalid('meta.answer.lineage names a citation the original has not');
    const there = citationOf.get(l.n);
    if (!there) throw invalid('meta.answer.lineage names a citation the copy does not have');
    if ((l.masked === true) !== (there.kind === 'masked')) throw invalid(`meta.answer.lineage: ${String(l.n)} is masked in one place and not in the other`);
    if (l.masked === true) {
      if (l.label !== '' || l.at !== null || l.snippet !== null) throw invalid('meta.answer.lineage: a masked entry carries no label, age or quote');
      if (there.kind === 'masked' && l.kind !== there.source) throw invalid(`meta.answer.lineage: ${String(l.n)} is of another kind than its citation says`);
    } else if (l.kind !== was.kind || (l.snippet !== null && l.snippet !== was.snippet)) {
      throw invalid(`meta.answer.lineage: ${String(l.n)} is not the original entry`);
    }
  }
  for (const c of copy.citations) {
    if (c.kind !== 'masked') continue;
    const was = originals.get(c.n);
    const kind = was === undefined ? null : was.kind === 'masked' ? was.source : was.kind;
    if (c.source !== kind) throw invalid(`meta.answer.citations: ${String(c.n)} says it was a ${c.source}`);
  }
  // "Sources reached": the original's entries (a label may be read again), none added
  const reached = new Set(original.sourcesReached.map((s) => stable({ ...s, label: null })));
  if (copy.sourcesReached.some((s) => !reached.has(stable({ ...s, label: null })))) throw invalid('meta.answer.sourcesReached adds a source to the original');
  // what was left out only grows: a copy cannot claim the answer was less limited than it was
  if (copy.outsideScope.count < original.outsideScope.count) throw invalid('meta.answer.outsideScope is not smaller than the original’s');
  for (const item of original.outsideScope.items) {
    const now = copy.outsideScope.items.find((i) => i.kind === item.kind && i.reason === item.reason);
    if (!now || now.count < item.count) throw invalid('meta.answer.outsideScope is not smaller than the original’s');
  }
  // the share note is what the server computed from the two payloads, never a claim
  const have = new Set(copy.citations.map((c) => c.n));
  const masked = copy.citations.filter((c) => c.kind === 'masked').length;
  const gone = original.citations.filter((c) => !have.has(c.n)).length;
  if (copy.share?.masked !== masked || copy.share.removed !== gone) throw invalid('meta.answer.share is the number of citations masked and removed');
}

const ImportedMessageInput = z.strictObject({
  at: z.iso.datetime({ offset: true }),
  source: z.enum(['slack', 'mattermost']),
  sourceId: z.string().min(1).max(300),
  reactions: z.array(z.strictObject({ emoji: z.string().min(1).max(64), actorIds: z.array(z.uuid()).max(5_000) })).max(200).optional(),
});

/** Only the system pool (a background job) may import history: the check is on the login role, which no actor setting can change. */
const requireSystemRole = async (tx: PluginTx): Promise<void> => {
  const ok = (await tx.query<{ ok: boolean }>("SELECT session_user = 'manythreads_system' AS ok")).rows[0]?.ok === true;
  if (!ok) throw forbidden('Only the import job may do that');
};

async function importChannel(deps: Deps, tx: PluginTx, input: ImportChannelInput): Promise<ImportedChannel> {
  await requireSystemRole(tx);
  const team = (await tx.query<{ id: string; workspace_id: string; archived_at: Date | null }>('SELECT id, workspace_id, archived_at FROM app.teams WHERE id = $1', [input.teamId])).rows[0];
  if (!team) throw invalid('teamId: no such team');
  if (team.archived_at) throw conflict('This team is archived');
  const base = importChannelName(input.name);
  const taken = new Set(
    (await tx.query<{ name: string }>('SELECT lower(name) AS name FROM app.channels WHERE team_id = $1 AND (lower(name) = $2 OR lower(name) LIKE $3)', [team.id, base, `${base}-%`])).rows.map((r) => r.name),
  );
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  const groupId = (await tx.query<{ id: string }>("SELECT id FROM app.channel_groups WHERE team_id = $1 AND name = 'Channels'", [team.id])).rows[0]?.id ?? null;
  const id = (await tx.query<{ id: string }>('SELECT uuidv7() AS id')).rows[0]!.id;
  await tx.query(
    `INSERT INTO app.channels (id, workspace_id, team_id, group_id, name, kind, private, purpose, position, created_by)
     VALUES ($1, $2, $3, $4, $5, 'channel', $6, $7, (SELECT coalesce(max(position), 0) + 1 FROM app.channels WHERE team_id = $3), app.actor())`,
    [id, team.workspace_id, team.id, groupId, name, input.private, input.purpose.slice(0, 500)],
  );
  let added = 0;
  if (input.private) {
    // Only active people on the team who are not guests can be members (channels_add_member says the same); the others are counted, not guessed at.
    const ok = await tx.query<{ person_id: string }>(
      `SELECT DISTINCT p.id AS person_id
         FROM app.people p
         JOIN app.workspace_members wm ON wm.person_id = p.id AND wm.workspace_id = p.workspace_id AND wm.role <> 'guest'
         JOIN app.actors a ON a.kind = 'person' AND a.ref_id = p.id
         JOIN app.team_members tm ON tm.actor_id = a.id AND tm.team_id = $1
        WHERE p.id = ANY ($2::uuid[]) AND p.workspace_id = $3 AND p.status = 'active'`,
      [team.id, input.memberPersonIds, team.workspace_id],
    );
    for (const r of ok.rows) {
      await tx.query('SELECT app.channels_add_member($1, $2)', [id, r.person_id]);
      added += 1;
    }
  }
  const row = (await tx.query<ChannelRow>(`SELECT ${CHANNEL_COLUMNS} FROM app.channels c WHERE c.id = $1`, [id])).rows[0]!;
  await deps.ctx.audit.emit(tx, { type: 'channel.channel.created', channelId: id, teamId: team.id, name, kind: 'channel', private: input.private });
  await pushChannelCreated(deps, tx, row);
  const wanted = new Set(input.memberPersonIds).size;
  return { channelId: id, name, membersAdded: added, membersSkipped: input.private ? Math.max(0, wanted - added) : 0 };
}

export function registerMessageProvider(deps: Deps): void {
  const provider: MessageProvider = {
    id: 'channels',
    importChannel: (tx, input) => importChannel(deps, tx, input),
    async edit(tx: PluginTx, input: MessageEditInput): Promise<MessageEdited> {
      const body = z.string().min(1).max(40_000).safeParse(input.body);
      if (!body.success) throw invalid('body: 1 to 40,000 characters');
      // The same call the edit route and `messages.update` make, with the mentions and links left as they were: a script's edit never wakes anyone.
      const before = (await tx.query<{ edited_at: Date | null }>('SELECT edited_at FROM app.messages WHERE id = $1 AND channel_id = $2', [input.messageId, input.channelId])).rows[0];
      const edited = await editChannelMessage(deps, tx, { channelId: input.channelId, messageId: input.messageId, body: body.data, syncRefs: false });
      const after = (await tx.query<{ edited_at: Date | null }>('SELECT edited_at FROM app.messages WHERE id = $1', [input.messageId])).rows[0];
      return { id: edited.id, channelId: input.channelId, changed: (after?.edited_at?.getTime() ?? 0) !== (before?.edited_at?.getTime() ?? 0) };
    },
    async react(tx: PluginTx, input: MessageReactInput): Promise<MessageReacted> {
      const emoji = z.string().min(1).max(64).regex(/^\S+$/).safeParse(input.emoji);
      if (!emoji.success) throw invalid('emoji: no spaces, at most 64 characters');
      const done = await reactToMessage(deps, tx, { channelId: input.channelId, messageId: input.messageId, emoji: emoji.data, add: input.add });
      return { changed: done.changed };
    },
    async post(tx: PluginTx, input: ProviderPostInput): Promise<MessagePosted> {
      if (input.imported !== undefined) {
        // History from another product (the import plugin): system pool only, never combined with a bot's bookkeeping.
        await requireSystemRole(tx);
        if (input.meta !== undefined || input.copyOf !== undefined) throw invalid('imported: cannot be combined with meta or copyOf');
        const imp = ImportedMessageInput.safeParse(input.imported);
        if (!imp.success) throw invalid(`imported: ${imp.error.issues.map((i) => `${i.path.join('.') || '(imported)'}: ${i.message}`).join('; ')}`);
        const text = z.string().min(1).max(40_000).safeParse(input.body);
        if (!text.success) throw invalid('body: 1 to 40,000 characters');
        if (Date.parse(imp.data.at) > Date.now() + 60_000) throw invalid('imported.at: not in the future');
        const done = await postChannelMessage(deps, tx, {
          channelId: input.channelId,
          body: text.data,
          threadRootId: input.threadRootId ?? null,
          imported: { ...imp.data, reactions: imp.data.reactions ?? [] },
        });
        return { id: done.id, channelId: done.channelId, threadRootId: done.threadRootId, createdAt: done.row.created_at.toISOString() };
      }
      const body = z.string().min(1).max(40_000).safeParse(input.body);
      if (!body.success) throw invalid('body: 1 to 40,000 characters');
      const meta = input.meta === undefined ? undefined : ProviderMeta.safeParse(input.meta);
      if (meta && !meta.success) throw invalid(`meta: ${meta.error.issues.map((i) => `${i.path.join('.') || '(meta)'}: ${i.message}`).join('; ')}`);
      if (input.copyOf !== undefined) {
        // a person's masked copy of their own answer: no run, and the copy is checked against the original (never the other way round)
        if (!meta?.success || meta.data.answer === undefined || meta.data.runId !== undefined) {
          throw invalid('copyOf: a copy of an answer carries meta.answer and no runId');
        }
        await checkAnswerCopy(tx, input.copyOf, meta.data.answer, body.data);
      } else if (meta?.success && (meta.data.runId !== undefined || meta.data.answer !== undefined || meta.data.runFailure !== undefined || meta.data.surfaceRef !== undefined)) {
        const here = (
          await tx.query<{ run_id: string | null; bot_id: string | null }>(
            `SELECT app.run_id()::text AS run_id,
                    (SELECT a.ref_id::text FROM app.actors a WHERE a.id = app.actor() AND a.kind = 'bot') AS bot_id`,
          )
        ).rows[0];
        const run = here?.run_id ?? null;
        if (meta.data.surfaceRef !== undefined && (run === null || here?.bot_id == null)) throw forbidden('meta.surfaceRef is for a bot acting inside a run');
        if (meta.data.runFailure !== undefined && meta.data.runId === undefined) throw invalid('meta.runId: a failure notice names the run it is about');
        if (meta.data.runId !== undefined && (run === null || meta.data.runId !== run)) {
          throw forbidden('meta.runId is the run this transaction acts for, and no other');
        }
        const answer = meta.data.answer;
        if (answer !== undefined) {
          if (meta.data.runId === undefined) throw invalid('meta.runId: an answer names the run that wrote it');
          if (answer.answeredFor.runId !== run) throw forbidden('meta.answer.answeredFor.runId is the run this transaction acts for, and no other');
          if (here?.bot_id == null || answer.answeredFor.botId !== here.bot_id) throw forbidden('meta.answer.answeredFor.botId is the bot that posts the answer, and no other');
          if (answer.body !== body.data) throw invalid('meta.answer.body is the text of the message');
        }
      }
      const posted = await postChannelMessage(deps, tx, {
        channelId: input.channelId,
        body: body.data,
        threadRootId: input.threadRootId ?? null,
        ...(meta?.success ? { meta: meta.data as Record<string, unknown> } : {}),
        ...(input.skipRefs === true ? { skipRefs: true } : {}),
        ...(input.attachmentIds !== undefined && input.attachmentIds.length > 0 ? { attachmentIds: input.attachmentIds } : {}),
      });
      return { id: posted.id, channelId: posted.channelId, threadRootId: posted.threadRootId, createdAt: posted.row.created_at.toISOString() };
    },
  };
  deps.ctx.providers.register('messages', provider);
}
