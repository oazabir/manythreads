import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// P27-19: the claude-pod-fake image's ACP side, as the pod runs it: the bundle (`bundle.mjs`) run with plain node by the image's `claude-agent-acp` wrapper. The wizard's
// "sign in the Claude pod" step is completed with the code the wrapper accepts; any other code is refused, and nothing is signed in before it.

const HERE = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(HERE, '..', '..', '..', 'deploy', 'images', 'claude-pod-fake', 'claude-agent-acp.sh');
let dir = '';
let bundle = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-pod-acp-'));
  bundle = execFileSync(process.execPath, [join(HERE, '..', 'bundle.mjs'), join(dir, 'agent.mjs')], { encoding: 'utf8' }).trim();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Runs the wrapper like the bridge does; `lines` are fed to stdin one after the other, and the result is what it printed and its exit code. */
function run(args: string[], lines: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn('sh', [WRAPPER, ...args], { env: { ...process.env, FAKE_ACP_BUNDLE: bundle, CLAUDE_CONFIG_DIR: join(dir, 'claude'), ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', (code) => resolve({ code, out }));
    (async () => {
      for (const l of lines) {
        await new Promise((r) => setTimeout(r, 400));
        child.stdin.write(`${l}\n`);
      }
    })().catch(() => undefined);
  });
}

describe('the pod stand-in for the Claude adapter', () => {
  it('bundles to one file that runs with plain node', () => {
    expect(existsSync(bundle)).toBe(true);
    expect(readFileSync(bundle, 'utf8').length).toBeGreaterThan(10_000);
  });

  it('refuses a wrong code and signs nothing in; the right code (from FAKE_SIGNIN_CODE) signs in and the sign-in is kept', async () => {
    const env = { FAKE_SIGNIN_CODE: 'wizard-code#wizard' };
    const wrong = await run(['--cli', 'auth', 'login', '--claudeai'], ['not-the-code#nope'], env);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain("wasn't accepted");
    expect(existsSync(join(dir, 'claude', 'fake-acp', 'auth.json')) ? (JSON.parse(readFileSync(join(dir, 'claude', 'fake-acp', 'auth.json'), 'utf8')) as { signedIn: boolean }).signedIn : false).toBe(false);

    const right = await run(['--cli', 'auth', 'login', '--claudeai'], ['wizard-code#wizard'], env);
    expect(right.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'claude', 'fake-acp', 'auth.json'), 'utf8'))).toMatchObject({ signedIn: true });
  });

  it('the default code is the one the image documents', async () => {
    const ok = await run(['--cli', 'auth', 'login', '--claudeai'], ['stand-in-code#stand-in'], { CLAUDE_CONFIG_DIR: join(dir, 'claude2') });
    expect(ok.code).toBe(0);
  });

  it('an agent that is not signed in refuses a prompt, and takes it after the sign-in', async () => {
    const config = join(dir, 'claude3');
    const ask = async (): Promise<string> => {
      const child = spawn('sh', [WRAPPER], { env: { ...process.env, FAKE_ACP_BUNDLE: bundle, CLAUDE_CONFIG_DIR: config }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString()));
      const send = (id: number, method: string, params: unknown): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      await new Promise((r) => setTimeout(r, 600));
      send(2, 'session/new', { cwd: dir, mcpServers: [] });
      await new Promise((r) => setTimeout(r, 400));
      const sessionId = /"sessionId":"([^"]+)"/.exec(out)?.[1] ?? '';
      send(3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
      await new Promise((r) => setTimeout(r, 800));
      child.kill('SIGKILL');
      return out;
    };
    expect(await ask()).toContain('Authentication required');
    expect((await run(['--cli', 'auth', 'login', '--claudeai'], ['stand-in-code#stand-in'], { CLAUDE_CONFIG_DIR: config })).code).toBe(0);
    const after = await ask();
    expect(after).not.toContain('Authentication required');
    expect(after).toContain('"stopReason":"end_turn"');
  });
});
