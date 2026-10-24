import { authorizeContext, type BotRunHandle, type MessageProvider, type PluginContext, type PluginTx } from '@manythreads/sdk';
import type { RunPayload } from './run-job.ts';

// When a run that answers a message ends without an answer, the person who asked would otherwise wait for a reply that never comes. This
// file turns the end of such a run into ONE short line in the thread, written as the bot, naming a category of cause and nothing else:
// never the error text (it can carry a key's first characters, a hash, an address or a stack trace), never the model's half answer.

/** The causes a notice can name. `limit` and `approval` are raised by the run job where it knows them; the rest are read off a failed run. */
export type FailureCategory = 'gateway' | 'runner_offline' | 'timeout' | 'limit' | 'approval' | 'other';

/** The whole text a person sees, per category. Fixed strings: nothing from the failure is ever put into them. */
export const FAILURE_NOTICE: Record<FailureCategory, string> = {
  gateway: "I couldn't answer: the model gateway refused the call. Try again in a little while; if it keeps happening, tell a workspace admin.",
  runner_offline: "I couldn't answer: this team's runner is offline. Try again once it is back.",
  timeout: "I couldn't answer: I ran out of time before I finished. A shorter or narrower question may fit.",
  limit: "I couldn't answer: a budget, rate limit or safety rule stopped the call before anything was sent to a model.",
  approval: "I couldn't answer: this was held for approval, and nobody here can approve it.",
  other: "I couldn't answer: something went wrong on our side. Try again; if it keeps happening, tell a workspace admin.",
};

/** The proxy refusing the bot's own key (LiteLLM answers 401 "Invalid proxy server token" when it has lost the key). */
export function looksLikeRejectedKey(error: string | undefined): boolean {
  return error !== undefined && /invalid proxy server token|\b401\b.*(?:auth|token|key)|(?:auth|token|key).*\b401\b/i.test(error);
}

/**
 * The category of a failed run. The runtime's own word (`failure`) wins; otherwise the error text is read for the few shapes that name the model
 * gateway, a clock that ran out, or an absent runner. Reading is internal: only the category leaves this function.
 */
export function classifyFailure(error: string | undefined, failure?: 'runner_offline' | 'timeout'): FailureCategory {
  if (failure !== undefined) return failure;
  const text = error ?? '';
  if (looksLikeRejectedKey(text) || /\b(403|429|5\d\d)\b|litellm|proxy server|model gateway|rate.?limit|overloaded|api[ _-]?error|connection error/i.test(text)) return 'gateway';
  if (/timed? ?out|time limit|exceeded .*budget|was stopped \(SIG/i.test(text)) return 'timeout';
  if (/runner/i.test(text)) return 'runner_offline';
  return 'other';
}

/**
 * Say, once, in the thread the run answers in, why there is no answer. Posted as the bot through the same door as its reply — the broker is
 * asked for `messages.post` first, so a bot that was never granted it stays silent (and the log says so). The run id and the category go in the
 * message's `meta`, which is also how a second call for the same run (a retried job) finds the first and posts nothing. Never throws: a notice
 * that cannot be posted must not stop the run from closing.
 */
export async function postFailureNotice(
  ctx: PluginContext,
  tx: PluginTx,
  run: BotRunHandle,
  payload: RunPayload,
  category: FailureCategory,
  log: (line: string) => void,
): Promise<boolean> {
  const messages = ctx.providers.get<MessageProvider>('messages');
  if (!messages) {
    log(`runtime-hermes: run ${run.runId}: no failure notice posted (no message door)`);
    return false;
  }
  try {
    await tx.query('SAVEPOINT run_failure_notice');
    const said = await tx.query(
      `SELECT 1 FROM app.messages
        WHERE channel_id = $1::uuid AND thread_root_id = $2::uuid AND meta ? 'runFailure' AND meta ->> 'runId' = $3::text AND deleted_at IS NULL
        LIMIT 1`,
      [payload.channelId, payload.replyRootId, run.runId],
    );
    if (said.rows.length > 0) {
      await tx.query('RELEASE SAVEPOINT run_failure_notice');
      return false;
    }
    const body = FAILURE_NOTICE[category];
    const decision = await ctx.runs.authorize(run, 'messages.post', authorizeContext({ channelId: payload.channelId, body, threadRootId: payload.replyRootId }));
    if (!decision.allowed || decision.needsApproval) {
      log(`runtime-hermes: run ${run.runId}: no failure notice posted (${decision.allowed ? 'posting needs approval' : decision.reason})`);
      await tx.query('RELEASE SAVEPOINT run_failure_notice');
      return false;
    }
    await ctx.runs.asBot(run, (inner) =>
      messages.post(inner, { channelId: payload.channelId, body, threadRootId: payload.replyRootId, meta: { runId: run.runId, runFailure: category } }),
    );
    await tx.query('RELEASE SAVEPOINT run_failure_notice');
    return true;
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT run_failure_notice').catch(() => undefined);
    log(`runtime-hermes: run ${run.runId}: the failure notice could not be posted: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
