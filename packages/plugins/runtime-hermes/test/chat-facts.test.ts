import type { PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { recordRunFacts, recordStopped } from '../src/chat-run.ts';
import { RunPayload } from '../src/run-job.ts';

// The two facts a conversation run writes on its own row for the conversations plugin to read (PLAN P20-16, P20-T4): which message it answers and which model
// answered, and that the asker pressed Stop. Anything that is not a person's conversation run writes nothing.

const RUN = '00000000-0000-7000-8000-0000000c0001';
const MESSAGE = '00000000-0000-7000-8000-000000000004';

const payload = (over: Record<string, unknown> = {}): RunPayload =>
  RunPayload.parse({
    workspaceId: '00000000-0000-7000-8000-00000000a001',
    botId: '00000000-0000-7000-8000-000000000001',
    teamId: '00000000-0000-7000-8000-0000000b0001',
    channelId: '00000000-0000-7000-8000-000000000002',
    trigger: 'conversation',
    askerActorId: '00000000-0000-7000-8000-0000000d0001',
    replyRootId: '00000000-0000-7000-8000-000000000003',
    runThreadId: null,
    prompt: 'hello',
    messageId: MESSAGE,
    ...over,
  });

function recorder(): { tx: PluginTx; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tx = { query: async (sql: string, params: unknown[]): Promise<{ rows: [] }> => { calls.push({ sql, params }); return { rows: [] }; } } as unknown as PluginTx;
  return { tx, calls };
}

describe('recordRunFacts', () => {
  it('files the message the run answers and the model that answered on the run’s row', async () => {
    const { tx, calls } = recorder();
    await recordRunFacts(tx, RUN, payload(), 'fast');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/UPDATE app\.bot_runs SET turn_message_id = \$2::uuid, model_alias = \$3 WHERE id = \$1::uuid/);
    expect(calls[0]?.params).toEqual([RUN, MESSAGE, 'fast']);
  });

  it('files no model when the run had none to name', async () => {
    const { tx, calls } = recorder();
    await recordRunFacts(tx, RUN, payload(), null);
    expect(calls[0]?.params).toEqual([RUN, MESSAGE, null]);
  });

  it('writes nothing for a run that is not a conversation run, or that has no message', async () => {
    const { tx, calls } = recorder();
    await recordRunFacts(tx, RUN, payload({ trigger: 'mention' }), 'fast');
    await recordRunFacts(tx, RUN, payload({ messageId: undefined }), 'fast');
    expect(calls).toHaveLength(0);
  });
});

describe('recordStopped', () => {
  it('marks the run as stopped by its asker', async () => {
    const { tx, calls } = recorder();
    await recordStopped(tx, RUN);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/SET stopped_by_asker = true WHERE id = \$1::uuid/);
    expect(calls[0]?.params).toEqual([RUN]);
  });
});
