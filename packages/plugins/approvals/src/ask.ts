import { createHash } from 'node:crypto';
import { NoEligibleApproverError, type ApprovalProvider, type PluginContext } from '@manythreads/sdk';

/*
 * `approvals.ask` (P24-03): the one tool every bot has, whatever runtime runs it (Hermes, Claude, Codex…), for "I need a person to say yes or no before I go on".
 * It files an approval of source `agent` — the card in the thread and the line in the team's Approvals — and answers at once; the bot ends its turn. When a person
 * decides, the runtime wakes the bot in the same thread with the answer (the decided event; runtime-hermes `registerAskAnswer`). The bot is never left waiting on a
 * prompt of its own program that nothing shows to anyone.
 */

export const ASK_TOOL = 'approvals.ask';

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * What a person reads of an ask is the whole of it: the question and its details are stored in the approval's preview as the bot wrote them (line breaks kept), up to these
 * bounds, not at the 300 characters the generic call preview keeps. The list line (`summary`) is still one short line. A bot that writes more than this is clipped with a "…",
 * and the card says the end is not kept (there is no longer copy to open: an ask stores no call).
 */
export const ASK_QUESTION_MAX = 4_000;
export const ASK_DETAILS_MAX = 20_000;
const tidy = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

export function registerAsk(ctx: PluginContext, approvals: ApprovalProvider): void {
  ctx.capabilities.register(ASK_TOOL, async (input, tx) => {
    const askedQuestion = typeof input['question'] === 'string' ? tidy(input['question']) : '';
    const askedDetails = typeof input['details'] === 'string' ? tidy(input['details']) : '';
    // the one-line form the list and the dedupe key use
    const question = askedQuestion.replace(/\s+/g, ' ');
    const details = askedDetails;
    if (question.length < 3) return { ok: false, code: 'invalid_input', message: 'question: say, in one sentence, what you need a person to decide.' };
    // the run the call was made in: the transaction carries it (`app.run_id()`), so a bot cannot name another run
    const runId = (await tx.query<{ id: string | null }>('SELECT app.run_id()::text AS id')).rows[0]?.id ?? null;
    if (!runId) return { ok: false, code: 'no_open_run', message: 'Asking works only while you are answering a message.' };
    const truncated = askedQuestion.length > ASK_QUESTION_MAX || details.length > ASK_DETAILS_MAX;
    const preview = { question: clip(askedQuestion, ASK_QUESTION_MAX), ...(details === '' ? {} : { details: clip(details, ASK_DETAILS_MAX) }) };
    try {
      const filed = await approvals.request(tx, {
        runId,
        source: 'agent',
        tool: ASK_TOOL,
        summary: clip(question, 300),
        argsPreview: preview,
        argsTruncated: truncated,
        resume: { kind: 'handoff', payload: { kind: 'ask', runId } },
        dedupeKey: `ask:${createHash('sha256').update(question).digest('hex').slice(0, 24)}`,
      });
      const where = filed.visibleTo === 'conversation' ? 'to the people who can read this conversation' : 'to the team’s Approvals and to this thread';
      return {
        ok: true,
        approvalId: filed.approvalId,
        message: `Asked ${where}. Do not wait and do not ask again: end your turn now with one short line saying what you are waiting for. When a person answers, you are woken in this thread with the answer (yes or no, and what they wrote).`,
      };
    } catch (err) {
      if (err instanceof NoEligibleApproverError) return { ok: false, code: 'no_approver', message: err.message };
      throw err;
    }
  });
}
