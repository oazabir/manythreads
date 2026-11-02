import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/index.ts';
import { DECISION_DETAIL_MAX_BYTES, createRunService } from '../src/runs/index.ts';

// A decision line's detail is capped before it reaches the table (whose CHECK would refuse the whole line): a detail that does not fit becomes `{ truncated: true }`, which the
// replay reads as "not all of this was kept" (PLAN P7-07).

const service = createRunService({ pool: {} as never, systemPool: {} as never, registry: new CapabilityRegistry(), broker: {} as never, handlers: new Map() });

const keep = async (detail: Record<string, unknown>): Promise<unknown> => {
  let sent: unknown[] = [];
  const tx = {
    query: (_sql: string, params: unknown[]) => {
      sent = params;
      return Promise.resolve({ rows: [{ seq: 3 }], rowCount: 1 });
    },
  } as unknown as PluginTx;
  const seq = await service.logDecision(tx, { kind: 'tool', subject: 'files.commit', outcome: 'allowed', target: null, messageId: null, detail });
  expect(seq).toBe(3);
  return JSON.parse(sent[5] as string);
};

describe('logDecision', () => {
  it('keeps a detail that fits as it is', async () => {
    expect(await keep({ reason: 'granted', path: 'pages/a.md' })).toEqual({ reason: 'granted', path: 'pages/a.md' });
  });

  it('replaces a detail over the cap by { truncated: true } instead of letting the table refuse the whole line', async () => {
    const big = { reason: 'x'.repeat(DECISION_DETAIL_MAX_BYTES + 1) };
    expect(await keep(big)).toEqual({ truncated: true });
    // multi-byte text counts in bytes, not characters
    expect(await keep({ reason: 'é'.repeat(DECISION_DETAIL_MAX_BYTES) })).toEqual({ truncated: true });
  });

  it('keeps the cap under the table’s own 2000 byte check', () => {
    expect(DECISION_DETAIL_MAX_BYTES).toBeLessThan(2000);
  });
});
