import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { registerTurnCapabilities } from '../src/capabilities-turns.ts';

// `tasks.release` and `tasks.describe`: the answers a bot reads when it is not the owner, and the write that only the owner reaches.
// The database is a stub answering by SQL text.

const ME = '01a16e30-0000-7000-8000-0000000000a1';
const TASK = '01a16e30-0000-7000-8000-0000000000b1';

function harness(opts: { release?: string; owns?: boolean }) {
  const sql: string[] = [];
  const handlers = new Map<string, (input: Record<string, unknown>, tx: PluginTx) => Promise<Record<string, unknown>>>();
  const id = (n: number) => `01a16e30-0000-7000-8000-0000000000c${String(n)}`;
  const card = {
    id: TASK, workspace_id: id(1), team_id: id(2), goal_id: null, title: 'Counter', description: 'count: 1', state: 'open', kind: 'other', priority: 'normal',
    owner_id: null, branch: 'bench/counter', base_sha: null, tested_sha: null, environment_id: null, board_id: null, thread_root_id: null, blocker_reason: '',
    rework_count: 0, handoff_count: 0, created_by: ME, created_at: new Date(), updated_at: new Date(), completed_at: null,
    pull_request_project: null, pull_request_number: null, pull_request_url: null, pull_request_state: null, pull_request_merge_sha: null,
  };
  const query = (text: string): Promise<{ rows: unknown[] }> => {
    sql.push(text);
    if (text.includes('app.tasks_release')) return Promise.resolve({ rows: [{ outcome: opts.release ?? 'released' }] });
    if (text.includes('app.tasks_describe')) return Promise.resolve({ rows: [{ outcome: opts.owns ? 'described' : 'not_owner' }] });
    return Promise.resolve({ rows: [card] });
  };
  const tx = { actor: { id: ME, kind: 'bot', workspaceId: 'w' }, query } as unknown as PluginTx;
  const ctx = {
    capabilities: { register: (n: string, fn: never) => handlers.set(n, fn) },
    audit: { emit: () => Promise.resolve() },
  } as unknown as PluginContext;
  registerTurnCapabilities(ctx);
  return { sql, run: (name: string, input: Record<string, unknown>) => handlers.get(name)!(input, tx) };
}

describe('tasks.release', () => {
  it('refuses a card id that is not a uuid before touching the database', async () => {
    const h = harness({});
    expect(await h.run('tasks.release', { taskId: 'counter' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(h.sql).toHaveLength(0);
  });
  it('says not_owner when the door does', async () => {
    expect(await harness({ release: 'not_owner' }).run('tasks.release', { taskId: TASK })).toMatchObject({ ok: false, code: 'not_owner' });
  });
  it('names why a finished card cannot be released', async () => {
    expect(await harness({ release: 'already_done' }).run('tasks.release', { taskId: TASK })).toMatchObject({ ok: false, code: 'already_done' });
  });
  it('answers ok when the card was released', async () => {
    expect(await harness({}).run('tasks.release', { taskId: TASK })).toMatchObject({ ok: true, released: true });
  });
});

describe('tasks.describe', () => {
  it('writes only when the caller owns the card', async () => {
    expect(await harness({ owns: false }).run('tasks.describe', { taskId: TASK, description: 'count: 2' })).toMatchObject({ ok: false, code: 'not_owner' });
    expect(await harness({ owns: true }).run('tasks.describe', { taskId: TASK, description: 'count: 2' })).toMatchObject({ ok: true });
  });
  it('refuses a description that is not text or is too long', async () => {
    const h = harness({ owns: true });
    expect(await h.run('tasks.describe', { taskId: TASK, description: 5 })).toMatchObject({ code: 'invalid_input' });
    expect(await h.run('tasks.describe', { taskId: TASK, description: 'x'.repeat(8001) })).toMatchObject({ code: 'invalid_input' });
    expect(await h.run('tasks.describe', { taskId: TASK, description: 'a\u0000b' })).toMatchObject({ code: 'invalid_input' });
  });
});
