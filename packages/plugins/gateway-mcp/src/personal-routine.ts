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

/**
 * A personal routine's `memory.write` goes into its owner's own Memory whatever the model asks for: the default target is the team's bundle, which every member reads,
 * and the run has read the owner's private space. Any other call is returned as it came.
 */
export const forcePersonalNotes = (run: Pick<BotRunHandle, 'trigger' | 'askerActorId'>, tool: string, input: Record<string, unknown>): Record<string, unknown> =>
  isPersonalRoutineRun(run) && tool === 'memory.write' ? { ...input, target: 'personal' } : input;

/**
 * Tools a personal routine's run is never offered. `answer.post` finishes a reply in a conversation; a routine's reply is the file it writes, so the call has nowhere to go
 * (as a write it would also wait for an owner who is the only person who could approve it, and the model then wrote that complaint into the output file).
 */
export const PERSONAL_ROUTINE_HIDDEN_TOOLS: ReadonlySet<string> = new Set(['answer.post']);

/** True when this tool is not offered to this run, and a call to it is turned away. */
export const personalRoutineHidesTool = (run: Pick<BotRunHandle, 'trigger' | 'askerActorId'>, tool: string): boolean =>
  isPersonalRoutineRun(run) && PERSONAL_ROUTINE_HIDDEN_TOOLS.has(tool);

/** What the model reads when it calls a hidden tool anyway: say what to do instead, so the run carries on and the output stays clean. */
export const hiddenToolSentence = (tool: string): string =>
  `“${tool}” is not used in a routine. Your final reply is the output: write the content of the file as your reply, with no note about tools or approvals, and finish.`;

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
