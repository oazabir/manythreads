import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport, type TransportRequest } from '../src/api/client';
import { REFRESH_EVERY_MS, SidebarPrefsStore } from '../src/shell/sidebarPrefsStore';

// The store behind the personal sidebar (P14-15): loads once (and again after a failure), shows a change at once, sends changes in order,
// undoes one the server refuses, and never lets an old answer overwrite a newer state.

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SAVED = { starred: [uuid(1)], sort: 'name', hideIdle: true, groupOrder: [] };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

type Reply = { status: number; body: unknown };
let seen: TransportRequest[];
let answer: (req: TransportRequest) => Reply | Promise<Reply>;
const putBody = (req: TransportRequest): Record<string, unknown> => JSON.parse(req.body ?? '{}') as Record<string, unknown>;
const merge = (req: TransportRequest): Reply => {
  const b = putBody(req) as { starAdd?: string[]; starRemove?: string[] };
  const starred = [...SAVED.starred.filter((id) => !(b.starRemove ?? []).includes(id)), ...(b.starAdd ?? [])];
  const { starAdd, starRemove, ...rest } = b;
  void starAdd;
  void starRemove;
  return { status: 200, body: { ...SAVED, ...rest, starred } };
};
/** A reply the test lets go of when it wants. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
const refusal = { status: 400, body: { error: { code: 'validation_failed', message: 'Only a channel of this team can be starred.' } } };

beforeEach(() => {
  seen = [];
  answer = (req) => (req.method === 'GET' ? { status: 200, body: SAVED } : merge(req));
  setTransport(async (req) => {
    seen.push(req);
    return answer(req);
  });
});
afterEach(() => vi.useRealTimers());

describe('the sidebar preferences store', () => {
  it('loads a team once and holds the answer', async () => {
    const store = new SidebarPrefsStore();
    expect(store.entry('engineering').status).toBe('idle');
    await store.load('engineering');
    await store.load('engineering');
    expect(seen.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(seen[0]?.url).toMatch(/\/api\/teams\/engineering\/sidebar-prefs$/);
    expect(store.entry('engineering')).toEqual({ status: 'ok', prefs: SAVED });
  });

  it('shows a change at once, sends only what changed, and keeps the server answer', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    const work = store.update('engineering', { sort: 'recent' });
    expect(store.entry('engineering').prefs.sort).toBe('recent');
    await work;
    expect(putBody(seen.find((r) => r.method === 'PUT')!)).toEqual({ sort: 'recent' });
    expect(store.entry('engineering').prefs).toEqual({ ...SAVED, sort: 'recent' });
  });

  it('sends stars as additions and removals, never as a whole list, in the order they were made', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    let held = [...SAVED.starred];
    answer = (req) => {
      const b = putBody(req) as { starAdd?: string[]; starRemove?: string[] };
      held = [...held.filter((id) => !(b.starRemove ?? []).includes(id)), ...(b.starAdd ?? [])];
      return { status: 200, body: { ...SAVED, starred: held } };
    };
    const a = store.update('engineering', { starAdd: [uuid(2)] as never });
    const b = store.update('engineering', { starAdd: [uuid(3)] as never, starRemove: [uuid(1)] as never });
    expect(store.entry('engineering').prefs.starred).toEqual([uuid(2), uuid(3)]);
    await Promise.all([a, b]);
    expect(seen.filter((r) => r.method === 'PUT').map(putBody)).toEqual([{ starAdd: [uuid(2)] }, { starAdd: [uuid(3)], starRemove: [uuid(1)] }]);
    expect(store.entry('engineering').prefs.starred.sort()).toEqual([uuid(2), uuid(3)].sort());
  });

  it('sends nothing for an empty change', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    await store.update('engineering', {});
    expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(0);
  });

  it('undoes a change the server refuses and rejects with the server sentence', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    answer = (req) => (req.method === 'GET' ? { status: 200, body: SAVED } : refusal);
    await expect(store.update('engineering', { starAdd: [uuid(9)] as never })).rejects.toThrow('Only a channel of this team can be starred.');
    expect(store.entry('engineering').prefs.starred).toEqual([uuid(1)]);
  });

  it('uses the defaults (team order) and offers nothing when the person has no such settings (403 or 404)', async () => {
    const store = new SidebarPrefsStore();
    answer = () => ({ status: 403, body: { error: { code: 'forbidden', message: 'You cannot see this team' } } });
    await store.load('engineering');
    expect(store.entry('engineering')).toMatchObject({ status: 'unavailable', prefs: { starred: [], sort: 'team', hideIdle: false } });
  });

  it('does not give up for the session when the first load fails: it shows the defaults, then asks again on the next load', async () => {
    const store = new SidebarPrefsStore();
    answer = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } });
    await store.load('engineering');
    expect(store.entry('engineering')).toMatchObject({ status: 'error', prefs: { sort: 'team' } });
    answer = () => ({ status: 200, body: SAVED });
    await store.load('engineering');
    expect(store.entry('engineering')).toEqual({ status: 'ok', prefs: SAVED });
    // a failed refresh of a view already held keeps what is held
    answer = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } });
    await store.load('engineering', true);
    expect(store.entry('engineering')).toEqual({ status: 'ok', prefs: SAVED });
  });

  it('refuses a change while the view has not loaded, and asks for it again', async () => {
    const store = new SidebarPrefsStore();
    await expect(store.update('engineering', { sort: 'name' })).rejects.toThrow(/still loading/);
    await flush();
    expect(store.entry('engineering').status).toBe('ok');
  });
});

describe('races', () => {
  it('ignores an answer to a question asked before the person signed in as someone else', async () => {
    const store = new SidebarPrefsStore();
    const g = gate();
    answer = async () => {
      await g.wait;
      return { status: 200, body: SAVED };
    };
    const loading = store.load('engineering');
    store.reset();
    g.open();
    await loading;
    expect(store.entry('engineering').status).toBe('idle');
  });

  it('does not send, or apply the answer of, a change made before the person changed', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    const g = gate();
    answer = async (req) => {
      if (req.method === 'PUT') await g.wait;
      return req.method === 'GET' ? { status: 200, body: SAVED } : merge(req);
    };
    const first = store.update('engineering', { sort: 'recent' });
    const second = store.update('engineering', { sort: 'team' });
    await flush();
    store.reset();
    g.open();
    await Promise.all([first, second]);
    expect(seen.filter((r) => r.method === 'PUT')).toHaveLength(1); // the second never left
    expect(store.entry('engineering').status).toBe('idle');
    // the old changes did not leave the counter negative or stuck: a new person's change is saved normally
    await store.load('engineering');
    await store.update('engineering', { hideIdle: false });
    expect(store.entry('engineering').prefs.hideIdle).toBe(false);
  });

  it('throws away a load that answers while a change is waiting, and one that started before a change finished', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    const getGate = gate();
    const putGate = gate();
    answer = async (req) => {
      if (req.method === 'GET') {
        await getGate.wait;
        return { status: 200, body: { ...SAVED, sort: 'name' } }; // the old truth
      }
      await putGate.wait;
      return merge(req);
    };
    const loading = store.load('engineering', true);
    const saving = store.update('engineering', { sort: 'recent' });
    getGate.open();
    await loading;
    expect(store.entry('engineering').prefs.sort).toBe('recent'); // the stale answer did not undo the change on screen
    putGate.open();
    await saving;
    expect(store.entry('engineering').prefs.sort).toBe('recent');
  });

  it('with a newer change waiting, a failed change does not flash the old state', async () => {
    const store = new SidebarPrefsStore();
    answer = () => ({ status: 200, body: { ...SAVED, sort: 'team' } });
    await store.load('engineering');
    const g = gate();
    let puts = 0;
    answer = async (req) => {
      if (req.method === 'GET') return { status: 200, body: { ...SAVED, sort: 'recent' } };
      puts += 1;
      if (puts === 1) {
        await g.wait;
        return refusal;
      }
      return { status: 200, body: { ...SAVED, sort: 'recent' } };
    };
    const states: string[] = [];
    store.subscribe(() => states.push(store.entry('engineering').prefs.sort));
    const first = store.update('engineering', { sort: 'name' }).catch((e: Error) => e.message);
    const second = store.update('engineering', { sort: 'recent' });
    states.length = 0;
    g.open();
    expect(await first).toMatch(/Only a channel/);
    await second;
    // never back to the value from before both changes ('team'): the screen went name -> recent and stays
    expect(states).not.toContain('team');
    expect(store.entry('engineering').prefs.sort).toBe('recent');
  });

  it('a failed last change is taken back and the server is asked what is true', async () => {
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    answer = (req) => (req.method === 'GET' ? { status: 200, body: { ...SAVED, starred: [uuid(1), uuid(5)] } } : refusal);
    await expect(store.update('engineering', { starRemove: [uuid(1)] as never })).rejects.toThrow();
    await flush();
    expect(store.entry('engineering').prefs.starred).toEqual([uuid(1), uuid(5)]);
  });
});

describe('asking again', () => {
  it('refreshes a held view when the tab comes back, at most every 15 seconds, and always on a reconnect', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const store = new SidebarPrefsStore();
    await store.load('engineering');
    const gets = (): number => seen.filter((r) => r.method === 'GET').length;
    expect(gets()).toBe(1);
    store.refreshAll();
    await flush();
    expect(gets()).toBe(1); // too soon
    vi.advanceTimersByTime(REFRESH_EVERY_MS + 1);
    answer = () => ({ status: 200, body: { ...SAVED, starred: [uuid(1), uuid(7)] } });
    store.refreshAll();
    await flush();
    expect(gets()).toBe(2);
    expect(store.entry('engineering').prefs.starred).toEqual([uuid(1), uuid(7)]); // a star made on another device shows up
    store.refreshAll(true);
    await flush();
    expect(gets()).toBe(3);
  });

  it('leaves a team with a change on its way alone, and retries a team whose first load failed', async () => {
    const store = new SidebarPrefsStore();
    answer = () => ({ status: 500, body: { error: { code: 'internal', message: 'boom' } } });
    await store.load('engineering');
    answer = () => ({ status: 200, body: SAVED });
    store.refreshAll(true);
    await flush();
    expect(store.entry('engineering').status).toBe('ok');
    const g = gate();
    answer = async (req) => {
      if (req.method === 'PUT') await g.wait;
      return req.method === 'GET' ? { status: 200, body: SAVED } : merge(req);
    };
    const before = seen.length;
    const saving = store.update('engineering', { hideIdle: false });
    store.refreshAll(true);
    await flush();
    expect(seen.slice(before).filter((r) => r.method === 'GET')).toHaveLength(0);
    g.open();
    await saving;
  });
});
