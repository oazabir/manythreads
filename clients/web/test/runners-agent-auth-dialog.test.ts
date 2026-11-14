import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentAuth, AgentAuthAttempt, BotRunner } from '@manythreads/shared';
import { AgentSignInView } from '../src/screens/admin/runners/AgentSignInDialog';
import { homeWords, logoutWords, machineOf, replaceWords } from '../src/screens/admin/runners/agent-auth';

/*
 * What the sign-in dialog shows (P25-09, review S-2): whose sign-in it is (this profile's own folder or the machine's shared one), the machine named in both
 * confirms, and the second confirm before a new sign-in replaces an account that is in place. Rendered as static markup, one state at a time.
 */

const runner = { id: '00000000-0000-7000-8000-0000000d0001', label: 'Office Claude', agent: 'claude-code', baseUrl: 'http://build-box.internal:8686' } as unknown as BotRunner;
const method = { id: 'claude-ai-login', name: 'Claude account', description: 'Opens a page, then you paste a code.', how: 'paste_code' as const };
const auth = (over: Partial<AgentAuth> = {}): AgentAuth => ({ agent: 'claude-code', profile: 'claude', home: 'shared', state: 'signed_in', kind: 'account', canLogout: true, methods: [method], attempt: null, note: null, ...over });
const attempt = (over: Partial<AgentAuthAttempt> = {}): AgentAuthAttempt => ({ id: 'a1', methodId: 'claude-ai-login', how: 'paste_code', state: 'waiting', action: null, message: null, ...over });

const noop = () => undefined;
const view = (over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    createElement(AgentSignInView, {
      runner,
      auth: auth(),
      attempt: null,
      error: null,
      busy: false,
      text: '',
      confirmOut: false,
      confirmStart: null,
      onText: noop,
      onStart: noop,
      onStartConfirmed: noop,
      onStartDeclined: noop,
      onSend: noop,
      onCancel: noop,
      onAskSignOut: noop,
      onSignOut: noop,
      ...over,
    }),
  );

describe('the machine and the folder are named', () => {
  it('takes the machine from the runner address, and has a plain fallback', () => {
    expect(machineOf('http://build-box.internal:8686')).toBe('build-box.internal:8686');
    expect(machineOf(null)).toBe('the bridge machine');
    expect(machineOf('not a url')).toBe('the bridge machine');
  });

  it('says a shared folder is shared with everyone on the machine, and a dedicated one is the profile alone', () => {
    expect(homeWords(auth(), runner)).toMatch(/every user of Claude Code on build-box\.internal:8686/);
    expect(homeWords(auth({ home: 'dedicated', profile: 'office' }), runner)).toMatch(/profile "office" alone/);
    expect(homeWords(auth({ home: null }), runner)).toBe('');
  });

  it('the logout confirm names the machine and says it signs out every user of the tool there, unless the folder is the profile own', () => {
    expect(logoutWords(auth(), runner)).toMatch(/build-box\.internal:8686/);
    expect(logoutWords(auth(), runner)).toMatch(/every user of Claude Code on that machine/);
    expect(logoutWords(auth({ home: 'dedicated', profile: 'office' }), runner)).toMatch(/Only the bridge profile "office"/);
    expect(logoutWords(auth({ home: 'dedicated', profile: 'office' }), runner)).not.toMatch(/every user/);
  });

  it('the replace confirm says the account is replaced, for everyone when shared', () => {
    expect(replaceWords(auth(), runner)).toMatch(/replaces that account for every user of Claude Code on build-box\.internal:8686/);
    expect(replaceWords(auth({ home: 'dedicated', profile: 'office' }), runner)).toMatch(/replaces the account .* "office"/);
  });
});

describe('the dialog renders', () => {
  it('asks while nothing has come back yet', () => {
    expect(view({ auth: null })).toMatch(/Asking Claude Code/);
  });

  it('a signed-in shared sign-in: the status, whose it is, the methods and a Sign out button, and no confirm yet', () => {
    const html = view();
    expect(html).toContain('Claude Code is signed in.');
    expect(html).toContain('data-home="shared"');
    expect(html).toContain('data-testid="agent-auth-method"');
    expect(html).toContain('data-testid="agent-auth-logout"');
    expect(html).not.toContain('agent-auth-logout-words');
    expect(html).not.toContain('agent-auth-replace');
  });

  it('the logout confirm shows the machine and who loses the sign-in', () => {
    const html = view({ confirmOut: true });
    expect(html).toContain('data-testid="agent-auth-logout-words"');
    expect(html).toContain('build-box.internal:8686');
    expect(html).toContain('signs out every user of Claude Code on that machine');
    expect(html).toContain('data-testid="agent-auth-logout-yes"');
  });

  it('the replace confirm shows before a sign-in starts over an account, and the method buttons wait for the answer', () => {
    const html = view({ confirmStart: 'claude-ai-login' });
    expect(html).toContain('data-testid="agent-auth-replace-words"');
    expect(html).toContain('already signed in');
    expect(html).toContain('data-testid="agent-auth-replace-yes"');
    expect(html).toMatch(/data-testid="agent-auth-method"[^>]*disabled|disabled=""[^>]*data-testid="agent-auth-method"/);
  });

  it('a signed-out sign-in has no logout and no replace confirm', () => {
    const html = view({ auth: auth({ state: 'signed_out' }) });
    expect(html).not.toContain('agent-auth-logout');
    expect(html).not.toContain('agent-auth-replace');
    expect(html).toContain('Claude Code is not signed in.');
  });

  it('a dedicated folder is said to be the profile own', () => {
    expect(view({ auth: auth({ home: 'dedicated', profile: 'office' }) })).toContain('profile &quot;office&quot; alone');
  });

  it('a paste-code wait shows the link and the answer box; the key box is a password field', () => {
    const waiting = view({ auth: auth({ state: 'signed_out' }), attempt: attempt({ action: { type: 'paste_code', url: 'https://claude.example.test/oauth/authorize?code=true' } }) });
    expect(waiting).toContain('data-testid="agent-auth-link"');
    expect(waiting).toContain('data-testid="agent-auth-answer"');
    expect(waiting).not.toContain('Sign in with');
    const key = view({ auth: auth({ agent: 'codex', state: 'signed_out' }), attempt: attempt({ state: 'needs_input', how: 'api_key', action: { type: 'give_key' } }) });
    expect(key).toContain('type="password"');
  });

  it('a mid-login reload shows the bridge note, and a failed attempt shows its sentence', () => {
    expect(view({ auth: auth({ state: 'unknown', note: 'A sign-in is under way on this machine.' }) })).toContain('A sign-in is under way on this machine.');
    const failed = view({ auth: auth({ state: 'signed_out' }), attempt: attempt({ state: 'failed', message: 'The sign-in was refused. Check the code or key and start again.' }) });
    expect(failed).toContain('data-state="failed"');
    expect(failed).toContain('The sign-in was refused.');
  });
});
