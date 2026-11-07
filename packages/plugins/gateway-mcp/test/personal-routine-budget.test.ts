import type { BotRunHandle, PluginContext } from '@manythreads/sdk';
import { RunEndedError } from '@manythreads/sdk';
import { PERSONAL_ROUTINE_LIMITS } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { PERSONAL_ROUTINE_FREE_WRITES, personalRoutineHoldsWrite, toolBudgetSentence, toolBudgetUsed } from '../src/personal-routine.ts';

// P20-T3: the budget of tool calls of a personal routine's run (P20-14) and the two writes it may make without asking. personal-routine.test.ts has the run test, the
// held writes and the notes.

const mine = { trigger: 'routine', askerActorId: 'a1' } as unknown as BotRunHandle;
const teams = { trigger: 'routine', askerActorId: null } as unknown as BotRunHandle;
const chat = { trigger: 'mention', askerActorId: 'a1' } as unknown as BotRunHandle;

/** A context whose run has made `n` tool decisions; `asked` counts the queries made. */
function ctxWith(n: number | Error): { ctx: PluginContext; asked: { count: number } } {
  const asked = { count: 0 };
  const ctx = {
    runs: {
      asBot: async (_run: unknown, fn: (tx: { query: (sql: string) => Promise<{ rows: Array<{ n: string }> }> }) => Promise<unknown>) => {
        if (n instanceof Error) throw n;
        return fn({
          query: async (sql: string) => {
            asked.count += 1;
            expect(sql).toContain("kind = 'tool'");
            return { rows: [{ n: String(n) }] };
          },
        });
      },
    },
  } as unknown as PluginContext;
  return { ctx, asked };
}

describe('the writes a personal routine makes without asking', () => {
  it('are exactly memory.write and memory.retain', () => {
    expect([...PERSONAL_ROUTINE_FREE_WRITES].sort()).toEqual(['memory.retain', 'memory.write']);
    expect(personalRoutineHoldsWrite(mine, 'memory.retain', 'write')).toBe(false);
    // a different kind of call by the same names is not let through by the name alone
    expect(personalRoutineHoldsWrite(mine, 'memory.forget', 'write')).toBe(true);
    expect(personalRoutineHoldsWrite(mine, 'messages.post', 'write')).toBe(true);
    expect(personalRoutineHoldsWrite(mine, 'files.write', 'write')).toBe(true);
  });
});

describe('the budget of tool calls of one run', () => {
  it('is 40, said in the sentence the model reads', () => {
    expect(PERSONAL_ROUTINE_LIMITS.runToolCalls).toBe(40);
    expect(toolBudgetSentence()).toBe('This routine has used its 40 tool calls for one run. Finish with what you have and say what is left.');
  });

  it('is not counted for a run that is not a personal routine, and does not even look', async () => {
    for (const run of [teams, chat]) {
      const { ctx, asked } = ctxWith(500);
      expect(await toolBudgetUsed(ctx, run)).toBe(false);
      expect(asked.count).toBe(0);
    }
  });

  it('lets the 40th call through and turns the 41st away', async () => {
    expect(await toolBudgetUsed(ctxWith(0).ctx, mine)).toBe(false);
    expect(await toolBudgetUsed(ctxWith(39).ctx, mine)).toBe(false);
    expect(await toolBudgetUsed(ctxWith(40).ctx, mine)).toBe(true);
    expect(await toolBudgetUsed(ctxWith(41).ctx, mine)).toBe(true);
  });

  it('lets a run that ended under the count end (control flow), and does not stop a run for a count that failed', async () => {
    await expect(toolBudgetUsed(ctxWith(new RunEndedError('ended')).ctx, mine)).rejects.toBeInstanceOf(RunEndedError);
    expect(await toolBudgetUsed(ctxWith(new Error('database is busy')).ctx, mine)).toBe(false);
  });
});
