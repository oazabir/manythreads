import type { ChannelId, GetThreadTodoResponse, MessageId, ThreadTodo } from '@manythreads/shared';
import { describe, expect, it, vi } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { fetchThreadTodo } from '../src/todo/api';
import { ThreadTodoStore } from '../src/todo/threadTodo';

// The data layer of a thread's to-do list (P25-10): read on open, re-read when a push names a newer version, never an older list brought back, nothing read for a closed thread.

const ROOT = '00000000-0000-7000-8000-0000000e0001' as MessageId;
const OTHER = '00000000-0000-7000-8000-0000000e0002' as MessageId;
const CH = '00000000-0000-7000-8000-0000000f0001' as ChannelId;

const todo = (version: number, over: Partial<ThreadTodo> = {}): ThreadTodo => ({
  rootId: ROOT,
  channelId: CH,
  messageId: null,
  botActorId: '00000000-0000-7000-8000-000000b00001' as ThreadTodo['botActorId'],
  title: 'Plan',
  items: [{ id: 'a', text: 'Write the test', status: 'waiting' }],
  version,
  updatedAt: '2026-11-14T10:00:00.000Z',
  ...over,
});
const push = (rootId: string, version: number) => ({ type: 'todo.changed', id: `p${version}`, payload: { channelId: CH, rootId, version } });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function make(answers: Array<GetThreadTodoResponse | Promise<GetThreadTodoResponse>>) {
  const read = vi.fn(async (_rootId: string) => {
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next;
  });
  return { store: new ThreadTodoStore({ read }), read };
}

describe('reading the list', () => {
  it('reads when a panel opens, and a second panel of the same thread does not read again', async () => {
    const { store, read } = make([{ todo: todo(1) }]);
    expect(store.stateOf(ROOT)).toEqual({ loaded: false, todo: null });
    const close1 = store.open(ROOT);
    const close2 = store.open(ROOT);
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    expect(store.stateOf(ROOT)).toMatchObject({ loaded: true, todo: { version: 1 } });
    close1();
    expect(store.stateOf(ROOT).loaded).toBe(true);
    close2();
    expect(store.stateOf(ROOT).loaded).toBe(false);
  });

  it('a thread with no list is loaded with null, and listeners hear each change', async () => {
    const { store } = make([{ todo: null }]);
    const heard = vi.fn();
    store.subscribe(ROOT, heard);
    store.open(ROOT);
    await flush();
    expect(store.stateOf(ROOT)).toEqual({ loaded: true, todo: null });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a failed read leaves the list as it was', async () => {
    const { store } = make([{ todo: todo(2) }]);
    store.open(ROOT);
    await flush();
    store.handlePush(push(ROOT, 3));
    await flush();
    expect(store.stateOf(ROOT).todo?.version).toBe(2);
  });
});

describe('the push', () => {
  it('a newer version reads the list again, the same or an older one does not', async () => {
    const { store, read } = make([{ todo: todo(1) }, { todo: todo(2, { title: 'Plan, changed' }) }]);
    store.open(ROOT);
    await flush();
    store.handlePush(push(ROOT, 1));
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    store.handlePush(push(ROOT, 2));
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).todo?.title).toBe('Plan, changed');
  });

  it('ignores another thread, another kind of push, a closed thread and nonsense', async () => {
    const { store, read } = make([{ todo: todo(1) }]);
    store.open(ROOT);
    await flush();
    store.handlePush(push(OTHER, 5));
    store.handlePush({ type: 'run.started', id: 'x', payload: { channelId: CH, rootId: ROOT, version: 9 } });
    store.handlePush({ type: 'todo.changed', id: 'y', payload: { rootId: 'not-an-id', version: 'x' } });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a read that finishes late never brings an older list back', async () => {
    let releaseSlow: (r: GetThreadTodoResponse) => void = () => undefined;
    const slow = new Promise<GetThreadTodoResponse>((res) => {
      releaseSlow = res;
    });
    // first read (open) is slow and will carry version 1; the push names 2 while it is in flight, so a second read follows it
    const { store, read } = make([slow, { todo: todo(2, { title: 'Newest' }) }]);
    store.open(ROOT);
    store.handlePush(push(ROOT, 2));
    expect(read).toHaveBeenCalledTimes(1);
    releaseSlow({ todo: todo(1, { title: 'Old' }) });
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).todo).toMatchObject({ version: 2, title: 'Newest' });
  });

  it('a list the person may not read ends in null without reading forever', async () => {
    // the push came during the open's read: one more read follows, and that one's null ends it
    const { store, read } = make([{ todo: null }, { todo: null }]);
    store.open(ROOT);
    store.handlePush(push(ROOT, 4));
    await flush();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(store.stateOf(ROOT).todo).toBeNull();
  });
});

describe('a reconnect', () => {
  it('reads every open thread again', async () => {
    const { store, read } = make([{ todo: todo(1) }, { todo: todo(1, { rootId: OTHER }) }, { todo: todo(2) }, { todo: todo(3, { rootId: OTHER }) }]);
    store.open(ROOT);
    await flush();
    store.open(OTHER);
    await flush();
    store.resync();
    await flush();
    expect(read).toHaveBeenCalledTimes(4);
    expect(store.stateOf(ROOT).todo?.version).toBe(2);
    expect(store.stateOf(OTHER).todo?.version).toBe(3);
  });
});

describe('the call reaches the route the tasks plugin mounts', () => {
  it('GET /api/threads/:rootId/todo, parsed with the shared schema', async () => {
    const seen: TransportRequest[] = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 200, body: { todo: todo(1) } };
    });
    const res = await fetchThreadTodo(ROOT);
    expect(seen.at(-1)).toMatchObject({ method: 'GET', url: `/api/threads/${ROOT}/todo` });
    expect(res.todo?.items[0]?.text).toBe('Write the test');
  });
});
