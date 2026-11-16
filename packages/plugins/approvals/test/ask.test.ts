import type { ApprovalProvider, PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { ASK_DETAILS_MAX, ASK_QUESTION_MAX, ASK_TOOL, registerAsk } from '../src/ask.ts';

// P29-05: what a bot's `approvals.ask` stores is the whole question and the whole context, not the 300-character preview of a generic call.

type Handler = (input: Record<string, unknown>, tx: unknown) => Promise<Record<string, unknown>>;
type Filed = { summary: string; argsPreview: Record<string, unknown>; argsTruncated: boolean; resume: unknown };

function setup(): { ask: (input: Record<string, unknown>) => Promise<Record<string, unknown>>; filed: Filed[] } {
  let handler: Handler | null = null;
  const filed: Filed[] = [];
  const ctx = { capabilities: { register: (name: string, fn: Handler) => (name === ASK_TOOL ? (handler = fn) : undefined) } } as unknown as PluginContext;
  const approvals = {
    request: (_tx: unknown, input: Filed) => {
      filed.push(input);
      return Promise.resolve({ approvalId: 'a1', created: true, visibleTo: 'team' });
    },
  } as unknown as ApprovalProvider;
  registerAsk(ctx, approvals);
  const tx = { query: () => Promise.resolve({ rows: [{ id: 'run-1' }] }) };
  return { ask: (input) => handler!(input, tx), filed };
}

describe('approvals.ask keeps the whole question', () => {
  it('stores a long question and a long context unclipped, line breaks kept, and one short line for the list', async () => {
    const { ask, filed } = setup();
    const question = `Can the platform owner resolve the preview secret-read permission?\n${'The deployer needs read access to the preview secret. '.repeat(20)}`;
    const details = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: some context for the person who decides`).join('\n');
    const res = await ask({ question, details });
    expect(res['ok']).toBe(true);
    const f = filed[0]!;
    expect(f.argsPreview['question']).toBe(question.trim());
    expect(f.argsPreview['details']).toBe(details);
    expect((f.argsPreview['details'] as string).split('\n')).toHaveLength(40);
    expect(f.argsTruncated).toBe(false);
    expect(f.summary.length).toBeLessThanOrEqual(300);
    expect(f.summary).not.toContain('\n');
  });

  it('clips only past the bounds, and says so', async () => {
    const { ask, filed } = setup();
    await ask({ question: 'Is this fine?', details: 'x'.repeat(ASK_DETAILS_MAX + 50) });
    expect(filed[0]!.argsTruncated).toBe(true);
    expect((filed[0]!.argsPreview['details'] as string).length).toBe(ASK_DETAILS_MAX);
    await ask({ question: 'q'.repeat(ASK_QUESTION_MAX + 10) });
    expect(filed[1]!.argsTruncated).toBe(true);
  });

  it('still refuses a question of fewer than three characters', async () => {
    const { ask, filed } = setup();
    expect((await ask({ question: 'a' }))['ok']).toBe(false);
    expect(filed).toHaveLength(0);
  });
});
