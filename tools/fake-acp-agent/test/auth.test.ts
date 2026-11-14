import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ClientCapabilities } from '@agentclientprotocol/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { runTerminalAuth } from '../src/login.ts';
import { createFakeAcpAgent } from '../src/agent.ts';
import { DEFAULT_SCRIPT, type FakeScript } from '../src/script.ts';
import { OURS, harness, start, waitFor } from './helpers.ts';

/* Sign-in and sign-out as measured (P25-01): methods per adapter, the Codex device code in an elicitation, Claude's terminal program. */

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'fake-acp-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const ids = (methods: unknown): string[] => (methods as Array<{ id: string }>).map((m) => m.id);

describe('initialize', () => {
  const initialize = async (flavor: 'claude' | 'codex' | 'hermes', caps: ClientCapabilities) => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor });
    const answer = await h.run((agent) => agent.request('initialize', { protocolVersion: 1, clientCapabilities: caps }));
    return { h, answer };
  };

  it('claude: no sign-in methods without our capabilities, four with them; logout and auth status advertised', async () => {
    expect(ids((await initialize('claude', {})).answer.authMethods)).toEqual([]);
    const ours = (await initialize('claude', OURS)).answer;
    expect(ids(ours.authMethods)).toEqual(['claude-ai-login', 'console-login', 'gateway', 'gateway-bedrock']);
    expect((ours.authMethods as Array<{ type?: string; args?: string[] }>)[0]).toMatchObject({ type: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] });
    expect(ours.agentCapabilities).toMatchObject({
      auth: { logout: {}, status: {} },
      mcpCapabilities: { http: true, sse: true },
      sessionCapabilities: { resume: {}, list: {} },
    });
  });

  it('codex: api-key and chat-gpt bare; the device code and the gateway only with our capabilities', async () => {
    expect(ids((await initialize('codex', {})).answer.authMethods)).toEqual(['api-key', 'chat-gpt']);
    const ours = (await initialize('codex', OURS)).answer;
    expect(ids(ours.authMethods)).toEqual(['api-key', 'chat-gpt', 'chat-gpt-device-code', 'gateway']);
    expect(ours.agentCapabilities).toMatchObject({ mcpCapabilities: { http: true, sse: false }, auth: { logout: {} } });
  });

  it('hermes: custom and a terminal setup, no logout, no mcp capabilities, whatever the client says', async () => {
    const a = (await initialize('hermes', {})).answer;
    const b = (await initialize('hermes', OURS)).answer;
    expect(ids(a.authMethods)).toEqual(['custom', 'hermes-setup']);
    expect(ids(b.authMethods)).toEqual(['custom', 'hermes-setup']);
    expect(b.agentCapabilities).not.toHaveProperty('mcpCapabilities');
    expect(b.agentCapabilities).not.toHaveProperty('auth');
  });

  it('pushes _auth/status_update after initialize, with the e-mail the bridge must never forward (claude also auth/status_update)', async () => {
    const h = harness(DEFAULT_SCRIPT);
    await h.run(async (agent) => {
      await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
      await waitFor(() => h.inbound.length >= 2);
    });
    expect(h.inbound.map((i) => i.method)).toEqual(['_auth/status_update', 'auth/status_update']);
    expect(h.inbound[0]?.params).toMatchObject({ authStatus: { kind: 'account', account: { email: 'person@example.test' } } });
  });
});

describe('Codex device code', () => {
  const codex: FakeScript = {
    flavor: 'codex',
    auth: { signedIn: false, url: 'https://auth.example.test/codex/device', deviceCode: 'WXYZ-98765' },
    scenarios: DEFAULT_SCRIPT.scenarios,
  };

  it('asks the person through a URL elicitation with the code in the message, and signs in once accepted', async () => {
    const h = harness(codex);
    expect(h.fake.isSignedIn()).toBe(false);
    await h.run(async (agent) => {
      await start(agent);
      await expect(agent.request('authenticate', { methodId: 'chat-gpt-device-code' })).resolves.toEqual({});
    });
    const ask = h.inbound.find((i) => i.method === 'elicitation/create');
    expect(ask?.params).toMatchObject({ mode: 'url', url: 'https://auth.example.test/codex/device', message: 'Sign in to ChatGPT and enter this code: WXYZ-98765' });
    expect(h.inbound.some((i) => i.method === 'elicitation/complete')).toBe(true);
    expect(h.fake.isSignedIn()).toBe(true);
  });

  it('fails at once with -32000 when the person cancels', async () => {
    const h = harness(codex, { elicitation: 'cancel' });
    await h.run(async (agent) => {
      await start(agent);
      await expect(agent.request('authenticate', { methodId: 'chat-gpt-device-code' })).rejects.toMatchObject({
        code: -32000,
        message: 'Authentication required: Sign-in did not complete',
      });
    });
    expect(h.fake.isSignedIn()).toBe(false);
  });

  it('stays open after accept while the person finishes (pendingMs null) until the sign-in completes', async () => {
    const h = harness({ ...codex, auth: { ...codex.auth, pendingMs: null } });
    await h.run(async (agent) => {
      await start(agent);
      let done = false;
      const pending = agent.request('authenticate', { methodId: 'chat-gpt-device-code' }).then(() => (done = true));
      await waitFor(() => h.inbound.some((i) => i.method === 'elicitation/create'));
      await new Promise((r) => setTimeout(r, 100));
      expect(done).toBe(false);
      h.fake.completeSignIn();
      await pending;
    });
    expect(h.fake.isSignedIn()).toBe(true);
  });
});

describe('logout, gateway, auth status, required sign-in', () => {
  it('logout signs out and pushes the new status', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor: 'codex' });
    await h.run(async (agent) => {
      await start(agent);
      h.inbound.length = 0;
      await expect(agent.request('logout', {})).resolves.toEqual({});
    });
    expect(h.fake.isSignedIn()).toBe(false);
    expect(h.inbound[0]).toMatchObject({ method: '_auth/status_update', params: { authStatus: { kind: 'none' } } });
  });

  it('hermes has no logout', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, flavor: 'hermes' });
    await h.run(async (agent) => {
      await start(agent);
      await expect(agent.request('logout', {})).rejects.toMatchObject({ code: -32601 });
    });
  });

  it('the gateway method signs in, in memory, with the gateway kind; the settings are in what the fake received', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, auth: { signedIn: false } });
    await h.run(async (agent) => {
      await start(agent);
      await agent.request('authenticate', { methodId: 'gateway', _meta: { gateway: { baseUrl: 'https://llm.example.test', headers: { 'x-team': 'a' } } } });
    });
    expect(h.fake.isSignedIn()).toBe(true);
    expect(h.fake.received.find((r) => r.method === 'authenticate')?.params).toMatchObject({
      methodId: 'gateway',
      _meta: { gateway: { baseUrl: 'https://llm.example.test' } },
    });
    expect(h.inbound.at(-1)?.params).toMatchObject({ authStatus: { kind: 'gateway' } });
  });

  it('claude answers auth/status with the state and the account; a terminal method is refused by authenticate', async () => {
    const h = harness(DEFAULT_SCRIPT);
    await h.run(async (agent) => {
      await start(agent);
      await expect(agent.request('auth/status', {})).resolves.toMatchObject({ state: 'authenticated', accounts: [{ active: true, email: 'person@example.test' }] });
      await agent.request('logout', {});
      await expect(agent.request('auth/status', {})).resolves.toMatchObject({ state: 'unauthenticated', accounts: [] });
      await expect(agent.request('authenticate', { methodId: 'claude-ai-login' })).rejects.toMatchObject({ code: -32602 });
    });
  });

  it('a prompt fails with -32000 when sign-in is required and the agent is signed out', async () => {
    const h = harness({ ...DEFAULT_SCRIPT, auth: { signedIn: false, requireSignIn: true } });
    await h.run(async (agent) => {
      const sessionId = await start(agent);
      await expect(agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[hello]]' }] })).rejects.toMatchObject({
        code: -32000,
        message: 'Authentication required',
      });
      await agent.request('authenticate', { methodId: 'gateway' });
      await expect(agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[hello]]' }] })).resolves.toMatchObject({ stopReason: 'end_turn' });
    });
  });
});

describe('the terminal sign-in program (Claude: --cli auth login --claudeai)', () => {
  const io = (lines: Array<string | null>) => {
    const out: string[] = [];
    return { out, io: { write: (t: string) => void out.push(t), readLine: async () => lines.shift() ?? null } };
  };

  it('prints the page and a paste prompt, takes the code, and the agent is then signed in (the same state dir)', async () => {
    const stateDir = tmp();
    const script: FakeScript = { ...DEFAULT_SCRIPT, stateDir, auth: { signedIn: false, url: 'https://claude.example.test/oauth/authorize?x=1' } };
    expect(createFakeAcpAgent(script).isSignedIn()).toBe(false);
    const { out, io: terminal } = io(['pasted-code-123']);
    await expect(runTerminalAuth(['auth', 'login', '--claudeai'], script, terminal)).resolves.toBe(0);
    const text = out.join('');
    expect(text).toContain('Opening browser to sign in');
    expect(text).toContain("If the browser didn't open, visit: https://claude.example.test/oauth/authorize?x=1");
    expect(text).toContain('Paste code here if prompted >');
    expect(text).not.toContain('pasted-code-123');
    expect(JSON.parse(readFileSync(join(stateDir, 'auth.json'), 'utf8'))).toMatchObject({ signedIn: true });
    expect(createFakeAcpAgent(script).isSignedIn()).toBe(true);
    await expect(runTerminalAuth(['auth', 'logout'], script, io([]).io)).resolves.toBe(0);
    expect(createFakeAcpAgent(script).isSignedIn()).toBe(false);
  });

  it('exits 1 without signing in when nothing is pasted', async () => {
    const stateDir = tmp();
    const script: FakeScript = { ...DEFAULT_SCRIPT, stateDir, auth: { signedIn: false } };
    const { out, io: terminal } = io(['']);
    await expect(runTerminalAuth(['auth', 'login', '--claudeai'], script, terminal)).resolves.toBe(1);
    expect(out.join('')).toContain('Login cancelled');
    expect(createFakeAcpAgent(script).isSignedIn()).toBe(false);
  });
});
