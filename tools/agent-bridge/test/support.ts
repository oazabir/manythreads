import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type BridgeConfig } from '../src/config.ts';
import { startBridge, type Bridge } from '../src/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const KEY = 'test-bridge-key-0123456789';
export const FAKE_CLAUDE = join(here, 'fixtures', 'fake-claude.mjs');
export const FAKE_CODEX = join(here, 'fixtures', 'fake-codex.mjs');

export interface Harness {
  bridge: Bridge;
  dir: string;
  work: string;
  config: BridgeConfig;
  calls(): Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  close(): Promise<void>;
}

export async function harness(over: Record<string, unknown> = {}, agent: 'claude-code' | 'codex' = 'claude-code', serverOpts: Partial<Parameters<typeof startBridge>[0]> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const work = join(dir, 'work');
  process.env['FAKE_CLI_DIR'] = dir;
  process.env['AGENT_BRIDGE_API_KEY'] = KEY; // the bridge must keep this away from its children
  const config = parseConfig({
    profiles: { default: { agent, workdir: work, model: 'sonnet', passEnv: ['FAKE_CLI_DIR'] }, other: { agent, workdir: join(dir, 'other'), passEnv: ['FAKE_CLI_DIR'] } },
    bin: { claude: FAKE_CLAUDE, codex: FAKE_CODEX },
    killGraceSeconds: 0.3,
    budgetGraceSeconds: 0.2,
    ...over,
  });
  const bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: () => undefined, tmpRoot: dir, ...serverOpts });
  return {
    bridge,
    dir,
    work,
    config,
    calls: () => (existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
    close: async () => {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const auth = { authorization: `Bearer ${KEY}` };

export async function start(h: Harness, body: Record<string, unknown>, headers: Record<string, string> = {}, profile = 'default'): Promise<Response> {
  return fetch(`${h.bridge.url}/p/${profile}/v1/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

/** Read an event stream to its end (or until `stopAfter` frames), as parsed frames with their `id:` lines. */
export async function events(h: Harness, runId: string, query = '', profile = 'default', stopAfter = Infinity): Promise<Array<{ id: string | null; data: Record<string, any> }>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctl = new AbortController();
  const res = await fetch(`${h.bridge.url}/p/${profile}/v1/runs/${runId}/events${query}`, { headers: { ...auth, accept: 'text/event-stream' }, signal: ctl.signal });
  const out: Array<{ id: string | null; data: Record<string, any> }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const decoder = new TextDecoder();
  let buf = '';
  const reader = res.body!.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (let cut = buf.indexOf('\n\n'); cut !== -1; cut = buf.indexOf('\n\n')) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!data) continue;
      out.push({ id: frame.split('\n').find((l) => l.startsWith('id:'))?.slice(3).trim() ?? null, data: JSON.parse(data.slice(5)) });
      if (out.length >= stopAfter) {
        ctl.abort();
        return out;
      }
    }
  }
  return out;
}

export async function getRun(h: Harness, runId: string): Promise<Record<string, any>> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return (await fetch(`${h.bridge.url}/p/default/v1/runs/${runId}`, { headers: auth })).json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out waiting');
}

export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
