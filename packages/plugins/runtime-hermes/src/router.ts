import { createHash } from 'node:crypto';
import type { BotRuntimeInput, BotRuntimeProvider, BotRuntimeScope, CapabilityAuthorizeContext, PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';
import { ChannelMessagePostedEvent, botMdPath, parseBotMd, parseMarkup, type BotTrigger } from '@manythreads/shared';
import { z } from 'zod';

// Trigger routing (PLAN P5-10: "route `conversation`, `mention`, `channel_message` triggers"). One subscription on
// `channel.message.posted` decides, for every active bot of the message's team, whether one of its BOT.md triggers fired;
// the run itself happens in a job, because starting a process and talking to a model has no business in the outbox
// transaction that delivered the event.
//
// The three triggers, as this phase can honestly tell them apart:
//
//  * `conversation` — the message landed in the bot's own channel (`channels.bot_id = bot.id`, the unlisted per-bot channel
//    P5-16 creates). This is also the shape a DM with a bot takes, so it is the trigger a person talking to a bot fires.
//  * `mention` — the body names the bot (`@<slug>`), optionally only in the channels the trigger lists.
//  * `channel_message` — a message in a channel the trigger lists (or, with no `source`, anywhere on the bot's team).
//
// What never fires a run: a message a **bot** wrote (no bot answers a bot in this phase — that is delegation, P6), a private
// channel, a DM, an archived channel, and the bot's own reply, which is a message like any other. One message starts at most
// one run per bot (the job's dedupe key), and the trigger with the highest priority wins: conversation, then mention, then
// channel_message.

/** The job queue one run executes in. */
export const RUN_QUEUE = 'runtime-hermes.run';

/** What the router decided: which trigger of one bot fires on one message. */
export type RoutedTrigger = 'conversation' | 'mention' | 'channel_message';

export interface MessageView {
  /** The channel's name, without the `#`. */
  channelName: string;
  /** The channel is the bot's own (its conversation). */
  isBotChannel: boolean;
  /** The lowercased `@handles` the body names. */
  mentions: ReadonlySet<string>;
}

/** The trigger of `bot` that this message fires, or null. Highest priority first; `source.channels` narrows mention and channel_message. */
export function matchTrigger(triggers: readonly BotTrigger[], botSlug: string, view: MessageView): RoutedTrigger | null {
  const inSource = (trigger: BotTrigger): boolean => {
    const source = 'source' in trigger ? trigger.source : undefined;
    return (
      source === undefined || source.channels.some((ref) => ref.slice(1).toLowerCase() === view.channelName.toLowerCase())
    );
  };
  const has = (type: BotTrigger['type']): BotTrigger | undefined => triggers.find((t) => t.type === type);

  if (has('conversation') && view.isBotChannel) return 'conversation';
  const mention = has('mention');
  if (mention && view.mentions.has(botSlug.toLowerCase()) && inSource(mention)) return 'mention';
  const channelMessage = has('channel_message');
  if (channelMessage && inSource(channelMessage)) return 'channel_message';
  return null;
}

/**
 * The `@handles` a body names, lowercased — read with the composer's own parser, so a handle inside a code span, a fence, a
 * URL or an email names nobody here either, and a mention the composer would link is a mention that routes. A bot's slug
 * (letters, digits, `.`, `_`, `-`) is exactly what that parser accepts.
 */
export function mentionedHandles(body: string): Set<string> {
  return new Set(parseMarkup(body).mentions.map((m) => m.handle.toLowerCase()));
}

/** What the run is asked, in one prompt: who said it, where, and the message itself. The bot's behaviour is SOUL.md's job. */
export function buildPrompt(input: { authorName: string; channelName: string; body: string }): string {
  return `${input.authorName} in #${input.channelName}:\n\n${input.body}`;
}

const RunPayload = z.strictObject({
  workspaceId: z.uuid(),
  botId: z.uuid(),
  teamId: z.uuid(),
  channelId: z.uuid(),
  trigger: z.enum(['conversation', 'mention', 'channel_message']),
  askerActorId: z.uuid().nullable(),
  /** Where the reply goes: the thread root when the message is inside one, else the message itself (the reply opens the thread). */
  replyRootId: z.uuid(),
  /** The run's `thread_id`: the thread the message is in, when there is one (`bot_runs.thread_id` references `app.threads`). */
  runThreadId: z.uuid().nullable(),
  prompt: z.string().min(1).max(40_000),
});
export type RunPayload = z.infer<typeof RunPayload>;

interface MessageRow {
  id: string;
  body: string;
  channel_id: string;
  thread_root_id: string | null;
  author_id: string;
  channel_name: string;
  channel_team: string | null;
  channel_private: boolean;
  channel_archived: Date | null;
  channel_bot_id: string | null;
  author_kind: string;
  author_name: string;
  [key: string]: unknown;
}

interface BotRow {
  id: string;
  slug: string;
  runtime: string;
  triggers: BotTrigger[] | null;
  [key: string]: unknown;
}

/** The one subscription: decide, then enqueue one run per bot that the message fires. Runs in the outbox's system transaction. */
export function registerRouter(ctx: PluginContext): void {
  ctx.events.subscribe('channel.message.posted', async (raw: PluginEvent, tx: PluginTx) => {
    const event = ChannelMessagePostedEvent.parse(raw);
    const message = (
      await tx.query<MessageRow>(
        `SELECT m.id, m.body, m.channel_id, m.thread_root_id, m.author_id,
                c.name AS channel_name, c.team_id AS channel_team, c.private AS channel_private,
                c.archived_at AS channel_archived, c.bot_id AS channel_bot_id,
                a.kind AS author_kind, coalesce(p.display_name, b.name, 'someone') AS author_name
           FROM app.messages m
           JOIN app.channels c ON c.id = m.channel_id
           JOIN app.actors a ON a.id = m.author_id
           LEFT JOIN app.people p ON p.id = a.ref_id AND a.kind = 'person'
           LEFT JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot'
          WHERE m.id = $1`,
        [event.messageId],
      )
    ).rows[0];
    if (!message) return;
    // No bot answers a bot (delegation is P6), no bot runs from a private channel or a DM (SPEC §12), none from an archived
    // channel, and a message whose author is gone has nobody to answer.
    if (message.author_kind !== 'person') return;
    if (message.channel_team === null || message.channel_private || message.channel_archived !== null) return;

    const view: MessageView = {
      channelName: message.channel_name,
      isBotChannel: false,
      mentions: mentionedHandles(message.body),
    };
    const bots = (
      await tx.query<BotRow>(
        `SELECT id, slug, runtime, triggers FROM app.bots WHERE team_id = $1 AND status = 'active' ORDER BY slug`,
        [message.channel_team],
      )
    ).rows;
    for (const bot of bots) {
      const trigger = matchTrigger(bot.triggers ?? [], bot.slug, {
        ...view,
        isBotChannel: message.channel_bot_id === bot.id,
      });
      if (trigger === null) continue;
      const payload: RunPayload = {
        workspaceId: event.workspaceId,
        botId: bot.id,
        teamId: message.channel_team,
        channelId: message.channel_id,
        trigger,
        askerActorId: message.author_id,
        replyRootId: message.thread_root_id ?? message.id,
        runThreadId: message.thread_root_id,
        prompt: buildPrompt({ authorName: message.author_name, channelName: message.channel_name, body: message.body }),
      };
      await ctx.jobs.enqueue(tx, RUN_QUEUE, payload, { dedupeKey: `runtime-hermes:${bot.id}:${message.id}` });
    }
  });
}

/** The LLM gateway door, structurally: `gateway-llm` registers it, and a plugin cannot import another plugin's types. */
interface LlmDoor {
  id: string;
  [member: string]: unknown;
  botKey(tx: PluginTx, botId: string): Promise<string | null>;
  preflight(
    tx: PluginTx,
    request: { workspaceId: string; botId: string | null; teamId: string | null; sessionId: string | null; alias: string; text: string },
  ): Promise<{ allowed: boolean; message: string | null }>;
}

/** The repo door, structurally: what `repo-git` registers (docs/plugins/repo-git.md). */
interface RepoDoor {
  id: string;
  [member: string]: unknown;
  blob(tx: PluginTx, teamId: string, path: string, ref: string, maxBytes?: number): Promise<{ content: Uint8Array }>;
}

interface RunBotRow {
  id: string;
  slug: string;
  name: string;
  runtime: string;
  definition_sha: string;
  team_id: string;
  workspace_id: string;
  status: string;
  [key: string]: unknown;
}

/**
 * What the broker must know beyond the capability's name: the repo path(s) the call itself names. A mutation (`files.*`,
 * `pages.write`) is judged on the path its own arguments name — the same path the handler would write — and a call that
 * names none is refused rather than judged blind. The MCP gateway has the same rule at its own door
 * (gateway-mcp/src/catalog.ts, `authorizeContext`); a runtime's direct call needs it for the same reason.
 */
function authorizeContext(input: Record<string, unknown>): CapabilityAuthorizeContext {
  const path = input['path'];
  const paths = input['paths'];
  return {
    ...(typeof path === 'string' ? { path } : {}),
    ...(Array.isArray(paths) && paths.every((p): p is string => typeof p === 'string') ? { paths } : {}),
  };
}

/** Run one bot: the job half of P5-10. Everything it needs is re-read from the database and the repo (a payload is whatever was enqueued). */
export function registerRunJob(ctx: PluginContext): void {
  ctx.jobs.register(RUN_QUEUE, async (raw, tx, job) => {
    const payload = RunPayload.parse(raw);
    const bot = (
      await tx.query<RunBotRow>(
        `SELECT id, slug, name, runtime, definition_sha, team_id, workspace_id, status
           FROM app.bots WHERE id = $1 AND workspace_id = $2`,
        [payload.botId, payload.workspaceId],
      )
    ).rows[0];
    if (!bot || bot.status !== 'active') return; // a disabled, invalid or removed bot does not answer
    if (bot.team_id !== payload.teamId) return;

    const provider = ctx.providers.get<BotRuntimeProvider>('bot_runtime', bot.runtime);
    if (!provider) {
      job.log.warn(`runtime-hermes: no bot_runtime provider is loaded for "${bot.runtime}" (bot ${bot.slug})`);
      return;
    }

    // The definition the run executes: the file the loader last loaded, read from the repo. A row whose file has moved on (a
    // commit in flight) is refused rather than run on a definition the roster never showed.
    const repo = ctx.providers.get<RepoDoor>('repo');
    if (!repo) throw new Error('runtime-hermes: the repo provider is not registered');
    const file = await repo.blob(tx, bot.team_id, botMdPath(bot.slug), 'main');
    const contents = Buffer.from(file.content).toString('utf8');
    if (createHash('sha256').update(file.content).digest('hex') !== bot.definition_sha) {
      job.log.warn(`runtime-hermes: bot ${bot.slug} has a newer BOT.md in the repo than the loaded definition; no run`);
      return;
    }
    const parsed = parseBotMd(contents);
    if (!parsed.ok) {
      job.log.warn(`runtime-hermes: the loaded definition of ${bot.slug} no longer parses (${parsed.failure.message}); no run`);
      return;
    }
    const alias = parsed.frontmatter.model?.aliases?.[0] ?? null;

    const { run, token } = await ctx.runs.open({
      botId: bot.id,
      teamId: bot.team_id,
      workspaceId: bot.workspace_id,
      trigger: payload.trigger,
      askerActorId: payload.askerActorId,
      threadId: payload.runThreadId,
    });

    let toolCalls = 0;
    try {
      if (alias === null) throw new Error(`bot ${bot.slug}: a hermes run needs model.aliases[0] in its BOT.md`);
      const gatewayBase = (process.env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
      if (gatewayBase === '') throw new Error('runtime-hermes: MANYTHREADS_LITELLM_URL is not set, so no model can be reached');

      // The gateway's own door: the bot's virtual key, and the pre-call check (preset, DLP hook, budgets, rate limits) that
      // P5-07 puts in front of every call. A refusal stops the run before anything is sent.
      const llm = ctx.providers.get<LlmDoor>('llm');
      const key = llm ? await llm.botKey(tx, bot.id) : null;
      if (llm) {
        const decision = await llm.preflight(tx, {
          workspaceId: bot.workspace_id,
          botId: bot.id,
          teamId: bot.team_id,
          sessionId: run.runId,
          alias,
          text: payload.prompt,
        });
        if (!decision.allowed) {
          job.log.warn(`runtime-hermes: run ${run.runId} refused before the call: ${decision.message ?? 'not allowed'}`);
          await ctx.runs.close(run.runId, 'stopped');
          return;
        }
      }

      const input: BotRuntimeInput = {
        bot: {
          id: bot.id,
          slug: bot.slug,
          name: bot.name,
          teamId: bot.team_id,
          workspaceId: bot.workspace_id,
          runtime: bot.runtime,
          definitionSha: bot.definition_sha,
        },
        definition: { frontmatter: parsed.frontmatter, body: parsed.body },
        trigger: payload.trigger,
        asker: payload.askerActorId === null ? null : { actorId: payload.askerActorId, personId: null, displayName: null },
        prompt: payload.prompt,
        thread: { channelId: payload.channelId, threadRootId: payload.replyRootId },
        endpoint: { runId: run.runId, url: `${ctx.runtime.publicUrl}/api/mcp/runs/${token}`, token },
        gateway: { baseUrl: gatewayBase, key },
        // SPEC §7.1's limits: a run's own wall clock. The definition schema has no turn count, so none is passed.
        limits: { runBudgetSeconds: parsed.frontmatter.limits?.timeoutSeconds ?? null, maxTurns: null, sessionMinutes: parsed.frontmatter.limits?.sessionMinutes ?? null },
      };

      // The scope a provider gets is the run's own authority, and the broker decides every call it makes: the runtime
      // implements what a model chose, so a call it makes is exactly as constrained as one made over the run's MCP
      // endpoint. Without this the allowlist compiled from `capabilities.native` would be a promise the platform keeps at
      // one door and forgets at the other.
      const scope: BotRuntimeScope = {
        async invoke(capability, args) {
          const decision = await ctx.runs.authorize(run, capability, authorizeContext(args));
          if (!decision.allowed) throw new Error(`the run may not call "${capability}": ${decision.reason}`);
          // Fail closed, as the MCP gateway does: a grant that waits for a person is the Approvals inbox (P5-20), which
          // this deployment does not have yet, and running the call anyway is the one thing the flag exists to stop.
          if (decision.needsApproval) throw new Error(`"${capability}" needs a person's approval before it runs`);
          return ctx.runs.asBot(run, (inner) => ctx.runs.invoke(inner, capability, args));
        },
        logSource: (source) => ctx.runs.asBot(run, (inner) => ctx.runs.logSource(inner, source)),
        log: (line) => job.log.info(line),
      };

      const handle = await provider.run(input, scope);

      let reply = '';
      let ok = false;
      for await (const event of handle.events) {
        if (event.type === 'tool') toolCalls += 1;
        if (event.type !== 'result') continue;
        reply = event.text;
        ok = event.ok;
        if (event.tokens) job.log.info(`runtime-hermes: run ${run.runId} used ${event.tokens.total} tokens over ${toolCalls} tool calls`);
        if (!event.ok) job.log.warn(`runtime-hermes: run ${run.runId} failed: ${event.error ?? 'no reason given'}`);
      }
      await handle.stop();

      // The reply is a message like any other: posted through the channels plugin's own `messages.post`, as the run's bot,
      // and authorized like every other call the run makes — a definition that never asked for `messages.post` cannot post.
      if (reply.trim() !== '') {
        await scope.invoke('messages.post', {
          channelId: payload.channelId,
          body: reply,
          threadRootId: payload.replyRootId,
        });
      }
      await ctx.runs.close(run.runId, ok ? 'done' : 'failed');
    } catch (err) {
      // A model call is not something to replay blindly: the run is closed as failed and the reason is logged, rather than
      // letting the job retry (which would re-ask the model and post a second answer).
      job.log.warn(`runtime-hermes: run ${run.runId} threw: ${err instanceof Error ? err.message : String(err)}`);
      await ctx.runs.close(run.runId, 'failed');
    }
  });
}
