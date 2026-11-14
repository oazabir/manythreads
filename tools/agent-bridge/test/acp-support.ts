import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type BridgeConfig } from '../src/config.ts';
import { startBridge, type Bridge } from '../src/server.ts';
import { auth, KEY } from './support.ts';

// A bridge whose profile is driven through ACP by the fake agent (tools/fake-acp-agent), started as a program the way a real adapter is.

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_CLI = join(here, '..', '..', 'fake-acp-agent', 'src', 'cli.ts');
const TSX = createRequire(import.meta.url).resolve('tsx/esm');

export type Flavor = 'claude' | 'codex' | 'hermes';
const AGENT = { claude: 'claude-code', codex: 'codex', hermes: 'hermes-acp' } as const;

export interface AcpHarness {
  bridge: Bridge;
  dir: string;
  stateDir: string;
  config: BridgeConfig;
  /** What the fake agent kept of its sessions (mode, config options, the MCP servers it was given, the prompts). */
  sessions(): Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The bridge's own log lines. */
  logs: string[];
  close(): Promise<void>;
}

export interface AcpOptions {
  flavor?: Flavor;
  /** The fake agent's script (JSON); default: the fake's built-in one. */
  script?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  config?: Record<string, unknown>;
  /** The `acp.gives` of a Hermes profile (what its home lets the agent do); default none, so a bot with no tools may run on it. */
  gives?: string[];
}

const PASS = ['FAKE_ACP_SCRIPT_JSON', 'FAKE_ACP_FLAVOR', 'FAKE_ACP_STATE_DIR'];

export async function acpHarness(o: AcpOptions = {}): Promise<AcpHarness> {
  const flavor = o.flavor ?? 'claude';
  const dir = mkdtempSync(join(tmpdir(), 'bridge-acp-'));
  const stateDir = join(dir, 'fake-state');
  process.env['AGENT_BRIDGE_API_KEY'] = KEY;
  process.env['FAKE_ACP_FLAVOR'] = flavor;
  process.env['FAKE_ACP_STATE_DIR'] = stateDir;
  if (o.script) process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify(o.script);
  else delete process.env['FAKE_ACP_SCRIPT_JSON'];
  const config = parseConfig({
    profiles: {
      default: {
        agent: AGENT[flavor],
        driver: 'acp',
        workdir: join(dir, 'work'),
        passEnv: PASS,
        acp: { command: process.execPath, args: ['--import', TSX, FAKE_CLI], ...(flavor === 'hermes' ? { gives: o.gives ?? [] } : {}) },
        ...o.profile,
      },
    },
    killGraceSeconds: 0.5,
    budgetGraceSeconds: 0.2,
    cancelGraceSeconds: 2,
    ...o.config,
  });
  const logs: string[] = [];
  const bridge = await startBridge({ config, apiKey: KEY, stateDir: join(dir, 'state'), port: 0, log: (line) => logs.push(line), tmpRoot: dir });
  return {
    bridge,
    logs,
    dir,
    stateDir,
    config,
    sessions: () => {
      const folder = join(stateDir, 'sessions');
      return existsSync(folder) ? readdirSync(folder).map((f) => JSON.parse(readFileSync(join(folder, f), 'utf8'))) : [];
    },
    close: async () => {
      await bridge.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Frame = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Starts a run and returns its id. */
export async function startRun(h: AcpHarness, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${h.bridge.url}/p/default/v1/runs`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as { run_id: string };
  return json.run_id;
}

/** Follows a run's event stream in the background: `frames` fills as they arrive, `done` settles when the stream ends. */
export function watch(h: AcpHarness, runId: string): { frames: Frame[]; done: Promise<void>; until(pred: (f: Frame) => boolean, ms?: number): Promise<Frame> } {
  const frames: Frame[] = [];
  const done = (async () => {
    const res = await fetch(`${h.bridge.url}/p/default/v1/runs/${runId}/events`, { headers: { ...auth, accept: 'text/event-stream' } });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) return;
      buf += decoder.decode(value, { stream: true });
      for (let cut = buf.indexOf('\n\n'); cut !== -1; cut = buf.indexOf('\n\n')) {
        const part = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = part.split('\n').find((l) => l.startsWith('data:'));
        if (data) frames.push(JSON.parse(data.slice(5)) as Frame);
      }
    }
  })().catch(() => undefined);
  const until = async (pred: (f: Frame) => boolean, ms = 15_000): Promise<Frame> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; saw ${JSON.stringify(frames.map((f) => f['event'])).slice(0, 400)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { frames, done, until };
}

export async function post(h: AcpHarness, runId: string, route: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: Frame }> {
  const res = await fetch(`${h.bridge.url}/p/default/v1/runs/${runId}/${route}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Frame };
}

/** A run to its end: the frames of its stream. */
export async function runToEnd(h: AcpHarness, body: Record<string, unknown>): Promise<Frame[]> {
  const id = await startRun(h, body);
  const w = watch(h, id);
  await w.done;
  return w.frames;
}

/** A run as the status endpoint tells it. */
export async function status(h: AcpHarness, runId: string): Promise<Frame> {
  return (await (await fetch(`${h.bridge.url}/p/default/v1/runs/${runId}`, { headers: auth })).json()) as Frame;
}

/** The fake agent's script for the NEXT adapter process the bridge starts (a process reads it when it starts). */
export function nextScript(script: Record<string, unknown>): void {
  process.env['FAKE_ACP_SCRIPT_JSON'] = JSON.stringify(script);
}

/** Polls a condition (instead of a fixed sleep). */
export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 15));
  }
}
