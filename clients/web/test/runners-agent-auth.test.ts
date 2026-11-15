import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentAuth, AgentAuthAttempt } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';
import { agentLogout, answerAgentLogin, cancelAgentLogin, fetchAgentAuth, startAgentLogin } from '../src/screens/admin/runners/api';
import { agentOf, answerBody, answerProblem, attemptWords, hasAgentSignin, homeWords, isLive, logoutWords, replaceWords, needsAnswer, pollDelayMs, statusWords } from '../src/screens/admin/runners/agent-auth';

/*
 * The agent sign-in on the Runners page (P25-09): which runners get the button, the words of each state, what blocks Send, and the exact calls that leave the browser.
 */

const RUNNER = '00000000-0000-7000-8000-0000000d0001';
const attempt = (over: Partial<AgentAuthAttempt> = {}): AgentAuthAttempt => ({ id: 'a1', methodId: 'm', how: 'device_code', state: 'waiting', action: null, message: null, ...over });
const auth = (over: Partial<AgentAuth> = {}): AgentAuth => ({ agent: 'codex', profile: 'codex', home: 'shared', state: 'signed_out', kind: null, canLogout: true, methods: [], attempt: null, note: null, ...over });

describe('which runners sign in this way', () => {
  it('only a gateway whose address answers as a Claude Code or Codex bridge', () => {
    expect(hasAgentSignin({ kind: 'hermes_gateway', agent: 'codex' })).toBe(true);
    expect(hasAgentSignin({ kind: 'hermes_gateway', agent: 'claude-code' })).toBe(true);
    expect(hasAgentSignin({ kind: 'hermes_gateway', agent: 'hermes' })).toBe(false);
    expect(hasAgentSignin({ kind: 'claude_cli', agent: 'hermes' })).toBe(false);
    // P26-09: a pod runner signs in from this page unless a sign-in file was uploaded for it (the older way stays for those runners)
    expect(hasAgentSignin({ kind: 'claude_cli', agent: 'hermes', uploadedAt: null })).toBe(true);
    expect(hasAgentSignin({ kind: 'codex_cli', agent: 'hermes', uploadedAt: null })).toBe(true);
    expect(hasAgentSignin({ kind: 'codex_cli', agent: 'hermes', uploadedAt: '2026-11-06T10:00:00.000Z' })).toBe(false);
    expect(hasAgentSignin({ kind: 'llm_gateway', agent: 'hermes', uploadedAt: null })).toBe(false);
    expect(agentOf({ kind: 'claude_cli', agent: 'hermes' })).toBe('claude-code');
    expect(agentOf({ kind: 'codex_cli', agent: 'hermes' })).toBe('codex');
    expect(agentOf({ kind: 'hermes_gateway', agent: 'codex' })).toBe('codex');
    expect(agentOf({ kind: 'hermes_gateway', agent: 'hermes' })).toBeNull();
  });
});

describe('the words', () => {
  it('says the state in one plain sentence and never an account', () => {
    expect(statusWords(auth({ state: 'signed_in', agent: 'claude-code' }))).toBe('Claude Code is signed in.');
    expect(statusWords(auth({ state: 'signed_out' }))).toBe('Codex is not signed in.');
    expect(statusWords(auth({ state: 'signed_in', kind: 'gateway' }))).toMatch(/model gateway/);
    expect(statusWords(auth({ state: 'unknown' }))).toMatch(/did not say/);
  });

  it('says what to do for each kind of attempt, and the bridge sentence when there is one', () => {
    const url = 'https://auth.example.test/device';
    expect(attemptWords(attempt({ action: { type: 'enter_code', url, code: 'AB-123' } }))).toMatch(/enter the code/);
    expect(attemptWords(attempt({ action: { type: 'paste_code', url } }))).toMatch(/paste the code/);
    expect(attemptWords(attempt({ state: 'needs_input', action: { type: 'give_key' } }))).toMatch(/API key/);
    expect(attemptWords(attempt({ state: 'failed', message: 'That code was not accepted.' }))).toBe('That code was not accepted.');
    expect(attemptWords(attempt({ state: 'done' }))).toBe('Signed in.');
  });
});

describe('polling and answering', () => {
  it('asks again while an attempt is live, and stops when it ends', () => {
    for (const state of ['starting', 'waiting', 'checking'] as const) expect(isLive(attempt({ state }))).toBe(true);
    for (const state of ['done', 'failed', 'cancelled', 'needs_input'] as const) expect(isLive(attempt({ state }))).toBe(false);
    expect(isLive(null)).toBe(false);
    expect(pollDelayMs(attempt({ state: 'checking' }))).toBeLessThan(pollDelayMs(attempt({ state: 'waiting' })));
  });

  it('shows the answer box for a key, and for a paste-code wait', () => {
    const url = 'https://auth.example.test/x';
    expect(needsAnswer(attempt({ state: 'needs_input', action: { type: 'give_key' } }))).toBe(true);
    expect(needsAnswer(attempt({ state: 'waiting', action: { type: 'paste_code', url } }))).toBe(true);
    expect(needsAnswer(attempt({ state: 'waiting', action: { type: 'enter_code', url, code: 'AB-123' } }))).toBe(false);
    expect(needsAnswer(null)).toBe(false);
  });

  it('blocks Send for an empty, multi-line or too short answer, and builds the body by what is asked', () => {
    const key = attempt({ state: 'needs_input', action: { type: 'give_key' } });
    const paste = attempt({ state: 'waiting', action: { type: 'paste_code', url: 'https://auth.example.test/x' } });
    expect(answerProblem(key, 'short')).toMatch(/at least 8/);
    expect(answerProblem(key, 'sk-long-enough-key')).toBeNull();
    expect(answerProblem(paste, '  ')).toMatch(/Paste the code/);
    expect(answerProblem(paste, 'a\nb')).toMatch(/one line/);
    expect(answerProblem(paste, 'abc.def')).toBeNull();
    expect(answerProblem(null, 'x')).toMatch(/nothing to answer/);
    expect(answerBody(key, ' sk-long-enough-key ')).toEqual({ attemptId: 'a1', apiKey: 'sk-long-enough-key' });
    expect(answerBody(paste, ' abc.def ')).toEqual({ attemptId: 'a1', code: 'abc.def' });
  });
});

describe('the calls reach the routes the plugin mounts', () => {
  let seen: TransportRequest[] = [];
  beforeEach(() => {
    seen = [];
    setTransport(async (req) => {
      seen.push(req);
      return { status: 418, body: { error: { code: 'internal', message: 'stop' } } };
    });
  });
  const send = async (run: () => Promise<unknown>): Promise<TransportRequest> => {
    await run().catch(() => undefined);
    const req = seen.at(-1);
    if (!req) throw new Error('no request was sent');
    return req;
  };

  it('writes each one out', async () => {
    expect(await send(() => fetchAgentAuth(RUNNER))).toMatchObject({ method: 'GET', url: `/api/admin/bot-runners/${RUNNER}/agent-auth` });
    const start = await send(() => startAgentLogin(RUNNER, 'chat-gpt-device-code'));
    expect(start).toMatchObject({ method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/agent-auth/login` });
    expect(JSON.parse(String(start.body))).toEqual({ methodId: 'chat-gpt-device-code' });
    const answer = await send(() => answerAgentLogin(RUNNER, { attemptId: 'a1', code: 'abc' }));
    expect(answer).toMatchObject({ method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/agent-auth/answer` });
    expect(JSON.parse(String(answer.body))).toEqual({ attemptId: 'a1', code: 'abc' });
    const cancel = await send(() => cancelAgentLogin(RUNNER, 'a1'));
    expect(cancel).toMatchObject({ method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/agent-auth/cancel` });
    expect(JSON.parse(String(cancel.body))).toEqual({ attemptId: 'a1' });
    expect(JSON.parse(String((await send(() => cancelAgentLogin(RUNNER))).body))).toEqual({});
    expect(await send(() => agentLogout(RUNNER))).toMatchObject({ method: 'POST', url: `/api/admin/bot-runners/${RUNNER}/agent-auth/logout` });
  });

  it('parses the server answer with the shared schemas', async () => {
    setTransport(async () => ({ status: 200, body: { auth: auth({ methods: [{ id: 'm', name: 'Sign in with ChatGPT', description: '', how: 'device_code' }] }) } }));
    const res = await fetchAgentAuth(RUNNER);
    expect(res.auth.methods[0]?.name).toBe('Sign in with ChatGPT');
  });
});

describe('the words for a pod runner', () => {
  const signedIn = { agent: 'codex', state: 'signed_in', kind: 'account', home: 'dedicated', profile: 'default', methods: [], canLogout: true, attempt: null } as unknown as AgentAuth;
  const pod = { kind: 'codex_cli' as const, baseUrl: null };
  const bridge = { kind: 'hermes_gateway' as const, baseUrl: 'http://10.0.0.5:8650' };

  it('say the pod, not a machine, and keep the machine words for a bridge runner', () => {
    for (const text of [homeWords(signedIn, pod), logoutWords(signedIn, pod), replaceWords(signedIn, pod)]) {
      expect(text).toContain('pod');
      expect(text).not.toContain('bridge machine');
      expect(text).not.toContain('terminal');
    }
    expect(logoutWords(signedIn, bridge)).toContain('10.0.0.5:8650');
    expect(homeWords(signedIn, bridge)).toContain('10.0.0.5:8650');
  });
});
