import { describe, expect, it } from 'vitest';
import { APP_BRIDGE_CLIENT_JS, EMBEDDED_APP_CSP, EMBEDDED_APP_SANDBOX, repoAppPath } from '@manythreads/shared';
import { APP_COPY, answerBridge } from '../src/viewers/app/AppViewer';

const ctx = { app: 'apps/release-checklist', team: 'Engineering' };
const request = (over: Record<string, unknown> = {}) => ({ channel: 'manythreads.app', id: 'r1', method: 'getContext', ...over });

describe('embedded app bridge', () => {
  it('getContext answers the app folder and the team name, and nothing else', () => {
    const res = answerBridge(request(), ctx);
    expect(res).toEqual({ channel: 'manythreads.host', id: 'r1', ok: true, result: { app: 'apps/release-checklist', team: 'Engineering' } });
    expect(Object.keys((res as { result: object }).result).sort()).toEqual(['app', 'team']);
  });

  it('any other method is refused with an answer, so the app does not wait forever', () => {
    for (const method of ['getSession', 'fetch', 'getCookie', '__proto__', '']) {
      const res = answerBridge(request({ method }), ctx);
      expect(res).toMatchObject({ ok: false, id: 'r1' });
    }
  });

  it('messages that are not requests get no answer', () => {
    expect(answerBridge(null, ctx)).toBeNull();
    expect(answerBridge('getContext', ctx)).toBeNull();
    expect(answerBridge({ id: 'r1', method: 'getContext' }, ctx)).toBeNull();
    expect(answerBridge(request({ channel: 'other' }), ctx)).toBeNull();
    expect(answerBridge(request({ id: '' }), ctx)).toBeNull();
    expect(answerBridge(request({ id: 'x'.repeat(65) }), ctx)).toBeNull();
    expect(answerBridge(request({ id: 5 }), ctx)).toBeNull();
  });
});

describe('embedded app contract', () => {
  it('is sandboxed to scripts only, with a CSP that stops every request', () => {
    expect(EMBEDDED_APP_SANDBOX).toBe('allow-scripts');
    expect(EMBEDDED_APP_CSP).toBe(
      "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data: blob: 'self'; connect-src 'none'; frame-ancestors 'self'",
    );
  });

  it('the content route is under the team and encodes each segment', () => {
    expect(repoAppPath('engineering', 'apps/release-checklist')).toBe('/api/teams/engineering/repo/app/apps/release-checklist/index.html');
    expect(repoAppPath('engineering', 'apps/a b/c', 'app.js')).toBe('/api/teams/engineering/repo/app/apps/a%20b/c/app.js');
    expect(repoAppPath('engineering', '../x//y/./z')).toBe('/api/teams/engineering/repo/app/x/y/z/index.html');
  });

  it('the app-side client only posts the one allowed method', () => {
    expect(APP_BRIDGE_CLIENT_JS).toContain("method:'getContext'");
    expect(APP_COPY).toBe('This app cannot read your session or other files.');
  });
});
