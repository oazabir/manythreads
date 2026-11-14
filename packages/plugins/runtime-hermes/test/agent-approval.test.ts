import type { ApprovalProvider, BotRunHandle, BotRuntimeEvent, PluginContext } from '@manythreads/sdk';
import { describe, expect, it, vi } from 'vitest';
import { commandSummary, settleAgentApproval } from '../src/agent-approval.ts';

vi.mock('../src/holds.ts', () => ({ previewText: async (_ctx: unknown, _tx: unknown, _ws: string, text: string) => text }));

type Question = Extract<BotRuntimeEvent, { type: 'approval' }>;

describe('the summary of a question the program asks', () => {
  it('says a command for a command and a plan for a plan, with the first line only', () => {
    expect(commandSummary('touch a\ntouch b')).toBe('Run a command: touch a');
    expect(commandSummary('1. Do this\n2. Do that', 'switch_mode')).toBe('Approve a plan: 1. Do this');
  });
});

describe('a wait the program ended by itself', () => {
  it('stops waiting at the next look and refuses, without telling the program anything', async () => {
    const filed: Array<Record<string, unknown>> = [];
    const approvals = {
      request: async (_tx: unknown, input: Record<string, unknown>) => (filed.push(input), { approvalId: 'a1' }),
      answerOf: async () => ({ status: 'pending', note: '', deciderName: null }),
      claim: async () => null,
    } as unknown as ApprovalProvider;
    const ctx = {
      providers: { get: () => approvals },
      runs: { asBot: async (_run: unknown, fn: (tx: unknown) => unknown) => fn({}), extend: async () => true },
    } as unknown as PluginContext;
    const job = { log: { info: () => undefined, warn: () => undefined }, transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}) };
    let gone: string | null = null;
    const answer = vi.fn(async () => true);
    const question: Question = { type: 'approval', command: 'a'.repeat(2000), description: 'why', choices: ['once', 'deny'], expired: () => gone, answer };
    setTimeout(() => (gone = 'Nobody answered in time.'), 60);
    const told = await settleAgentApproval({ ctx, job: job as never, run: { runId: 'r1', workspaceId: 'w1', botId: 'b1' } as unknown as BotRunHandle, question, approvers: ['p1'], pollMs: 20, waitMs: 5000 });
    expect(told).toBe('deny');
    expect(answer).not.toHaveBeenCalled();
    // the card keeps a command of about 2000 characters whole, one cut mark past that
    expect((filed[0]!['argsPreview'] as { command: string }).command).toHaveLength(2000);
    expect(filed[0]!['argsTruncated']).toBe(false);
  });
});
