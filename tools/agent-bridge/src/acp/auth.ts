import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { client as createClient, methods, RequestError } from '@agentclientprotocol/sdk';
import { profileFor, type AgentKind, type BridgeConfig, type ProfileConfig } from '../config.ts';
import { redact, startChild } from '../process.ts';
import { childEnv } from '../runs.ts';
import { adapterCommand, flavorOf, type Flavor } from './adapter.ts';
import { lastTerminalLine, ptySupported, startPty, type PtyHandle } from './pty.ts';

// Sign-in and sign-out of an agent through its ACP adapter (P25-09, docs/plans/acp.md section 4.1, docs/spikes/acp-measured.md "Sign-in and sign-out").
//
// What each adapter does (measured):
//  * Codex: `authenticate chat-gpt-device-code` makes the adapter ask `elicitation/create` (url mode): a page and, only inside the message text, a one-time code. The
//    client answers `accept` and `authenticate` stays open until the person has entered the code. The adapter process must stay alive for that, so an attempt holds one.
//  * Claude: only terminal methods. The adapter's own program is run with the method's arguments under a pseudo-terminal; it prints a sign-in page and waits for a pasted code.
//  * Hermes: nothing to sign in (it uses its configured provider key); no `logout`.
//  * `auth/status` (Claude) and `_auth/status_update` (Claude, Codex) carry the account's e-mail and organization: only the state and the kind are read from them, the rest
//    is dropped here, and nothing the adapter sends about the account is ever returned or logged.
//
// A person's code or key goes from the page to this module and on to the program; it is never logged, never stored, and removed from every line this module keeps.
// A sign-in belongs to the tool, not to a profile (the profiles of one tool share its config folder), so there is one attempt at a time per tool.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type AuthState = 'signed_in' | 'signed_out' | 'unknown' | 'not_needed';
export type HowToSignIn = 'device_code' | 'paste_code' | 'api_key';
export type LoginAction = { type: 'enter_code'; url: string; code: string } | { type: 'open_url'; url: string } | { type: 'paste_code'; url: string } | { type: 'give_key' };
export type AttemptState = 'starting' | 'waiting' | 'needs_input' | 'checking' | 'done' | 'failed' | 'cancelled';

export interface AuthMethodView {
  id: string;
  name: string;
  description: string;
  how: HowToSignIn;
}

export interface AttemptView {
  id: string;
  methodId: string;
  state: AttemptState;
  action: LoginAction | null;
  /** One plain sentence for the person: what to do, or why it failed. Never a code, a key or a token. */
  message: string | null;
}

export interface AuthView {
  agent: AgentKind;
  state: AuthState;
  /** How the agent is signed in (`account`, `gateway`, `none`, ...), as the adapter words it; null when it did not say. Never an e-mail or an organization. */
  kind: string | null;
  canLogout: boolean;
  methods: AuthMethodView[];
  attempt: AttemptView | null;
  /** A plain sentence when something is worth saying (the agent needs no sign-in, the adapter could not be started). */
  note: string | null;
}

export class AuthRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AuthServiceOptions {
  config: BridgeConfig;
  log: (line: string) => void;
  /** Knobs for tests; the defaults are in the comments. */
  startWaitMs?: number; // 8 s: how long a login answers before the first thing to do is ready
  pushWaitMs?: number; // 1.5 s: how long a status check waits for the adapter's own state push
  statusTtlMs?: number; // 15 s: how long a status answer is reused
  deviceTimeoutMs?: number; // 15 min: a device code's life
  pasteTimeoutMs?: number; // 10 min: how long a pasted-code login waits
  keepFinishedMs?: number; // 10 min: how long a finished attempt can still be read
  stepTimeoutMs?: number; // 30 s: initialize, authenticate with a key, logout
}

const TERMINAL: ReadonlySet<AttemptState> = new Set(['done', 'failed', 'cancelled']);
const MAX_ANSWERS = 5;

/** The words the page shows for the failures a person can act on. One table, so the sentences cannot drift. */
export const AUTH_WORDS = {
  noAdapter: 'The agent\'s sign-in program could not be started on this machine. Check that it is installed.',
  noPty: 'This machine cannot run the agent\'s sign-in program here. Sign in on the machine itself, in a terminal.',
  notFinished: 'The sign-in did not finish. Start it again.',
  expired: 'The code ran out before the sign-in finished. Start it again.',
  refused: 'The sign-in was refused. Check the code or key and start again.',
  tooManyTries: 'That code or key was tried too many times. Start the sign-in again.',
  cancelled: 'The sign-in was cancelled.',
  busy: 'A sign-in is already in progress. Finish it or cancel it first.',
  noLogout: 'This agent has no sign-out. Remove its sign-in on the machine itself.',
  hermes: "This agent uses the workspace's model gateway. There is nothing to sign in.",
  opencode: 'Sign-in for this agent has not been checked yet.',
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The adapter process

interface Opened {
  agent: ReturnType<ReturnType<typeof createClient>['connect']>['agent'];
  init: Record<string, unknown>;
  /** The state pushes the adapter sent (`_auth/status_update`), reduced to what may be kept. */
  pushes: Array<{ kind: string | null }>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderrTail: string; spawnError: string | null }>;
  race<T>(p: Promise<T>, ms?: number): Promise<T>;
  close(): Promise<void>;
}

class AdapterEnded extends Error {
  constructor(readonly spawnError: string | null) {
    super('the adapter ended');
  }
}

/** Our client capabilities for a sign-in: the terminal methods, the gateway method and URL elicitation (the device code). No files, no terminal of ours. */
const SIGNIN_CAPABILITIES = { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true, _meta: { gateway: true } }, elicitation: { url: {} } };

const reduceKind = (v: unknown): string | null => (typeof v === 'string' && /^[a-z][a-z_-]{0,23}$/i.test(v) ? v.toLowerCase() : null);

export function authEnv(config: BridgeConfig, profile: ProfileConfig, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = childEnv(profile);
  if (profile.agent === 'claude-code' && config.bin.claude.includes('/') && env['CLAUDE_CODE_EXECUTABLE'] === undefined) env['CLAUDE_CODE_EXECUTABLE'] = config.bin.claude;
  if (profile.agent === 'codex' && config.bin.codex.includes('/') && env['CODEX_PATH'] === undefined) env['CODEX_PATH'] = config.bin.codex;
  return { ...env, ...extra };
}

async function openAdapter(
  config: BridgeConfig,
  profile: ProfileConfig,
  extraEnv: NodeJS.ProcessEnv,
  stepTimeoutMs: number,
  onElicitation: (params: Record<string, unknown>) => Promise<{ action: 'accept' | 'cancel' }>,
): Promise<Opened> {
  const cwd = resolvePath(profile.workdir);
  mkdirSync(cwd, { recursive: true });
  const { command, args } = adapterCommand(profile);
  let inbound!: ReadableStreamDefaultController<never>;
  const readable = new ReadableStream<never>({
    start(c) {
      inbound = c;
    },
  });
  let open = true;
  const closeInbound = (): void => {
    if (!open) return;
    open = false;
    try {
      inbound.close();
    } catch {
      /* already closed */
    }
  };
  const child = startChild(command, args, {
    cwd,
    env: authEnv(config, profile, extraEnv),
    stdin: null,
    onLine: (line) => {
      const t = line.trim();
      if (t === '' || t[0] !== '{' || !open) return;
      try {
        (inbound as unknown as ReadableStreamDefaultController<unknown>).enqueue(JSON.parse(t));
      } catch {
        /* a log line on stdout */
      }
    },
  });
  const writable = new WritableStream<never>({
    write(message) {
      if (!child.write(`${JSON.stringify(message)}\n`)) throw new Error('the adapter no longer reads');
    },
    close() {
      child.endInput();
    },
  });
  const exited = child.done.then((end) => {
    closeInbound();
    return end;
  });
  const gone = exited.then((end) => {
    throw new AdapterEnded(end.spawnError);
  });
  gone.catch(() => undefined);
  const race = <T>(p: Promise<T>, ms: number = stepTimeoutMs): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the adapter did not answer in time')), ms);
    });
    return Promise.race([p, gone, late]).finally(() => clearTimeout(timer));
  };
  const pushes: Array<{ kind: string | null }> = [];
  const app = createClient({ name: 'manythreads-bridge' })
    .onRequest(methods.client.elicitation.create, async ({ params }) => onElicitation(params as unknown as Record<string, unknown>))
    .onNotification('*', ({ method, params }) => {
      // Only the kind is read; the e-mail and the organization in the same message are never looked at.
      if (method !== '_auth/status_update' && method !== 'auth/status_update') return;
      const status = isRecord(params) && isRecord(params['authStatus']) ? params['authStatus'] : null;
      if (status !== null) pushes.push({ kind: reduceKind(status['kind']) });
    });
  const connection = app.connect({ readable, writable } as never);
  const close = async (): Promise<void> => {
    connection.close();
    child.endInput();
    child.signal('SIGTERM');
    const kill = setTimeout(() => child.signal('SIGKILL'), Math.max(1, config.killGraceSeconds) * 1000);
    kill.unref();
    await Promise.race([exited, sleep(Math.max(1, config.killGraceSeconds) * 1000 + 500)]);
    clearTimeout(kill);
  };
  try {
    const init = (await race(connection.agent.request('initialize', { protocolVersion: 1, clientCapabilities: SIGNIN_CAPABILITIES, clientInfo: { name: 'manythreads-bridge', version: '1' } } as never))) as unknown as Record<string, unknown>;
    return { agent: connection.agent, init, pushes, exited, race, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** How a method is signed in from the page, or null when the page cannot do it (a gateway method is the pod's business, `chat-gpt` needs a browser on this machine). */
export function classifyMethod(flavor: Flavor, method: Record<string, unknown>): HowToSignIn | null {
  const id = method['id'];
  if (typeof id !== 'string') return null;
  if (flavor === 'claude') {
    const args = Array.isArray(method['args']) ? method['args'] : [];
    return method['type'] === 'terminal' && args.includes('login') ? 'paste_code' : null;
  }
  if (flavor === 'codex') {
    if (id === 'chat-gpt-device-code') return 'device_code';
    // An API key would go around the workspace's model gateway: a pod never takes one (PLAN P19-13).
    if (id === 'api-key') return process.env['MANYTHREADS_BRIDGE_IN_POD'] === '1' ? null : 'api_key';
  }
  return null;
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');

function methodViews(flavor: Flavor, init: Record<string, unknown>): Array<AuthMethodView & { args: string[] }> {
  const raw = Array.isArray(init['authMethods']) ? init['authMethods'] : [];
  const out: Array<AuthMethodView & { args: string[] }> = [];
  for (const m of raw) {
    if (!isRecord(m)) continue;
    const how = classifyMethod(flavor, m);
    if (how === null) continue;
    const args = Array.isArray(m['args']) ? m['args'].filter((a): a is string => typeof a === 'string' && a.length <= 200).slice(0, 10) : [];
    out.push({ id: text(m['id'], 80), name: text(m['name'], 80) || text(m['id'], 80), description: text(m['description'], 200), how, args });
  }
  return out;
}

const hasLogout = (init: Record<string, unknown>): boolean => {
  const caps = isRecord(init['agentCapabilities']) ? init['agentCapabilities'] : {};
  return isRecord(caps['auth']) && caps['auth']['logout'] !== undefined;
};

const failureText = (err: unknown, secrets: readonly string[]): string => {
  if (err instanceof AdapterEnded) return err.spawnError === 'ENOENT' ? AUTH_WORDS.noAdapter : AUTH_WORDS.notFinished;
  if (err instanceof RequestError) {
    const joined = `${err.message} ${isRecord(err.data) && typeof err.data['details'] === 'string' ? err.data['details'] : ''}`;
    if (/did not complete|cancel/i.test(joined)) return AUTH_WORDS.notFinished;
    return `The sign-in was refused: ${redact(err.message, secrets).slice(0, 160)}`;
  }
  return AUTH_WORDS.notFinished;
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// One attempt

class Attempt {
  readonly id = randomUUID();
  state: AttemptState = 'starting';
  action: LoginAction | null = null;
  message: string | null = null;
  finishedAt: number | null = null;
  answers = 0;
  /** Set by the flow: takes what the person typed. Returns false when the attempt is not waiting for it. */
  answer: ((value: { code?: string; apiKey?: string }) => Promise<boolean>) | null = null;
  private stops: Array<() => void | Promise<void>> = [];
  private watchers: Array<() => void> = [];

  constructor(
    readonly agent: AgentKind,
    readonly methodId: string,
    readonly how: HowToSignIn,
  ) {}

  view(): AttemptView {
    return { id: this.id, methodId: this.methodId, state: this.state, action: this.action, message: this.message };
  }

  get over(): boolean {
    return TERMINAL.has(this.state);
  }

  /** Resolves when the state changes. */
  changed(): Promise<void> {
    return new Promise((resolve) => this.watchers.push(resolve));
  }

  set(state: AttemptState, patch: { action?: LoginAction | null; message?: string | null } = {}): void {
    if (this.over) return;
    this.state = state;
    if (patch.action !== undefined) this.action = patch.action;
    if (patch.message !== undefined) this.message = patch.message;
    if (this.over) {
      this.finishedAt = Date.now();
      this.action = null;
      void this.cleanup();
    }
    const w = this.watchers;
    this.watchers = [];
    for (const wake of w) wake();
  }

  onCleanup(fn: () => void | Promise<void>): void {
    this.stops.push(fn);
  }

  async cleanup(): Promise<void> {
    const fns = this.stops;
    this.stops = [];
    for (const fn of fns) {
      try {
        await fn();
      } catch {
        /* the process is already gone */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------

export class AuthService {
  private readonly attempts = new Map<AgentKind, Attempt>();
  private readonly cache = new Map<AgentKind, { at: number; view: AuthView }>();
  private readonly probing = new Map<AgentKind, Promise<AuthView>>();
  private readonly o: Required<Omit<AuthServiceOptions, 'config' | 'log'>>;
  private readonly config: BridgeConfig;
  private readonly log: (line: string) => void;
  private closed = false;

  constructor(opts: AuthServiceOptions) {
    this.config = opts.config;
    this.log = opts.log;
    this.o = {
      startWaitMs: opts.startWaitMs ?? 8000,
      pushWaitMs: opts.pushWaitMs ?? 1500,
      statusTtlMs: opts.statusTtlMs ?? 15_000,
      deviceTimeoutMs: opts.deviceTimeoutMs ?? 15 * 60_000,
      pasteTimeoutMs: opts.pasteTimeoutMs ?? 10 * 60_000,
      keepFinishedMs: opts.keepFinishedMs ?? 10 * 60_000,
      stepTimeoutMs: opts.stepTimeoutMs ?? 30_000,
    };
  }

  /** The profile a sign-in request is for: named, else the first of the asked-for tool (the `default` profile first), else the default profile. */
  resolve(profileName: string | undefined, agent: string | undefined): { name: string; profile: ProfileConfig } | null {
    if (profileName !== undefined) return profileFor(this.config, profileName);
    if (agent !== undefined) {
      const entries = Object.entries(this.config.profiles).filter(([, p]) => p.agent === agent);
      const chosen = entries.find(([n]) => n === 'default') ?? entries[0];
      return chosen ? { name: chosen[0], profile: chosen[1] } : null;
    }
    return profileFor(this.config, 'default');
  }

  close(): void {
    this.closed = true;
    for (const a of this.attempts.values()) a.set('cancelled', { message: AUTH_WORDS.cancelled });
  }

  private current(agent: AgentKind): Attempt | null {
    const a = this.attempts.get(agent);
    if (a === undefined) return null;
    if (a.over && a.finishedAt !== null && Date.now() - a.finishedAt > this.o.keepFinishedMs) {
      this.attempts.delete(agent);
      return null;
    }
    return a;
  }

  // ---- status -----------------------------------------------------------------------------------------------------------------------------

  async status(profile: ProfileConfig): Promise<AuthView> {
    const agent = profile.agent;
    const attempt = this.current(agent);
    const active = attempt !== null && !attempt.over;
    const base = await this.probe(profile, active);
    return { ...base, attempt: attempt === null ? null : attempt.view() };
  }

  private async probe(profile: ProfileConfig, reuseOnly: boolean): Promise<AuthView> {
    const agent = profile.agent;
    const flavor = flavorOf(agent);
    if (flavor === 'hermes') return { agent, state: 'not_needed', kind: null, canLogout: false, methods: [], attempt: null, note: AUTH_WORDS.hermes };
    if (flavor === 'opencode') return { agent, state: 'unknown', kind: null, canLogout: false, methods: [], attempt: null, note: AUTH_WORDS.opencode };
    const cached = this.cache.get(agent);
    // While a sign-in is under way the last answer stands (the adapter is busy with it); otherwise it is reused for a few seconds.
    if (cached && (reuseOnly || Date.now() - cached.at < this.o.statusTtlMs)) return cached.view;
    if (reuseOnly) return { agent, state: 'unknown', kind: null, canLogout: false, methods: [], attempt: null, note: null };
    const running = this.probing.get(agent);
    if (running) return running;
    const p = this.probeNow(profile).finally(() => this.probing.delete(agent));
    this.probing.set(agent, p);
    return p;
  }

  private async probeNow(profile: ProfileConfig): Promise<AuthView> {
    const agent = profile.agent;
    const flavor = flavorOf(agent);
    let adapter: Opened | null = null;
    let view: AuthView;
    try {
      adapter = await openAdapter(this.config, profile, {}, this.o.stepTimeoutMs, async () => ({ action: 'cancel' }));
      const found = methodViews(flavor, adapter.init);
      let state: AuthState = 'unknown';
      let kind: string | null = null;
      if (flavor === 'claude') {
        try {
          const answer = (await adapter.race(adapter.agent.request('auth/status' as never, {} as never))) as unknown;
          const s = isRecord(answer) ? answer['state'] : null;
          state = s === 'authenticated' ? 'signed_in' : s === 'unauthenticated' ? 'signed_out' : 'unknown';
          // Only the kind of the first account; the label, the e-mail and the organization next to it are dropped.
          const first = isRecord(answer) && Array.isArray(answer['accounts']) && isRecord(answer['accounts'][0]) ? answer['accounts'][0] : null;
          const meta = first !== null && isRecord(first['_meta']) && isRecord(first['_meta']['claudeCode']) ? first['_meta']['claudeCode'] : null;
          kind = state === 'signed_in' ? reduceKind(meta?.['kind']) : null;
        } catch (err) {
          if (err instanceof AdapterEnded) throw err;
          /* the adapter has no auth/status: fall back to its push below */
        }
      }
      if (state === 'unknown') {
        // Codex says it only as a push after `initialize`; wait a moment for it.
        const until = Date.now() + this.o.pushWaitMs;
        while (adapter.pushes.length === 0 && Date.now() < until) await sleep(25);
        const last = adapter.pushes[adapter.pushes.length - 1];
        if (last) {
          state = last.kind === 'none' ? 'signed_out' : last.kind !== null ? 'signed_in' : 'unknown';
          kind = last.kind === 'none' ? null : last.kind;
        }
      }
      view = { agent, state, kind, canLogout: hasLogout(adapter.init) || flavor === 'claude', methods: found.map(({ args: _args, ...m }) => m), attempt: null, note: null };
    } catch (err) {
      this.log(`sign-in status failed: ${err instanceof Error ? err.name : 'error'}`);
      view = { agent, state: 'unknown', kind: null, canLogout: false, methods: [], attempt: null, note: err instanceof AdapterEnded && err.spawnError === 'ENOENT' ? AUTH_WORDS.noAdapter : 'The agent did not answer. Try again in a moment.' };
    } finally {
      if (adapter) await adapter.close();
    }
    // A failed probe is not remembered: the next look asks again.
    if (view.note === null) this.cache.set(agent, { at: Date.now(), view });
    return view;
  }

  // ---- login ------------------------------------------------------------------------------------------------------------------------------

  async login(profile: ProfileConfig, methodId: string): Promise<AttemptView> {
    if (this.closed) throw new AuthRefused(503, 'shutting_down', 'The bridge is shutting down.');
    const agent = profile.agent;
    const flavor = flavorOf(agent);
    if (flavor !== 'claude' && flavor !== 'codex') throw new AuthRefused(409, 'no_sign_in', flavor === 'hermes' ? AUTH_WORDS.hermes : AUTH_WORDS.opencode);
    const existing = this.current(agent);
    if (existing !== null && !existing.over) throw new AuthRefused(409, 'sign_in_busy', AUTH_WORDS.busy);
    this.cache.delete(agent);

    // A placeholder holds the place while the adapter starts, so two logins cannot both pass the check above.
    const placeholder = new Attempt(agent, methodId, 'device_code');
    this.attempts.set(agent, placeholder);
    let adapter: Opened | null = null;
    try {
      let elicit: ((p: Record<string, unknown>) => Promise<{ action: 'accept' | 'cancel' }>) | null = null;
      adapter = await openAdapter(this.config, profile, {}, this.o.stepTimeoutMs, async (p) => (elicit ? elicit(p) : { action: 'cancel' }));
      const method = methodViews(flavor, adapter.init).find((m) => m.id === methodId);
      if (method === undefined) {
        placeholder.set('cancelled');
        this.attempts.delete(agent);
        await adapter.close();
        throw new AuthRefused(400, 'unknown_method', 'That way of signing in is not offered by this agent.');
      }
      const attempt = new Attempt(agent, method.id, method.how);
      this.attempts.set(agent, attempt);
      placeholder.set('cancelled');
      const opened = adapter;
      attempt.onCleanup(() => opened.close());
      const cancelTimer = (ms: number): void => {
        const timer = setTimeout(() => attempt.set('failed', { message: method.how === 'device_code' ? AUTH_WORDS.expired : AUTH_WORDS.notFinished }), ms);
        timer.unref();
        attempt.onCleanup(() => clearTimeout(timer));
      };
      this.log(`sign-in started: ${agent}`);
      if (method.how === 'device_code') this.deviceFlow(profile, attempt, opened, method.id, (fn) => (elicit = fn), cancelTimer);
      else if (method.how === 'paste_code') {
        await opened.close();
        this.pasteFlow(profile, attempt, method.args, cancelTimer);
      } else {
        await opened.close();
        this.keyFlow(profile, attempt, method.id);
      }
      // The first thing to do is ready in a moment (the adapter prints it, or asks for it); the page polls for it after this.
      const until = Date.now() + this.o.startWaitMs;
      while (attempt.state === 'starting' && Date.now() < until) await Promise.race([attempt.changed(), sleep(100)]);
      return attempt.view();
    } catch (err) {
      if (adapter && !(err instanceof AuthRefused)) await adapter.close();
      if (!(err instanceof AuthRefused)) {
        placeholder.set('failed');
        if (this.attempts.get(agent) === placeholder) this.attempts.delete(agent);
        this.log(`sign-in could not start: ${err instanceof Error ? err.name : 'error'}`);
        throw new AuthRefused(502, 'adapter_unavailable', failureText(err, []));
      }
      throw err;
    }
  }

  /** Codex: `authenticate` stays open while the person enters the code; the adapter's process is held for that. */
  private deviceFlow(profile: ProfileConfig, attempt: Attempt, adapter: Opened, methodId: string, setElicit: (fn: (p: Record<string, unknown>) => Promise<{ action: 'accept' | 'cancel' }>) => void, timer: (ms: number) => void): void {
    void profile;
    setElicit(async (p) => {
      const url = typeof p['url'] === 'string' ? p['url'] : '';
      if (p['mode'] !== 'url' || !/^https:\/\/[^\s"'<>]{1,500}$/.test(url)) return { action: 'cancel' };
      const message = typeof p['message'] === 'string' ? p['message'] : '';
      // The code is only in the message's own text (measured): "Sign in to ChatGPT and enter this code: ABCD-12345".
      const code = /\b([A-Z0-9]{3,6}-[A-Z0-9]{3,8})\b/.exec(message)?.[1] ?? null;
      attempt.set('waiting', code !== null ? { action: { type: 'enter_code', url, code }, message: 'Open the page and enter the code. This page updates when you are done.' } : { action: { type: 'open_url', url }, message: 'Open the page and follow what it says. This page updates when you are done.' });
      return { action: 'accept' };
    });
    timer(this.o.deviceTimeoutMs);
    adapter
      .race(adapter.agent.request('authenticate', { methodId } as never), this.o.deviceTimeoutMs)
      .then(() => {
        this.cache.delete(attempt.agent);
        attempt.set('done', { message: 'Signed in.' });
      })
      .catch((err: unknown) => attempt.set('failed', { message: failureText(err, []) }));
  }

  /** Claude: the adapter's own login program under a pseudo-terminal: it prints a page to open and waits for the code the page gives. */
  private pasteFlow(profile: ProfileConfig, attempt: Attempt, methodArgs: string[], timer: (ms: number) => void): void {
    if (!ptySupported()) return attempt.set('failed', { message: AUTH_WORDS.noPty });
    const { command, args } = adapterCommand(profile);
    let seen = '';
    let secret: string[] = [];
    let pty: PtyHandle;
    try {
      pty = startPty(command, [...args, ...methodArgs], {
        cwd: resolvePath(profile.workdir),
        env: authEnv(this.config, profile),
        onText: (chunk) => {
          seen = (seen + chunk).slice(-8000);
          if (attempt.state !== 'starting') return;
          const url = /https:\/\/[^\s"'<>]{8,2000}/.exec(seen)?.[0];
          if (url === undefined) return;
          attempt.set('needs_input', { action: { type: 'paste_code', url }, message: 'Open the page, sign in, and paste the code it shows below.' });
        },
      });
    } catch {
      return attempt.set('failed', { message: AUTH_WORDS.noPty });
    }
    attempt.onCleanup(() => {
      pty.signal('SIGTERM');
      const kill = setTimeout(() => pty.signal('SIGKILL'), 1000);
      kill.unref();
    });
    attempt.answer = async ({ code }) => {
      if (attempt.state !== 'needs_input' || code === undefined) return false;
      attempt.answers += 1;
      if (attempt.answers > MAX_ANSWERS) {
        attempt.set('failed', { message: AUTH_WORDS.tooManyTries });
        return true;
      }
      secret = [code];
      attempt.set('checking', { message: 'Checking the code…' });
      return pty.writeLine(code);
    };
    timer(this.o.pasteTimeoutMs);
    void pty.done.then((end) => {
      if (attempt.over) return;
      if (end.spawnError !== null) return attempt.set('failed', { message: end.spawnError === 'ENOENT' ? AUTH_WORDS.noPty : AUTH_WORDS.notFinished });
      if (end.code === 0) {
        this.cache.delete(attempt.agent);
        return attempt.set('done', { message: 'Signed in.' });
      }
      // Only the program's last line, with the pasted code taken out of it (the terminal echoes what was typed).
      const why = lastTerminalLine(seen, secret);
      attempt.set('failed', { message: why !== '' ? `The sign-in did not work: ${why}` : AUTH_WORDS.refused });
    });
  }

  /** Codex with a key: nothing to do until the key is given; then the adapter is started with it in its environment, for this one call. */
  private keyFlow(profile: ProfileConfig, attempt: Attempt, methodId: string): void {
    attempt.set('needs_input', { action: { type: 'give_key' }, message: 'Paste the API key below. It is passed to the agent once and is not kept here.' });
    attempt.answer = async ({ apiKey }) => {
      if (attempt.state !== 'needs_input' || apiKey === undefined) return false;
      attempt.answers += 1;
      if (attempt.answers > MAX_ANSWERS) {
        attempt.set('failed', { message: AUTH_WORDS.tooManyTries });
        return true;
      }
      attempt.set('checking', { message: 'Checking the key…' });
      void (async () => {
        let adapter: Opened | null = null;
        try {
          adapter = await openAdapter(this.config, profile, { CODEX_API_KEY: apiKey, OPENAI_API_KEY: apiKey }, this.o.stepTimeoutMs, async () => ({ action: 'cancel' }));
          await adapter.race(adapter.agent.request('authenticate', { methodId } as never));
          this.cache.delete(attempt.agent);
          attempt.set('done', { message: 'Signed in.' });
        } catch (err) {
          attempt.set('failed', { message: failureText(err, [apiKey]) });
        } finally {
          if (adapter) await adapter.close();
        }
      })();
      return true;
    };
  }

  /** The person's code or key. `false`: nothing is waiting for it. */
  async answer(profile: ProfileConfig, attemptId: string, value: { code?: string; apiKey?: string }): Promise<AttemptView> {
    const attempt = this.current(profile.agent);
    if (attempt === null || attempt.id !== attemptId || attempt.over || attempt.answer === null) throw new AuthRefused(404, 'no_such_sign_in', 'No sign-in is waiting for that.');
    const taken = await attempt.answer(value);
    if (!taken) throw new AuthRefused(409, 'not_waiting', 'The sign-in is not waiting for that right now.');
    // The program decides within a moment; the page polls for the rest.
    const until = Date.now() + 1500;
    while (attempt.state === 'checking' && Date.now() < until) await Promise.race([attempt.changed(), sleep(100)]);
    return attempt.view();
  }

  cancel(profile: ProfileConfig, attemptId: string | undefined): AttemptView | null {
    const attempt = this.current(profile.agent);
    if (attempt === null || (attemptId !== undefined && attempt.id !== attemptId)) return null;
    attempt.set('cancelled', { message: AUTH_WORDS.cancelled });
    return attempt.view();
  }

  // ---- logout -----------------------------------------------------------------------------------------------------------------------------

  async logout(profile: ProfileConfig): Promise<AuthView> {
    const agent = profile.agent;
    const flavor = flavorOf(agent);
    if (flavor !== 'claude' && flavor !== 'codex') throw new AuthRefused(409, 'no_sign_out', flavor === 'hermes' ? AUTH_WORDS.hermes : AUTH_WORDS.opencode);
    const existing = this.current(agent);
    if (existing !== null && !existing.over) throw new AuthRefused(409, 'sign_in_busy', AUTH_WORDS.busy);
    let adapter: Opened | null = null;
    try {
      adapter = await openAdapter(this.config, profile, {}, this.o.stepTimeoutMs, async () => ({ action: 'cancel' }));
      let done = false;
      if (hasLogout(adapter.init)) {
        try {
          await adapter.race(adapter.agent.request('logout', {} as never));
          done = true;
        } catch (err) {
          if (err instanceof AdapterEnded) throw err;
          // The method is advertised but refused: the measured fallback below.
        }
      }
      if (!done) {
        // The fallback (Claude): the adapter's own program, `--cli auth logout`, which removes the same sign-in.
        if (flavor !== 'claude' || !ptySupported()) throw new AuthRefused(409, 'no_sign_out', AUTH_WORDS.noLogout);
        const { command, args } = adapterCommand(profile);
        let out = '';
        const pty = startPty(command, [...args, '--cli', 'auth', 'logout'], { cwd: resolvePath(profile.workdir), env: authEnv(this.config, profile), onText: (t) => void (out = (out + t).slice(-2000)) });
        const timeout = setTimeout(() => pty.signal('SIGTERM'), this.o.stepTimeoutMs);
        timeout.unref();
        const end = await pty.done;
        clearTimeout(timeout);
        if (end.spawnError !== null || end.code !== 0) throw new AuthRefused(502, 'sign_out_failed', `The sign-out did not work: ${lastTerminalLine(out, []) || 'the program failed'}`);
      }
    } catch (err) {
      if (err instanceof AuthRefused) throw err;
      throw new AuthRefused(502, 'sign_out_failed', failureText(err, []));
    } finally {
      if (adapter) await adapter.close();
    }
    this.log(`signed out: ${agent}`);
    this.cache.delete(agent);
    this.attempts.delete(agent);
    return this.status(profile);
  }
}

/** What a body field may hold: a code or key is one line, no control characters, bounded. */
export function cleanSecret(v: unknown, min: number, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= min && t.length <= max && !/[\u0000-\u001f\u007f\s]/.test(t) ? t : null;
}
