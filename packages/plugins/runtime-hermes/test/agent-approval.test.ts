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

describe('a wait that the Stop ends (M3)', () => {
  const setup = (status: 'pending' | 'approved' = 'pending') => {
    const withdrawn: Array<{ id: string; botId: string }> = [];
    const approvals = {
      request: async () => ({ approvalId: 'a1' }),
      answerOf: async () => ({ status, note: 'ok', deciderName: 'Rafi' }),
      claim: async () => null,
      withdraw: vi.fn(async (_tx: unknown, id: string, by: { botId: string }) => (withdrawn.push({ id, botId: by.botId }), true)),
    } as unknown as ApprovalProvider;
    const ctx = { providers: { get: () => approvals }, runs: { asBot: async (_r: unknown, fn: (tx: unknown) => unknown) => fn({}), extend: async () => true } } as unknown as PluginContext;
    const warns: string[] = [];
    const job = { log: { info: () => undefined, warn: (m: string) => warns.push(m) }, transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn({}) };
    const answer = vi.fn(async () => true);
    const question: Question = { type: 'approval', command: 'rm x', description: 'why', choices: ['once', 'deny'], answer };
    const run = { runId: 'r1', workspaceId: 'w1', botId: 'b1' } as unknown as BotRunHandle;
    return { approvals, ctx, job, answer, question, run, withdrawn, warns };
  };

  it('ends as "ended": the program is not answered (no false "denied"), and the card is withdrawn for the run\'s bot', async () => {
    const s = setup();
    let stopped = false;
    setTimeout(() => (stopped = true), 50);
    const told = await settleAgentApproval({ ctx: s.ctx, job: s.job as never, run: s.run, question: s.question, approvers: ['p1'], pollMs: 20, waitMs: 5000, stopped: () => stopped });
    expect(told).toBe('ended');
    expect(s.answer).not.toHaveBeenCalled();
    expect(s.withdrawn).toEqual([{ id: 'a1', botId: 'b1' }]);
  });

  it('a Stop that was already asked while the question was being filed ends at once', async () => {
    const s = setup();
    const told = await settleAgentApproval({ ctx: s.ctx, job: s.job as never, run: s.run, question: s.question, approvers: ['p1'], pollMs: 20, waitMs: 5000, stopped: () => true });
    expect(told).toBe('ended');
    expect(s.withdrawn).toHaveLength(1);
  });

  it('a person who had already approved is still answered: the Stop does not undo a decision that came first', async () => {
    const s = setup('approved');
    const told = await settleAgentApproval({ ctx: s.ctx, job: s.job as never, run: s.run, question: s.question, approvers: ['p1'], pollMs: 20, waitMs: 5000, stopped: () => false });
    expect(told).toBe('once');
    expect(s.withdrawn).toEqual([]);
  });

  it('a withdraw that fails is logged and the run still ends', async () => {
    const s = setup();
    (s.approvals.withdraw as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));
    const told = await settleAgentApproval({ ctx: s.ctx, job: s.job as never, run: s.run, question: s.question, approvers: ['p1'], pollMs: 20, waitMs: 5000, stopped: () => true });
    expect(told).toBe('ended');
    expect(s.warns.some((w) => w.includes('could not be withdrawn'))).toBe(true);
  });
});
