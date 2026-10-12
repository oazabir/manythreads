import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { EXECUTE_QUEUE, registerResumeJob } from '../src/resume.ts';

// The execute job without a database: what it records when something after the call fails. The call may be an email; once it has been made,
// nothing that goes wrong afterwards (closing the run, say) may turn "it ran" into "it failed".

const APPROVAL = '01a12f92-3e2a-78fd-88fd-5762c95a772b';
const ROW = {
  id: APPROVAL,
  workspace_id: '00000000-0000-7000-8000-00000000a001',
  team_id: '00000000-0000-7000-8000-0000000b0001',
  source: 'grant',
  tool: 'pages.write',
  bot_id: '01a12f92-0000-7000-8000-000000000001',
  requester_id: '00000000-0000-7000-8000-0000000d0002',
  requester_kind: 'person',
  channel_id: null,
  channel_private: false,
  thread_root_id: null,
  resume: { kind: 'tool', capability: 'pages.write', args: { path: 'pages/x.md' }, trigger: 'mention' },
};

function harness(closeFails: boolean) {
  const handlers = new Map<string, (payload: Record<string, unknown>, tx: PluginTx, job: { jobId: string; attempt: number; workerId: string; log: { info(m: string): void; warn(m: string): void } }) => Promise<void>>();
  const updates: Array<{ outcome: unknown; detail: unknown }> = [];
  const warnings: string[] = [];
  const events: unknown[] = [];
  const tx = {
    actor: { kind: 'system', id: 'x', workspaceId: ROW.workspace_id },
    query: (text: string, values: readonly unknown[] = []) => {
      if (/FROM app\.approvals a JOIN app\.actors ra/.test(text)) return Promise.resolve({ rows: [ROW] });
      if (/SET outcome = \$2, outcome_detail = \$3/.test(text)) {
        updates.push({ outcome: values[1], detail: values[2] });
        return Promise.resolve({ rows: [{ id: APPROVAL }] });
      }
      if (/approvals_audience/.test(text)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    },
  } as unknown as PluginTx;
  const run = { runId: 'run-1', botId: ROW.bot_id, botActorId: 'a', teamId: ROW.team_id, workspaceId: ROW.workspace_id, trigger: 'mention', askerActorId: null, expiresAt: '' };
  const ctx = {
    jobs: { register: (queue: string, handler: never) => void handlers.set(queue, handler), enqueue: () => Promise.resolve('job') },
    runs: {
      open: () => Promise.resolve({ run, token: 't' }),
      authorize: () => Promise.resolve({ allowed: true, reason: 'granted', needsApproval: true }),
      asApproved: (_run: unknown, _capability: string, fn: (t: PluginTx) => Promise<unknown>) => fn(tx),
      invoke: () => Promise.resolve({ ok: true }),
      close: () => (closeFails ? Promise.reject(new Error('database went away')) : Promise.resolve(true)),
    },
    audit: { emit: (_tx: unknown, event: unknown) => (events.push(event), Promise.resolve()) },
    realtime: { pushToPeople: () => Promise.resolve() },
  } as unknown as PluginContext;
  registerResumeJob(ctx);
  const execute = handlers.get(EXECUTE_QUEUE)!;
  const job = (attempt: number) => ({ jobId: 'j', attempt, workerId: 'w', log: { info: () => undefined, warn: (m: string) => void warnings.push(m) } });
  return { execute: (attempt = 1) => execute({ approvalId: APPROVAL }, tx, job(attempt)), updates, warnings, events };
}

describe('approvals.execute', () => {
  it('records "ran" and logs the failure when closing the run fails after the call was made', async () => {
    const h = harness(true);
    await h.execute();
    expect(h.updates).toEqual([{ outcome: 'ran', detail: 'Ran as the bot after approval.' }]);
    expect(h.warnings.join('\n')).toContain('could not be closed');
    expect(h.events).toHaveLength(1);
  });

  it('records "ran" when nothing fails', async () => {
    const h = harness(false);
    await h.execute();
    expect(h.updates).toEqual([{ outcome: 'ran', detail: 'Ran as the bot after approval.' }]);
  });

  it('does not make the call on a second attempt, whatever the first did', async () => {
    const h = harness(false);
    await h.execute(2);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]!.outcome).toBe('failed');
    expect(String(h.updates[0]!.detail)).toContain('interrupted');
  });
});
