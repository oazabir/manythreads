import { HttpError, type MessageProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import { AnswerInput } from '@manythreads/shared';
import { buildAnswer, citationRef } from './build.ts';
import { AnswerAlready, AnswerView } from './view.ts';

/** What the tool answers the model with. A refusal is an answer the model can read and act on, never a transport error. */
export type AnswerToolResult =
  | { ok: true; messageId: string; citationsKept: number; citationsRemoved: number; message: string }
  | { ok: false; code: string; message: string };

const refuse = (code: string, message: string): AnswerToolResult => ({ ok: false, code, message });

/** Fields the platform writes. A model that names one of them is told so, instead of being told "unrecognized key". */
const PLATFORM_FIELDS = ['answeredFor', 'lineage', 'sourcesReached', 'scope', 'version', 'personId', 'runId', 'askerId', 'asker'] as const;

/** The payload as stored must stay small: it travels with every read of the message. */
const MAX_PAYLOAD_BYTES = 96_000;

/**
 * `answer.post`: the bot finishes its reply with an Answer (PLAN P5-18). Runs in the run's bot transaction (the gateway's `asBot`), so the message
 * is the bot's and carries `app.run_id`; everything the model cannot be trusted with is read here, as the person who asked:
 *
 *   1. `app.answer_view` re-reads every citation and every source the run reached under the asker's own row level security;
 *   2. `buildAnswer` keeps what the asker may open (and the reply's readers may), counts what it dropped, stamps `answeredFor` from the run;
 *   3. the message is posted through the channels plugin's `messages` provider — the same write every message takes — into the thread the run
 *      answers in. The model names no channel and no thread: they are the run's own.
 */
export async function postAnswer(ctx: PluginContext, tx: PluginTx, input: Record<string, unknown>): Promise<AnswerToolResult> {
  const claimed = PLATFORM_FIELDS.filter((key) => Object.hasOwn(input, key));
  if (claimed.length > 0) {
    return refuse('platform_field', `${claimed.join(', ')} ${claimed.length === 1 ? 'is' : 'are'} set by the platform from the run, never by the bot. Send body, citations, outsideScope and chips.`);
  }
  const parsed = AnswerInput.safeParse(input);
  if (!parsed.success) {
    return refuse('invalid_arguments', parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.message}`).join('; '));
  }
  const answer = parsed.data;

  const slugs = answer.chips.flatMap((chip) => (chip.kind === 'handoff' ? [chip.botSlug] : []));
  const cites = answer.citations.map((c) => citationRef(c));
  const res = await tx.query<{ view: unknown }>('SELECT app.answer_view($1::jsonb, $2::text[]) AS view', [JSON.stringify(cites), slugs]);
  const raw = res.rows[0]?.view ?? null;
  if (raw === null) return refuse('no_run', 'answer.post is for a live run of a bot: there is no run to answer for.');
  const already = AnswerAlready.safeParse(raw);
  if (already.success) {
    return refuse('already_answered', 'This run has already posted its answer. It is the reply; do not post another.');
  }
  const view = AnswerView.parse(raw);
  if (view.run.channelId === null || view.run.replyRootId === null) {
    return refuse('no_thread', 'This run was not asked in a thread, so there is nowhere to post an answer. Reply with plain text instead.');
  }

  const built = buildAnswer(answer, view);
  if (Buffer.byteLength(JSON.stringify(built.payload), 'utf8') > MAX_PAYLOAD_BYTES) {
    return refuse('too_large', 'The answer with its citations is too large: shorten the text or cite fewer sources.');
  }

  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) return refuse('unavailable', 'Messages are not available in this deployment.');
  let posted;
  try {
    posted = await messages.post(tx, {
      channelId: view.run.channelId,
      body: built.payload.body,
      threadRootId: view.run.replyRootId,
      meta: { answer: built.payload, runId: view.run.runId },
    });
  } catch (err) {
    if (err instanceof HttpError) return refuse(err.code, err.message);
    throw err;
  }

  await ctx.audit.emit(tx, {
    type: 'answer.answer.posted',
    workspaceId: view.run.workspaceId,
    botId: view.run.botId,
    runId: view.run.runId,
    askerPersonId: view.run.askerPersonId,
    channelId: view.run.channelId,
    messageId: posted.id,
    threadRootId: posted.threadRootId,
    citationCount: built.keptCitations,
    droppedCount: built.droppedCitations,
    reachedCount: built.payload.sourcesReached.length,
  });

  return {
    ok: true,
    messageId: posted.id,
    citationsKept: built.keptCitations,
    citationsRemoved: built.droppedCitations,
    message:
      built.droppedCitations > 0
        ? `Posted as your reply. ${built.droppedCitations} citation(s) were removed because the person who asked cannot open them. Do not post it again.`
        : 'Posted as your reply. Do not post it again.',
  };
}
