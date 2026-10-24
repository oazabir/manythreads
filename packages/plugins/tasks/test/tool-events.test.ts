import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerCapabilities } from '../src/capabilities.ts';

// The `tasks.handoff` and `tasks.complete` tools write the same events as the routes (so the bot router hears a handover made by a tool),
// and a handover by tool posts the card message in the thread. The database is a stub that answers by the SQL it is asked: what is under
// test is the order and the content of what the tool does after the door answers.

const ids = {
  task: '01a16e30-0000-7000-8000-000000000001',
  ws: '01a16e30-0000-7000-8000-000000000002',
  team: '01a16e30-0000-7000-8000-000000000003',
  from: '01a16e30-0000-7000-8000-000000000004',
  to: '01a16e30-0000-7000-8000-000000000005',
  handoff: '01a16e30-0000-7000-8000-000000000006',
  channel: '01a16e30-0000-7000-8000-000000000007',
  message: '01a16e30-0000-7000-8000-000000000008',
};

const taskRow = (owner: string, state: string) => ({
  id: ids.task, workspace_id: ids.ws, team_id: ids.team, goal_id: null, title: 'Fix the rota', description: '', state, kind: 'other', priority: 'normal',
  owner_id: owner, branch: 'fix/rota', base_sha: null, tested_sha: null, environment_id: null, thread_root_id: null, blocker_reason: '', rework_count: 0,
  handoff_count: 0, created_by: ids.from, created_at: new Date(), updated_at: new Date(), completed_at: null,
});

function harness(kind: 'handoff' | 'complete', denyPost = false) {
  const log: string[] = [];
  const authorized: string[] = [];
  const emitted: { type: string }[] = [];
  const posted: { channelId: string; body: string; threadRootId?: string | null; meta?: unknown }[] = [];
  let moved = false;
  const handlers = new Map<string, (input: Record<string, unknown>, tx: PluginTx) => Promise<unknown>>();
  const query = (sql: string): Promise<{ rows: unknown[] }> => {
    log.push(sql.replace(/\s+/g, ' ').slice(0, 60));
    const rows = (r: unknown[]) => Promise.resolve({ rows: r });
    if (sql.includes('FROM app.tasks t')) return rows([taskRow(moved ? ids.to : ids.from, moved ? 'in_progress' : 'in_progress')]);
    if (sql.includes('app.tasks_handoff(')) { moved = true; return rows([{ o_outcome: 'moved', o_handoff_id: ids.handoff, o_reason: '' }]); }
    if (sql.includes('app.tasks_complete(')) { moved = true; return rows([{ o_outcome: 'done', o_reason: '' }]); }
    if (sql.includes('FROM app.handoffs WHERE id')) {
      return rows([{ id: ids.handoff, task_id: ids.task, team_id: ids.team, from_actor_id: ids.from, to_actor_id: ids.to, mode: 'bot', note: 'build it', approval_id: null, applied_at: new Date(), created_at: new Date() }]);
    }
    if (sql.includes('FROM app.capability_grants')) return rows([{ constraints: { mayTag: ['coder'] } }]);
    if (sql.includes('FROM app.actors WHERE id')) return rows([{ kind: 'bot' }]);
    if (sql.includes('app.tasks_actor_of')) return rows([{ kind: 'bot', ref_id: '01a16e30-0000-7000-8000-0000000000aa', name: 'Coder' }]);
    if (sql.includes('FROM app.bots WHERE id')) return rows([{ slug: 'coder' }]);
    if (sql.includes('FROM app.channels c')) return rows([{ id: ids.channel }]);
    return rows([]);
  };
  const tx = { actor: { id: ids.from, kind: 'bot', workspaceId: ids.ws }, query } as unknown as PluginTx;
  const ctx = {
    capabilities: {
      register: (name: string, fn: never) => handlers.set(name, fn),
      authorize: (_tx: PluginTx, capability: string) => { authorized.push(capability); return Promise.resolve({ allowed: !denyPost, needsApproval: false, reason: '' }); },
    },
    audit: { emit: (_tx: PluginTx, event: { type: string }) => { emitted.push(event); return Promise.resolve(); } },
    providers: {
      get: (name: string) =>
        name === 'messages' ? { post: (_tx: PluginTx, input: { channelId: string; body: string }) => { posted.push(input); return Promise.resolve({ id: ids.message }); } } : undefined,
    },
  } as unknown as PluginContext;
  registerCapabilities(ctx);
  const run = () =>
    kind === 'handoff' ? handlers.get('tasks.handoff')!({ taskId: ids.task, toActorId: ids.to, note: 'build it' }, tx) : handlers.get('tasks.complete')!({ taskId: ids.task }, tx);
  return { run, log, emitted, posted, authorized };
}

describe('tasks.* tools write the route events', () => {
  it('tasks.handoff emits handed_off then updated, and announces the handover in the card thread', async () => {
    const h = harness('handoff');
    expect(await h.run()).toMatchObject({ ok: true, taskId: ids.task, handoffId: ids.handoff });
    expect(h.emitted.map((e) => e.type)).toEqual(['tasks.task.handed_off', 'tasks.task.updated']);
    expect(h.emitted[0]).toMatchObject({ handoffId: ids.handoff, fromActorId: ids.from, toActorId: ids.to, note: 'build it' });
    expect(h.authorized).toEqual(['messages.post']);
    expect(h.posted).toEqual([{ channelId: ids.channel, body: 'Coder → @coder: build it', threadRootId: null, meta: { handoff: { taskId: ids.task } } }]);
    expect(h.log.some((l) => l.includes('app.tasks_record_card'))).toBe(true);
  });

  it('a bot without messages.post still hands the card over, posts nothing, and the history says why', async () => {
    const h = harness('handoff', true);
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.emitted.map((e) => e.type)).toEqual(['tasks.task.handed_off', 'tasks.task.updated']);
    expect(h.posted).toEqual([]);
    expect(h.log.some((l) => l.includes('app.tasks_note_event'))).toBe(true);
  });

  it('tasks.complete emits completed then updated', async () => {
    const h = harness('complete');
    expect(await h.run()).toMatchObject({ ok: true });
    expect(h.emitted.map((e) => e.type)).toEqual(['tasks.task.completed', 'tasks.task.updated']);
  });
});
