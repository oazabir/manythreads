import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GetNotificationLevelsResponse } from '@manythreads/shared';
import {
  LEVEL_ORDER,
  PUSH_SUPPORT_TEXT,
  addKeyword,
  browserLabel,
  channelTitle,
  keyBytes,
  levelOf,
  parseKeywordInput,
  pushSupport,
  safeOpenPath,
  withChannelLevel,
} from '../src/notifications/settingsModel';
import { notificationTitle } from '../src/notifications/store';

const levels = (channels: Array<{ id: string; level: 'all' | 'mentions' | 'nothing' }> = [], workspaceDefault: 'all' | 'mentions' | 'nothing' = 'mentions') =>
  ({
    workspaceDefault,
    channels: channels.map((c) => ({ channelId: c.id, channelName: 'dev', channelKind: 'channel' as const, level: c.level })),
  }) as unknown as GetNotificationLevelsResponse;

describe('keyword input', () => {
  it('splits on commas and new lines, lower-cases and drops repeats', () => {
    expect(parseKeywordInput('Deploy, outage\nDEPLOY,  ')).toEqual({ keywords: ['deploy', 'outage'], problems: [] });
  });
  it('says why a keyword cannot be used, in a sentence, and keeps the usable ones', () => {
    const r = parseKeywordInput('ok, a b c d e f, !!!');
    expect(r.keywords).toEqual(['ok']);
    expect(r.problems).toHaveLength(2);
    expect(r.problems.every((p) => p.length > 10)).toBe(true);
  });
  it('refuses a 21st keyword', () => {
    const full = Array.from({ length: 20 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
    expect(addKeyword(full, 'extra')).toHaveProperty('problem');
    expect(addKeyword(full, 'worda')).toEqual({ keywords: full });
  });
  it('adds a keyword in order and normalises it', () => {
    expect(addKeyword(['zebra'], '  Alpha  ')).toEqual({ keywords: ['alpha', 'zebra'] });
    expect(addKeyword([], '')).toHaveProperty('problem');
  });
});

describe('levels', () => {
  it('lists the three levels, loudest first', () => {
    expect(LEVEL_ORDER).toEqual(['all', 'mentions', 'nothing']);
  });
  it('uses the workspace default for a team channel, "all" for a direct message, and the person\'s own choice over both', () => {
    expect(levelOf(levels(), 'c1', 'channel')).toEqual({ own: null, effective: 'mentions' });
    expect(levelOf(levels([], 'nothing'), 'c1', 'channel').effective).toBe('nothing');
    expect(levelOf(levels(), 'd1', 'dm').effective).toBe('all');
    expect(levelOf(levels([{ id: 'c1', level: 'all' }]), 'c1', 'channel')).toEqual({ own: 'all', effective: 'all' });
    expect(levelOf(null, 'c1', 'channel').effective).toBe('mentions');
  });
  it('puts a changed channel first, replaces an earlier choice and removes it on null', () => {
    const base = levels([{ id: 'a', level: 'all' }, { id: 'b', level: 'nothing' }]);
    const channel = { channelId: 'b', channelName: 'ops', channelKind: 'channel' as const };
    const set = withChannelLevel(base, channel, 'mentions');
    expect(set.channels.map((c) => [c.channelId, c.level])).toEqual([['b', 'mentions'], ['a', 'all']]);
    expect(withChannelLevel(base, channel, null).channels.map((c) => c.channelId)).toEqual(['a']);
  });
  it('titles a channel by name and a direct message plainly', () => {
    expect(channelTitle({ channelName: 'dev', channelKind: 'channel' })).toBe('#dev');
    expect(channelTitle({ channelName: null, channelKind: 'dm' })).toBe('Direct message');
  });
});

describe('push support', () => {
  const ok = { serviceWorker: true, pushManager: true, permission: 'default' as const, serverAvailable: true };
  it('is ready only when the browser can, the server can and the person has not refused', () => {
    expect(pushSupport(ok)).toBe('ready');
    expect(pushSupport({ ...ok, permission: 'granted' })).toBe('ready');
    expect(pushSupport({ ...ok, permission: 'denied' })).toBe('blocked');
    expect(pushSupport({ ...ok, serverAvailable: false })).toBe('unavailable');
    expect(pushSupport({ ...ok, pushManager: false })).toBe('unsupported');
    expect(pushSupport({ ...ok, permission: 'unsupported' })).toBe('unsupported');
  });
  it('has a sentence for every reason it is not ready', () => {
    expect(Object.keys(PUSH_SUPPORT_TEXT).sort()).toEqual(['blocked', 'unavailable', 'unsupported']);
  });
  it('turns the URL-safe public key into bytes', () => {
    expect(Array.from(keyBytes('AQID'))).toEqual([1, 2, 3]);
    expect(Array.from(keyBytes('-_8'))).toEqual([251, 255]);
  });
  it('names the browser family without identifiers', () => {
    expect(browserLabel('Mozilla/5.0 Firefox/130.0')).toBe('Firefox');
    expect(browserLabel('Mozilla/5.0 Chrome/120 Safari/537 Edg/120')).toBe('Edge');
    expect(browserLabel('Mozilla/5.0 Chrome/120 Safari/537')).toBe('Chrome');
    expect(browserLabel('curl/8')).toBe('Browser');
  });
});

describe('where a push click may lead', () => {
  const origin = 'https://manythreads.example';
  it('keeps an /open path of this site', () => {
    expect(safeOpenPath('/open?channel=c&message=m', origin)).toBe('/open?channel=c&message=m');
    expect(safeOpenPath(`${origin}/open?channel=c&message=m&root=r`, origin)).toBe('/open?channel=c&message=m&root=r');
  });
  it('sends anything else home', () => {
    expect(safeOpenPath('https://evil.example/open?x=1', origin)).toBe('/');
    expect(safeOpenPath('/account', origin)).toBe('/');
    expect(safeOpenPath('javascript:alert(1)', origin)).toBe('/');
    expect(safeOpenPath('//evil.example/open', origin)).toBe('/');
  });
});

describe('inbox titles', () => {
  it('says which keyword was written, and who wrote in a channel at level "all"', () => {
    expect(notificationTitle({ kind: 'mention', actorName: 'Rafi', channelName: 'dev', keyword: 'outage' })).toBe('Rafi wrote “outage” in #dev');
    expect(notificationTitle({ kind: 'mention', actorName: 'Rafi', channelName: 'dev', keyword: null })).toBe('Rafi mentioned you in #dev');
    expect(notificationTitle({ kind: 'message', actorName: 'Rafi', channelName: 'dev' })).toBe('Rafi in #dev');
  });
});

describe('the service worker (public/sw.js)', () => {
  type Handler = (event: Record<string, unknown>) => void;
  const load = (windows: Array<{ visibilityState: string; focused: boolean; url?: string }> = [], origin = 'https://manythreads.example') => {
    const handlers: Record<string, Handler> = {};
    const shown: Array<{ title: string; options: { body: string; tag: string; data: { url: string } } }> = [];
    const opened: string[] = [];
    const posted: unknown[] = [];
    const focusable = windows.map((w) => ({ ...w, focus: () => Promise.resolve(), postMessage: (m: unknown) => posted.push(m) }));
    const self = {
      location: { origin },
      addEventListener: (type: string, fn: Handler) => {
        handlers[type] = fn;
      },
      skipWaiting: () => undefined,
      clients: {
        claim: () => Promise.resolve(),
        matchAll: () => Promise.resolve(focusable),
        openWindow: (url: string) => {
          opened.push(url);
          return Promise.resolve(null);
        },
      },
      registration: {
        showNotification: (title: string, options: { body: string; tag: string; data: { url: string } }) => {
          shown.push({ title, options });
          return Promise.resolve();
        },
      },
    };
    const source = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
    new Function('self', source)(self);
    return { handlers, shown, opened, posted };
  };
  const pushEvent = (payload: unknown) => {
    const waits: Promise<unknown>[] = [];
    return { event: { data: { json: () => payload }, waitUntil: (p: Promise<unknown>) => waits.push(p) }, done: () => Promise.all(waits) };
  };

  it('shows the push when no tab is watching, with only the fields it was sent', async () => {
    const sw = load([]);
    const p = pushEvent({ v: 1, title: 'Rafi in #dev', body: 'Open manythreads to read it.', tag: 'n-1', url: '/open?channel=c&message=m' });
    sw.handlers['push']?.(p.event);
    await p.done();
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.title).toBe('Rafi in #dev');
    expect(sw.shown[0]?.options.data.url).toBe('/open?channel=c&message=m');
  });
  it('stays quiet while a visible, focused tab is open', async () => {
    const sw = load([{ visibilityState: 'visible', focused: true }]);
    const p = pushEvent({ v: 1, title: 't', body: 'b', tag: 'n-1', url: '/open?channel=c&message=m' });
    sw.handlers['push']?.(p.event);
    await p.done();
    expect(sw.shown).toHaveLength(0);
  });
  it('shows a plain line for a push it cannot read and never follows a link to another site', async () => {
    const sw = load([]);
    const bad = pushEvent({ v: 2, anything: true });
    sw.handlers['push']?.(bad.event);
    await bad.done();
    expect(sw.shown[0]?.title).toBe('manythreads');
    const away = pushEvent({ v: 1, title: 't', body: 'b', tag: 'n-2', url: 'https://evil.example/open?x=1' });
    sw.handlers['push']?.(away.event);
    await away.done();
    expect(sw.shown[1]?.options.data.url).toBe('/');
  });
  it('hands the path to an open tab of this site on click instead of opening another', async () => {
    const sw = load([{ visibilityState: 'hidden', focused: false, url: 'https://manythreads.example/t/eng/c/dev' }]);
    const waits: Promise<unknown>[] = [];
    sw.handlers['notificationclick']?.({ notification: { close: () => undefined, data: { url: '/open?channel=c&message=m' } }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(sw.opened).toEqual([]);
    expect(sw.posted).toEqual([{ type: 'manythreads.open', url: '/open?channel=c&message=m' }]);
  });
  it('opens a window at the path on click when none is open', async () => {
    const sw = load([]);
    const waits: Promise<unknown>[] = [];
    sw.handlers['notificationclick']?.({ notification: { close: () => undefined, data: { url: '/open?channel=c&message=m' } }, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect(sw.opened).toEqual(['/open?channel=c&message=m']);
  });
});
