import type { BotRunHandle, PluginContext } from '@manythreads/sdk';
import { PERSONAL_ROUTINE_LIMITS } from '@manythreads/shared';
import { RunEndedError } from '@manythreads/sdk';

// The guards of a person's own routine at the tool door (PLAN P20-14). A personal routine is a run with the `routine` trigger and a person for its asker (a team's schedule
// has none), so the run's own row says what it is; nothing a model sends can change that. Two rules, both at the one door every tool call passes:
//
//  * It may keep notes (`memory.write`, `memory.retain`), and every other write waits for its owner's approval, like a grant flagged `needsApproval`: a routine nobody
//    is watching never sends, posts or changes something on its own.
//  * It has a budget of tool calls (`PERSONAL_ROUTINE_LIMITS.runToolCalls`), counted from the run's own decision lines; the call past the budget is refused with a plain
//    sentence and the run ends with what it has.

/** The writes a personal routine may make without anyone saying yes: the memory tools, which the product treats as the bot taking notes for its asker. */
export const PERSONAL_ROUTINE_FREE_WRITES: ReadonlySet<string> = new Set(['memory.write', 'memory.retain']);

/** True for a run that a person's own routine started: the routine trigger with a person asking. */
export const isPersonalRoutineRun = (run: Pick<BotRunHandle, 'trigger' | 'askerActorId'>): boolean => run.trigger === 'routine' && run.askerActorId !== null;

/** True when this write must wait for the owner of the routine. */
export const personalRoutineHoldsWrite = (run: Pick<BotRunHandle, 'trigger' | 'askerActorId'>, tool: string, kind: string): boolean =>
  isPersonalRoutineRun(run) && kind === 'write' && !PERSONAL_ROUTINE_FREE_WRITES.has(tool);

/** The refusal sentence when the budget is used up. */
export const toolBudgetSentence = (): string =>
  `This routine has used its ${PERSONAL_ROUTINE_LIMITS.runToolCalls} tool calls for one run. Finish with what you have and say what is left.`;

/**
 * True when the run has already made its budget of tool calls. Counted from the run's decision lines of kind `tool` (one per call that reached the door). Fails open on
 * a read error: the budget is a cost guard and the monthly allowance still stands behind it.
 */
export async function toolBudgetUsed(ctx: PluginContext, run: BotRunHandle): Promise<boolean> {
  if (!isPersonalRoutineRun(run)) return false;
  try {
    const n = await ctx.runs.asBot(run, async (tx) => Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM app.run_decisions WHERE run_id = app.run_id() AND kind = 'tool'")).rows[0]?.n ?? 0));
    return n >= PERSONAL_ROUTINE_LIMITS.runToolCalls;
  } catch (err) {
    if (err instanceof RunEndedError) throw err;
    return false;
  }
}
