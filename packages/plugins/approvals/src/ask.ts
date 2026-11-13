import { createHash } from 'node:crypto';
import { NoEligibleApproverError, type ApprovalProvider, type PluginContext } from '@manythreads/sdk';
import { previewArgsDetailed } from '@manythreads/shared';

/*
 * `approvals.ask` (P24-03): the one tool every bot has, whatever runtime runs it (Hermes, Claude, Codex…), for "I need a person to say yes or no before I go on".
 * It files an approval of source `agent` — the card in the thread and the line in the team's Approvals — and answers at once; the bot ends its turn. When a person
 * decides, the runtime wakes the bot in the same thread with the answer (the decided event; runtime-hermes `registerAskAnswer`). The bot is never left waiting on a
 * prompt of its own program that nothing shows to anyone.
 */

export const ASK_TOOL = 'approvals.ask';

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export function registerAsk(ctx: PluginContext, approvals: ApprovalProvider): void {
  ctx.capabilities.register(ASK_TOOL, async (input, tx) => {
    const question = typeof input['question'] === 'string' ? input['question'].replace(/\s+/g, ' ').trim() : '';
    const details = typeof input['details'] === 'string' ? input['details'].trim() : '';
    if (question.length < 3) return { ok: false, code: 'invalid_input', message: 'question: say, in one sentence, what you need a person to decide.' };
    // the run the call was made in: the transaction carries it (`app.run_id()`), so a bot cannot name another run
    const runId = (await tx.query<{ id: string | null }>('SELECT app.run_id()::text AS id')).rows[0]?.id ?? null;
    if (!runId) return { ok: false, code: 'no_open_run', message: 'Asking works only while you are answering a message.' };
    const { preview, truncated } = previewArgsDetailed({ question, ...(details === '' ? {} : { details }) });
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
