// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuestKnockResponse, GuestLinkPeekResponse, GuestSessionResponse, GuestTokenResponse } from '@manythreads/shared';
import { ApiError } from '../src/api/client';
import type { GuestApi } from '../src/guest/api';
import { GUEST_WORDS, GuestController, checkName, endingOf } from '../src/guest/guestController';
import { createFakeAdapter, type FakeAdapter } from '../src/meetings/fakeAdapter';

// The guest page (P17-04): its controller against a scripted server and the in-memory media adapter (open the link, a name, knock, wait, let in, the call; turned
// away, the call ended, taken out, nobody answered in ten minutes; a dead link), and the page itself drawn for its states.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../src/shell/usePageTitle', () => ({ useDocumentTitle: () => undefined }));

const GUEST = '00000000-0000-7000-8000-000000000042';
const TOKEN = 'A'.repeat(43);
const PEEK: GuestLinkPeekResponse = { state: 'open', workspaceName: 'Acme', title: 'Design review', kind: 'audio', transcribing: true, notetaker: false };
const TOKEN_ANSWER: GuestTokenResponse = {
  join: { provider: 'fake', url: 'wss://media.example', token: 'tok', identity: `guest:${GUEST}`, roomName: 'room', expiresAt: new Date(Date.now() + 600_000).toISOString() },
  people: [
    { identity: '00000000-0000-7000-8000-000000000012', displayName: 'Nadia' },
    { identity: `guest:${GUEST}`, displayName: 'Ana (guest)' },
  ],
};

function scripted() {
  let state: GuestSessionResponse['state'] = 'waiting';
  const calls: string[] = [];
  const api: GuestApi & { setState(s: GuestSessionResponse['state']): void; calls: string[]; peekFails: ApiError | null; knockFails: ApiError | null } = {
    calls,
    peekFails: null,
    knockFails: null,
    setState(s) {
      state = s;
    },
    async peek(token) {
      calls.push(`peek ${token}`);
      if (api.peekFails) throw api.peekFails;
      return PEEK;
    },
    async knock(_token, name): Promise<GuestKnockResponse> {
      calls.push(`knock ${name}`);
      if (api.knockFails) throw api.knockFails;
      return { state: 'waiting', title: PEEK.title, kind: 'audio' };
    },
    async session() {
      calls.push('session');
      return { state, title: PEEK.title, kind: 'audio', displayName: 'Ana', people: state === 'admitted' ? TOKEN_ANSWER.people : [] };
    },
    async token() {
      calls.push('token');
      if (state !== 'admitted') throw new ApiError({ code: 'forbidden', message: 'You have not been let in yet.', status: 403 });
      return TOKEN_ANSWER;
    },
    async leave() {
      calls.push('leave');
      return { ok: true };
    },
    async heartbeat() {
      calls.push('heartbeat');
      return { ok: true };
    },
  };
  return api;
}

function harness() {
  const api = scripted();
  let now = 1_000_000;
  const intervals: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  const timeouts: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const adapters: FakeAdapter[] = [];
  let adapter: FakeAdapter | null = null;
  let forgot = 0;
  const c = new GuestController({
    api,
    loadAdapter: async () => {
      adapter = createFakeAdapter();
      adapters.push(adapter);
      return adapter;
    },
    now: () => now,
    setInterval: (fn, ms) => {
      const h = { fn, ms, live: true };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      (h as { live: boolean }).live = false;
    },
    setTimeout: (fn, ms) => {
      const h = { fn, at: now + ms, live: true };
      timeouts.push(h);
      return h;
    },
    clearTimeout: (h) => {
      (h as { live: boolean }).live = false;
    },
    forgetAddress: () => void (forgot += 1),
  });
  const tick = async (ms: number): Promise<void> => {
    now += ms;
    for (const h of intervals.filter((x) => x.live && x.ms <= ms)) h.fn();
    for (const h of timeouts.filter((x) => x.live && x.at <= now)) {
      h.live = false;
      h.fn();
    }
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { api, c, tick, settle, adapters, adapter: () => adapter, forgot: () => forgot, advance: (ms: number) => void (now += ms), intervals };
}

describe('the guest controller', () => {
  it('opens the link, checks the name, knocks, forgets the address, waits and joins once let in', async () => {
    const h = harness();
    await h.c.open(TOKEN);
    expect(h.c.getState().phase).toEqual({ kind: 'open', peek: PEEK });
    await h.c.knock();
    expect(h.c.getState().error).toBe('Write your name');
    expect(h.api.calls.filter((x) => x.startsWith('knock'))).toEqual([]);
    h.c.setName('  Ana  ');
    await h.c.knock();
    expect(h.api.calls).toContain('knock Ana');
    expect(h.forgot()).toBe(1);
    expect(h.c.getState().phase).toEqual({ kind: 'waiting', title: 'Design review' });
    await h.tick(2_000);
    expect(h.c.getState().phase.kind).toBe('waiting');
    h.api.setState('admitted');
    await h.tick(2_000);
    expect(h.c.getState().phase).toEqual({ kind: 'in-call', title: 'Design review' });
    expect(h.adapter()?.joins[0]?.identity).toBe(`guest:${GUEST}`);
    expect(h.adapter()?.state.micOn).toBe(true);
    expect(h.c.getState().people.map((p) => p.displayName)).toEqual(['Nadia', 'Ana (guest)']);
    // mute and camera go to the media layer
    h.c.setMicOn(false);
    h.c.setCameraOn(true);
    await h.tick(0);
    expect(h.adapter()?.state).toMatchObject({ micOn: false, cameraOn: true });
    // in the call the 10-second look is the sign of life: no separate heartbeat until the tab is shown again (a hidden tab's timers are slowed)
    await h.tick(30_000);
    expect(h.api.calls).not.toContain('heartbeat');
    await h.c.shown();
    expect(h.api.calls).toContain('heartbeat');
  });

  it('a lost media connection while still let in says "Reconnecting…" and joins again with a new token, with a growing pause', async () => {
    const h = harness();
    await h.c.open(TOKEN);
    h.c.setName('Ana');
    await h.c.knock();
    h.api.setState('admitted');
    await h.tick(2_000);
    expect(h.c.getState().phase.kind).toBe('in-call');
    const tokens = h.api.calls.filter((x) => x === 'token').length;
    // the first try fails (offline), the next one after a longer pause gets back in
    h.adapter()!.lose();
    await h.settle();
    expect(h.c.getState()).toMatchObject({ reconnecting: true, phase: { kind: 'in-call' } });
    const failing = h.api.session;
    h.api.session = async () => {
      h.api.session = failing;
      throw new ApiError({ code: 'network', message: 'offline', status: 0 });
    };
    await h.tick(1_000);
    await h.settle();
    expect(h.c.getState().reconnecting).toBe(true);
    await h.tick(1_000);
    await h.settle();
    expect(h.c.getState().reconnecting).toBe(true);
    await h.tick(1_000);
    await h.settle();
    expect(h.c.getState()).toMatchObject({ reconnecting: false, phase: { kind: 'in-call' } });
    expect(h.api.calls.filter((x) => x === 'token').length).toBe(tokens + 1);
    expect(h.adapters).toHaveLength(2);
    expect(h.adapters[1]!.state.connected).toBe(true);
  });

  it('a lost connection after being taken out ends the page instead of joining again', async () => {
    const h = harness();
    await h.c.open(TOKEN);
    h.c.setName('Ana');
    await h.c.knock();
    h.api.setState('admitted');
    await h.tick(2_000);
    h.api.setState('removed');
    h.adapter()!.lose();
    await h.settle();
    await h.tick(1_000);
    await h.settle();
    expect(h.c.getState().phase).toEqual({ kind: 'removed', title: 'Design review' });
    expect(h.adapters).toHaveLength(1);
  });

  it('turned away, the call ended, and taken out in the call each end the page with their own words', async () => {
    for (const [state, kind] of [['denied', 'denied'], ['ended', 'ended']] as const) {
      const h = harness();
      await h.c.open(TOKEN);
      h.c.setName('Ana');
      await h.c.knock();
      h.api.setState(state);
      await h.tick(2_000);
      expect(h.c.getState().phase).toEqual({ kind, title: 'Design review' });
    }
    const h = harness();
    await h.c.open(TOKEN);
    h.c.setName('Ana');
    await h.c.knock();
    h.api.setState('admitted');
    await h.tick(2_000);
    expect(h.c.getState().phase.kind).toBe('in-call');
    h.api.setState('removed');
    await h.tick(10_000);
    expect(h.c.getState().phase).toEqual({ kind: 'removed', title: 'Design review' });
    expect(h.adapter()?.state.connected).toBe(false);
    // nothing asks the server any more
    const n = h.api.calls.length;
    await h.tick(60_000);
    expect(h.api.calls.length).toBe(n);
  });

  it('nobody answered in ten minutes: "Nobody answered. Try again." and Try again opens the form again', async () => {
    const h = harness();
    await h.c.open(TOKEN);
    h.c.setName('Ana');
    await h.c.knock();
    h.advance(600_000);
    await h.tick(2_000);
    expect(h.c.getState().phase.kind).toBe('nobody');
    h.c.tryAgain();
    await h.tick(0);
    expect(h.c.getState().phase.kind).toBe('open');
  });

  it('a dead link is the gone page; Cancel while waiting leaves', async () => {
    const h = harness();
    h.api.peekFails = new ApiError({ code: 'not_found', message: 'This guest link has expired or was turned off', status: 404 });
    await h.c.open(TOKEN);
    expect(h.c.getState().phase).toEqual({ kind: 'gone' });
    const k = harness();
    await k.c.open(TOKEN);
    k.c.setName('Ana');
    await k.c.knock();
    await k.c.leave();
    expect(k.api.calls).toContain('leave');
    expect(k.c.getState().phase.kind).toBe('left');
  });

  it('a reload after the knock (no secret in the address) carries on with the cookie', async () => {
    const h = harness();
    h.api.setState('waiting');
    await h.c.open(null);
    expect(h.api.calls).toEqual(['session']);
    expect(h.c.getState().phase.kind).toBe('waiting');
  });

  it('checks names and maps the server\'s states', () => {
    expect(checkName('   ')).toEqual({ ok: false, message: 'Write your name' });
    expect(checkName('x'.repeat(61)).ok).toBe(false);
    expect(checkName(' Ana ')).toEqual({ ok: true, name: 'Ana' });
    expect(endingOf('expired')).toBe('nobody');
    expect(endingOf('waiting')).toBeNull();
    expect(endingOf('admitted')).toBeNull();
  });
});

describe('the guest page', () => {
  let root: Root | null = null;
  let host: HTMLElement;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    vi.unstubAllGlobals();
  });

  const serve = (answers: Record<string, { status: number; body: unknown }>) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const hit = Object.entries(answers).find(([path]) => String(url).startsWith(path));
        const a = hit?.[1] ?? { status: 404, body: { error: { code: 'not_found', message: 'nothing' } } };
        return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } });
      }),
    );

  async function draw(path: string): Promise<void> {
    const { GuestJoinPage } = await import('../src/guest/GuestJoinPage');
    root = createRoot(host);
    await act(async () => {
      root!.render(
        createElement(MemoryRouter, { initialEntries: [path] }, createElement(Routes, null, createElement(Route, { path: '/join/g/:token', element: createElement(GuestJoinPage) }), createElement(Route, { path: '/join/g', element: createElement(GuestJoinPage) }))),
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('shows the call title and the workspace, the transcription line, the name, the device check and Ask to join', async () => {
    serve({ '/api/guest-links/peek': { status: 200, body: PEEK } });
    await draw(`/join/g/${TOKEN}`);
    expect(host.querySelector('h1')?.textContent).toBe('Join Design review · Acme');
    expect(host.querySelector('[data-testid="guest-transcribing"]')?.textContent).toBe(GUEST_WORDS.transcribed);
    expect(host.querySelector('[data-testid="guest-name"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="guest-devices"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="guest-join"]')?.textContent).toBe('Ask to join');
    // never the channel or who is in the call
    expect(host.textContent).not.toMatch(/#|Nadia/);
    // the secret went in the body of a POST, never in an address
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    expect(calls.map(([u]) => String(u)).some((u) => u.includes(TOKEN))).toBe(false);
    expect(calls.find(([u]) => String(u) === '/api/guest-links/peek')?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ token: TOKEN }) });
  });

  it('a dead link shows the same page whatever the reason, with no sign-in button', async () => {
    serve({ '/api/guest-links/peek': { status: 404, body: { error: { code: 'not_found', message: 'This guest link has expired or was turned off' } } } });
    await draw(`/join/g/${TOKEN}`);
    expect(host.querySelector('[data-testid="guest-gone"] h1')?.textContent).toBe('This guest link has expired or was turned off');
    expect(host.querySelector('a[href="/sign-in"]')).toBeNull();
  });

  it('without the secret in the address, the page follows the cookie: waiting with Cancel', async () => {
    serve({ '/api/guest/session': { status: 200, body: { state: 'waiting', title: 'Design review', kind: 'audio', displayName: 'Ana', people: [] } } });
    await draw('/join/g');
    expect(host.querySelector('[data-testid="guest-waiting"]')?.textContent).toBe(GUEST_WORDS.waiting);
    expect(host.querySelector('[data-testid="guest-cancel"]')).not.toBeNull();
  });
});
