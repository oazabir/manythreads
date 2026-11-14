import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/* The fake agent as a process, spoken to the way the bridge speaks to a real adapter: JSON lines on stdin and stdout. */

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function spawnCli(args: string[], env: Record<string, string> = {}): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}

/** A tiny JSON-RPC client over a child's stdio. */
function rpc(child: ChildProcessWithoutNullStreams) {
  const lines: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
    for (const w of waiters.splice(0)) w();
  });
  let next = 0;
  const until = async (find: () => unknown, ms = 15_000): Promise<void> => {
    const end = Date.now() + ms;
    while (!find()) {
      if (Date.now() > end) throw new Error(`timed out; saw ${JSON.stringify(lines).slice(0, 500)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return {
    lines,
    async call(method: string, params: unknown): Promise<Record<string, unknown>> {
      const id = ++next;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      await until(() => lines.find((l) => l.id === id && ('result' in l || 'error' in l)));
      return lines.find((l) => l.id === id && ('result' in l || 'error' in l)) as Record<string, unknown>;
    },
    notify(method: string, params: unknown) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    until,
  };
}

describe('stdio', () => {
  it('speaks ACP over stdin and stdout: initialize, session/new, a prompt with message chunks, one JSON object per line', async () => {
    const child = spawnCli([], { FAKE_ACP_FLAVOR: 'codex' });
    const client = rpc(child);
    const init = await client.call('initialize', { protocolVersion: 1, clientCapabilities: { auth: { terminal: true } } });
    expect(init.result).toMatchObject({ protocolVersion: 1, agentInfo: { name: '@agentclientprotocol/codex-acp' } });
    const created = (await client.call('session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string };
    const answer = await client.call('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: '[[hello]]' }] });
    expect(answer.result).toMatchObject({ stopReason: 'end_turn' });
    const text = client.lines
      .filter((l) => l.method === 'session/update')
      .map((l) => (l.params as { update: { sessionUpdate: string; content?: { text: string } } }).update)
      .filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => u.content?.text)
      .join('');
    expect(text).toBe('Hello from the fake agent.');
  });

  it('plays a script from FAKE_ACP_SCRIPT_JSON and stops a slow step on session/cancel', async () => {
    const script = { flavor: 'claude', scenarios: { slow: [{ do: 'step', title: 'sleep 60', kind: 'execute', toolName: 'Bash', ms: 60_000 }] }, default: 'slow' };
    const child = spawnCli([], { FAKE_ACP_SCRIPT_JSON: JSON.stringify(script) });
    const client = rpc(child);
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const created = (await client.call('session/new', { cwd: process.cwd(), mcpServers: [] })).result as { sessionId: string };
    const pending = client.call('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await client.until(() =>
      client.lines.find((l) => l.method === 'session/update' && (l.params as { update: { sessionUpdate: string } }).update.sessionUpdate === 'tool_call'),
    );
    const t = Date.now();
    client.notify('session/cancel', { sessionId: created.sessionId });
    expect((await pending).result).toMatchObject({ stopReason: 'cancelled' });
    expect(Date.now() - t).toBeLessThan(2000);
  });

  it('exits when its stdin closes', async () => {
    const child = spawnCli([]);
    const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
    const client = rpc(child);
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    child.stdin.end();
    await expect(exited).resolves.toBe(0);
  });
});

describe('--cli auth login', () => {
  it('prints the page, takes a pasted code on stdin, exits 0, and a second agent process sees the sign-in', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-acp-'));
    dirs.push(stateDir);
    const file = join(stateDir, 'script.json');
    writeFileSync(
      file,
      JSON.stringify({
        flavor: 'claude',
        stateDir,
        auth: { signedIn: false, url: 'https://claude.example.test/authorize' },
        scenarios: { a: [{ do: 'text', text: 'x' }] },
      }),
    );
    const login = spawnCli([`--script=${file}`, '--cli', 'auth', 'login', '--claudeai']);
    let out = '';
    login.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => login.on('exit', resolve));
    for (let i = 0; i < 300 && !out.includes('Paste code here'); i++) await new Promise((r) => setTimeout(r, 50));
    expect(out).toContain('https://claude.example.test/authorize');
    login.stdin.write('the-code#state1\n');
    await expect(exited).resolves.toBe(0);
    expect(out).toContain('Login successful');
    expect(JSON.parse(readFileSync(join(stateDir, 'auth.json'), 'utf8'))).toMatchObject({ signedIn: true });

    const agent = spawnCli([`--script=${file}`]);
    const client = rpc(agent);
    await client.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const status = await client.call('auth/status', {});
    expect(status.result).toMatchObject({ state: 'authenticated' });
  });
});

describe('--cli auth login under a terminal', () => {
  const script = (stateDir: string): string => {
    const file = join(stateDir, 'script.json');
    writeFileSync(file, JSON.stringify({ flavor: 'claude', stateDir, auth: { signedIn: false }, scenarios: { a: [{ do: 'text', text: 'x' }] } }));
    return file;
  };
  const underTerminal = (args: string[]): ChildProcessWithoutNullStreams => {
    const child = spawn('script', ['-q', '-e', '-f', '-c', `${process.execPath} --import tsx ${CLI} ${args.join(' ')}`, '/dev/null'], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  };

  it('is in raw mode (no echo of what is pasted) and ends the line at a carriage return, as the real program does', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-acp-'));
    dirs.push(stateDir);
    const login = underTerminal([`--script=${script(stateDir)}`, '--cli', 'auth', 'login', '--claudeai']);
    let out = '';
    login.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => login.on('exit', resolve));
    for (let i = 0; i < 300 && !out.includes('Paste code here'); i++) await new Promise((r) => setTimeout(r, 50));
    login.stdin.write('SECRET-pasted-code#state9');
    await new Promise((r) => setTimeout(r, 100));
    login.stdin.write('\r');
    await expect(exited).resolves.toBe(0);
    expect(out).toContain('Login successful');
    expect(out).not.toContain('SECRET-pasted-code');
  });

  it('refuses a wrong code with exit 1', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fake-acp-'));
    dirs.push(stateDir);
    const login = underTerminal([`--script=${script(stateDir)}`, '--cli', 'auth', 'login', '--claudeai']);
    let out = '';
    login.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((resolve) => login.on('exit', resolve));
    for (let i = 0; i < 300 && !out.includes('Paste code here'); i++) await new Promise((r) => setTimeout(r, 50));
    login.stdin.write('nope\n');
    await expect(exited).resolves.toBe(1);
    expect(out).toContain("That code wasn't accepted");
  });
});
