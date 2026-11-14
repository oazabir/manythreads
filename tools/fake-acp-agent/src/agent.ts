import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import {
  RequestError,
  agent as createAgent,
  methods,
  type AgentApp,
  type AgentContext,
  type AuthMethod,
  type InitializeRequest,
  type PermissionOption,
  type PromptResponse,
  type SessionUpdate,
  type StopReason,
} from '@agentclientprotocol/sdk';
import type { Action, AuthScript, FakeScript, Flavor, HelperAction, PermissionAction, PlanEntryInput, StepAction } from './script.ts';

/*
 * A fake ACP agent (P25-02): the agent side of the protocol, built on `@agentclientprotocol/sdk`, that plays a script instead of
 * running a model. What it sends is what `docs/spikes/acp-measured.md` saw from Hermes, Claude and Codex, per "flavor" — including
 * the things a bridge must not forward (`rawInput`, `toolResponse`, `terminal_output_delta`, an e-mail in the auth status).
 */

type StepSpec = Omit<StepAction, 'do'> & { /** Claude's `toolResponse` as an object (a helper's report). */ response?: unknown };
type Meta = Record<string, unknown>;

interface Session {
  id: string;
  cwd: string;
  mode: string;
  mcpServers: unknown[];
  turns: number;
  cost: number;
  used: number;
  planCalls: number;
  title: string;
  updatedAt: string;
  history: SessionUpdate[];
  /** Config options a client set (model, effort), kept so a test can read what the bridge chose. */
  options?: Record<string, string>;
}

interface LiveSession extends Session {
  options: Record<string, string>;
  /** The notes steering put to a running turn, in order (a script can read them with `{{steered}}`). */
  steered: string[];
  abort: AbortController | null;
  /** Prompts of one session run one after another. */
  queue: Promise<unknown>;
  /** Counts the `session/cancel` notifications: a prompt that was received before one and had not started when it came is cancelled at its start. */
  cancelEpoch: number;
}

/** What a client sent, in order (for a test to look at: `_meta`, `mcpServers`, the prompt). */
export interface Received {
  method: string;
  params: unknown;
}

export interface FakeAcpAgent {
  app: AgentApp;
  received: Received[];
  sessions: Map<string, LiveSession>;
  /** Ends a device-code sign-in that is waiting (`auth.pendingMs: null`). */
  completeSignIn(): void;
  isSignedIn(): boolean;
}

const MODES: Record<Flavor, { current: string; list: Array<[string, string]> }> = {
  claude: {
    current: 'auto',
    list: [
      ['default', 'Manual'],
      ['acceptEdits', 'Accept edits'],
      ['plan', 'Plan'],
      ['auto', 'Auto'],
    ],
  },
  codex: {
    current: 'agent',
    list: [
      ['read-only', 'Read-only'],
      ['workspace-write', 'Workspace write'],
      ['agent', 'Auto review'],
      ['agent-full-access', 'Full access'],
    ],
  },
  hermes: {
    current: 'default',
    list: [
      ['default', 'Default'],
      ['accept_edits', 'Accept edits'],
      ['dont_ask', "Don't ask"],
    ],
  },
};

const EFFORT_VALUES: Array<[string, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
  ['xhigh', 'Extra high'],
  ['max', 'Max'],
];

const ID_PREFIX: Record<Flavor, string> = { claude: 'toolu_fake_', codex: 'call_fake_', hermes: 'tc-fake' };
const HERMES_CANCEL_TEXT = '[Tool execution cancelled — terminal was abandoned: explicit stop requested]';

/** Sleeps; true when the time passed, false when `signal` aborted first. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function splitChunks(text: string, chunks = 1): string[] {
  if (chunks <= 1) return [text];
  const words = text.split(/(?<= )/);
  const size = Math.max(1, Math.ceil(words.length / chunks));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) out.push(words.slice(i, i + size).join(''));
  return out;
}

export function createFakeAcpAgent(script: FakeScript): FakeAcpAgent {
  const flavor: Flavor = script.flavor ?? 'claude';
  const authScript: AuthScript = script.auth ?? {};
  const faults = script.faults ?? {};
  const received: Received[] = [];
  const sessions = new Map<string, LiveSession>();
  let idCounter = 0;
  let permCounter = 0;
  let clientCaps: InitializeRequest['clientCapabilities'] | undefined;
  let signInWaiter: (() => void) | null = null;

  const nextId = (): string => `${ID_PREFIX[flavor]}${++idCounter}`;

  // ---- sign-in state, shared with a login program through `stateDir/auth.json` -----------------------------------------------------
  const authFile = script.stateDir ? join(script.stateDir, 'auth.json') : null;
  let memoryAuth: { signedIn: boolean; kind: 'account' | 'gateway' | 'none' } =
    authScript.signedIn === false ? { signedIn: false, kind: 'none' } : { signedIn: true, kind: 'account' };
  const readAuth = (): { signedIn: boolean; kind: 'account' | 'gateway' | 'none' } => {
    if (authFile) {
      try {
        return JSON.parse(readFileSync(authFile, 'utf8')) as typeof memoryAuth;
      } catch {
        /* no file: the script's start state */
      }
    }
    return memoryAuth;
  };
  const writeAuth = (next: typeof memoryAuth): void => {
    memoryAuth = next;
    if (authFile && script.stateDir) {
      mkdirSync(script.stateDir, { recursive: true });
      writeFileSync(authFile, JSON.stringify(next));
    }
  };
  const account = { label: 'Fake Subscription', plan: 'max', email: 'person@example.test', organization: 'Example Org', ...authScript.account };

  // ---- sessions on disk (so a second process can resume or load) --------------------------------------------------------------------
  const sessionFile = (id: string): string | null => (script.stateDir ? join(script.stateDir, 'sessions', `${id}.json`) : null);
  const persist = (s: LiveSession): void => {
    const file = sessionFile(s.id);
    if (!file || !script.stateDir) return;
    mkdirSync(join(script.stateDir, 'sessions'), { recursive: true });
    const { id, cwd, mode, mcpServers, turns, cost, used, planCalls, title, updatedAt, history, options } = s;
    writeFileSync(file, JSON.stringify({ id, cwd, mode, mcpServers, turns, cost, used, planCalls, title, updatedAt, history, options } satisfies Session));
  };
  const findSession = (id: string): LiveSession | undefined => {
    const live = sessions.get(id);
    if (live) return live;
    const file = sessionFile(id);
    if (!file) return undefined;
    try {
      const stored = JSON.parse(readFileSync(file, 'utf8')) as Session;
      const revived: LiveSession = { ...stored, options: stored.options ?? {}, steered: [], abort: null, queue: Promise.resolve(), cancelEpoch: 0 };
      sessions.set(id, revived);
      return revived;
    } catch {
      return undefined;
    }
  };
  const storedSessions = (): Session[] => {
    const out = new Map<string, Session>();
    if (script.stateDir) {
      try {
        for (const f of readdirSync(join(script.stateDir, 'sessions'))) {
          const s = JSON.parse(readFileSync(join(script.stateDir, 'sessions', f), 'utf8')) as Session;
          out.set(s.id, s);
        }
      } catch {
        /* no folder yet */
      }
    }
    for (const s of sessions.values()) out.set(s.id, s);
    return [...out.values()];
  };

  const modeState = (current?: string) => ({
    currentModeId: current ?? MODES[flavor].current,
    availableModes: MODES[flavor].list.map(([id, name]) => ({ id, name })),
  });

  /** What `session/new`, `resume` and `load` return as `configOptions` (mode always; model and effort where the real adapter has them). */
  const configOptions = (s: LiveSession): Meta[] => {
    const select = (id: string, name: string, category: string, current: string, values: Array<[string, string]>): Meta => ({
      id,
      name,
      category,
      type: 'select',
      currentValue: current,
      options: values.map(([value, label]) => ({ value, name: label })),
    });
    const out: Meta[] = [select('mode', 'Mode', 'mode', s.mode, MODES[flavor].list)];
    if (flavor === 'claude') {
      out.push(select('model', 'Model', 'model', s.options['model'] ?? 'sonnet', [['default', 'Default'], ['sonnet', 'Sonnet'], ['opus', 'Opus'], ['haiku', 'Haiku']]));
      out.push(select('effort', 'Effort', 'thought_level', s.options['effort'] ?? 'medium', EFFORT_VALUES));
    } else if (flavor === 'codex') {
      out.push(select('model', 'Model', 'model', s.options['model'] ?? 'gpt-5.5', [['gpt-5.5', 'GPT-5.5'], ['gpt-5.4', 'GPT-5.4']]));
      out.push(select('reasoning_effort', 'Reasoning effort', 'thought_level', s.options['reasoning_effort'] ?? 'medium', EFFORT_VALUES));
    }
    return out;
  };

  const unknownSession = (id: string): RequestError => {
    if (flavor === 'codex') return new RequestError(-32603, 'Internal error', { details: `no rollout found for thread id ${id}` });
    return new RequestError(-32002, 'Resource not found', { sessionId: id });
  };

  // ---- sign-in methods per flavor -------------------------------------------------------------------------------------------------------
  const authMethods = (caps: typeof clientCaps): AuthMethod[] => {
    const terminal = Boolean(caps?.auth?.terminal);
    const gateway = Boolean((caps?.auth?._meta as Meta | null | undefined)?.gateway);
    const urlElicitation = Boolean(caps?.elicitation?.url);
    const methodsList: unknown[] = [];
    if (flavor === 'claude') {
      if (terminal) {
        methodsList.push({
          id: 'claude-ai-login',
          name: 'Claude Subscription',
          description: 'Use Claude subscription ',
          type: 'terminal',
          args: ['--cli', 'auth', 'login', '--claudeai'],
        });
        methodsList.push({
          id: 'console-login',
          name: 'Anthropic Console',
          description: 'Use Anthropic Console (API usage billing)',
          type: 'terminal',
          args: ['--cli', 'auth', 'login', '--console'],
        });
      }
      if (gateway) {
        methodsList.push({
          id: 'gateway',
          name: 'Custom model gateway',
          description: 'Use a custom gateway to authenticate and access models',
          _meta: { gateway: { protocol: 'anthropic' } },
        });
        methodsList.push({
          id: 'gateway-bedrock',
          name: 'Custom model gateway',
          description: 'Use a custom gateway to authenticate and access models',
          _meta: { gateway: { protocol: 'bedrock' } },
        });
      }
    } else if (flavor === 'codex') {
      methodsList.push({ id: 'api-key', name: 'Use an API key', description: 'CODEX_API_KEY or OPENAI_API_KEY' });
      methodsList.push({ id: 'chat-gpt', name: 'Sign in with ChatGPT', description: 'Opens a browser on this machine' });
      if (urlElicitation) methodsList.push({ id: 'chat-gpt-device-code', name: 'Sign in with ChatGPT (device code)', description: 'Shows a page and a code' });
      if (gateway)
        methodsList.push({
          id: 'gateway',
          name: 'Custom model gateway',
          description: 'Use a custom gateway to authenticate and access models',
          _meta: { gateway: { protocol: 'openai' } },
        });
    } else {
      methodsList.push({ id: 'custom', name: 'Configured provider', description: 'Uses the provider already configured' });
      methodsList.push({ id: 'hermes-setup', name: 'Set up Hermes', description: 'Runs the setup', type: 'terminal', args: ['--setup'] });
    }
    return methodsList as AuthMethod[];
  };

  const agentCapabilities = (): Meta => {
    const common = { loadSession: true, promptCapabilities: { image: true, embeddedContext: true } };
    const http = faults.noHttp !== true;
    const resume = faults.noResume === true ? {} : { resume: {} };
    if (flavor === 'claude') {
      return {
        ...common,
        mcpCapabilities: { http, sse: true },
        auth: faults.noLogout === true ? { status: {} } : { logout: {}, status: {} },
        sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, options: {}, ...resume, status: {}, title: {} },
        _meta: { claudeCode: { promptQueueing: true }, authStatus: {} },
      };
    }
    if (flavor === 'codex') {
      return {
        ...common,
        mcpCapabilities: { http, sse: false },
        auth: faults.noLogout === true ? {} : { logout: {} },
        sessionCapabilities: { additionalDirectories: {}, close: {}, delete: {}, fork: {}, list: {}, ...resume, title: {}, subagents: {} },
        _meta: { steering: { supported: true } },
      };
    }
    return { ...common, sessionCapabilities: { fork: {}, list: {}, ...resume } };
  };

  /** The `_auth/status_update` push (Claude also sends `auth/status_update`). It carries an e-mail on purpose. */
  const authStatusPayload = () => {
    const a = readAuth();
    if (a.kind === 'gateway') return { kind: 'gateway' };
    if (!a.signedIn) return { kind: 'none' };
    return { kind: 'account', label: account.label, account: { plan: account.plan, email: account.email, organization: account.organization } };
  };
  const pushAuthStatus = async (client: AgentContext): Promise<void> => {
    if (flavor === 'hermes') return;
    try {
      await client.notify('_auth/status_update', { authStatus: authStatusPayload() });
      if (flavor === 'claude') await client.notify('auth/status_update', { authStatus: authStatusPayload() });
    } catch {
      /* the connection closed */
    }
  };

  class StopSignal extends Error {
    constructor(readonly reason: StopReason) {
      super(reason);
    }
  }

  // ---- the prompt: playing a scenario ------------------------------------------------------------------------------------------------------
  interface Env {
    client: AgentContext;
    session: LiveSession;
    signal: AbortSignal;
    prompt: string;
    usageSent: boolean;
    /** Commands a step started (a `spawn` step), in the adapter's own process group. */
    children: ChildProcess[];
  }

  const emit = async (env: Env, update: Record<string, unknown>, replayable = true): Promise<void> => {
    if (replayable) env.session.history.push(update as unknown as SessionUpdate);
    await env.client.notify(methods.client.session.update, { sessionId: env.session.id, update: update as unknown as SessionUpdate });
    if (script.tickMs) await sleep(script.tickMs, env.signal);
  };

  const absolute = (env: Env, p: string): string => (isAbsolute(p) ? p : join(env.session.cwd, p));
  const locations = (env: Env, s: StepSpec) => (s.paths ?? []).map((p) => ({ path: absolute(env, p) }));
  const diffContent = (env: Env, s: StepSpec) =>
    s.diff
      ? [
          {
            type: 'diff',
            path: absolute(env, s.diff.path),
            oldText: s.diff.oldText,
            newText: s.diff.newText,
            ...(flavor === 'codex' ? { _meta: { kind: s.diff.oldText == null ? 'add' : 'update' } } : {}),
          },
        ]
      : undefined;
  const textContent = (text: string | undefined) => (text ? [{ type: 'content', content: { type: 'text', text } }] : []);

  const claudeMeta = (s: StepSpec, parent: string | undefined, extra: Meta = {}): Meta => ({
    claudeCode: { toolName: s.toolName ?? 'Tool', ...(parent ? { parentToolUseId: parent } : {}), ...extra },
  });

  /** The first frames of a step: what the adapter sends when the tool call begins. */
  const startStep = async (env: Env, s: StepSpec, id: string, parent?: string): Promise<void> => {
    const leak = s.leak !== false;
    const kind = s.kind ?? 'other';
    const title = shownTitle(env, s);
    if (flavor === 'claude') {
      await emit(env, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        name: s.toolName,
        status: 'pending',
        title: s.genericTitle ?? title,
        kind,
        content: [],
        locations: [],
        ...(leak ? { rawInput: {} } : {}),
        _meta: claudeMeta(s, parent),
      });
      await emit(env, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        title,
        locations: locations(env, s),
        ...(leak && s.input !== undefined ? { rawInput: s.input } : {}),
        ...(diffContent(env, s) ? { content: diffContent(env, s) } : {}),
        _meta: claudeMeta(s, parent),
      });
    } else if (flavor === 'codex') {
      await emit(env, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title,
        kind,
        status: 'in_progress',
        locations: s.diff ? [] : locations(env, s),
        ...(leak && kind === 'execute' && s.input !== undefined ? { rawInput: s.input } : {}),
        ...(diffContent(env, s) ? { content: diffContent(env, s) } : {}),
      });
    } else {
      await emit(env, {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title,
        kind,
        locations: locations(env, s),
        ...(leak && s.input !== undefined ? { rawInput: s.input } : {}),
      });
    }
  };

  /**
   * The title the adapter ends up showing. A command's step is titled with the command itself (measured: Claude refines "Terminal" to the command in its next update,
   * Codex and Hermes start with it; Hermes prefixes the tool name), which is exactly what a client must not pass on.
   */
  const shownTitle = (env: Env, s: StepSpec): string => {
    const input = s.input as { command?: unknown } | undefined;
    if (s.kind === 'execute' && s.leak !== false && typeof input?.command === 'string') return flavor === 'hermes' ? `terminal: ${withToken(env, input.command)}` : withToken(env, input.command);
    return fill(env, s.title);
  };

  type Outcome = 'completed' | 'failed' | 'rejected' | 'cancelled';

  /** The last frame of a step. What each adapter does on a stop differs: Codex sends nothing, Claude marks it failed, Hermes says completed. */
  const endStep = async (env: Env, s: StepSpec, id: string, outcome: Outcome, parent?: string): Promise<void> => {
    const leak = s.leak !== false;
    const failText = typeof s.fail === 'string' ? fill(env, s.fail) : 'The tool failed';
    if (flavor === 'claude') {
      const failed = outcome !== 'completed';
      const extra: Meta = {
        ...(leak ? { toolResponse: s.response ?? s.output ?? '' } : {}),
        ...(outcome === 'rejected' ? { nonExecutionKind: 'permission-rule' } : {}),
        ...(outcome === 'cancelled' ? { nonExecutionKind: 'user-rejected' } : {}),
      };
      if (leak) await emit(env, { sessionUpdate: 'tool_call_update', toolCallId: id, _meta: claudeMeta(s, parent, extra) });
      await emit(env, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: failed ? 'failed' : 'completed',
        ...(leak ? { rawOutput: s.response ?? s.output ?? '' } : {}),
        ...(outcome === 'failed' ? { content: textContent(failText) } : outcome === 'completed' && leak && s.output && !s.diff ? { content: textContent(s.output) } : {}),
        _meta: claudeMeta(s, parent, extra),
      });
    } else if (flavor === 'codex') {
      if (outcome === 'cancelled') return; // the real adapter never finalises the step
      const execute = s.kind === 'execute' && leak;
      await emit(env, {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: outcome === 'completed' ? 'completed' : 'failed',
        ...(leak ? { rawOutput: { output: s.output ?? '', exit_code: outcome === 'completed' ? 0 : 1 } } : {}),
        ...(execute
          ? {
              _meta: {
                terminal_output_delta: { terminal_id: id, data: outcome === 'failed' ? failText : (s.output ?? '') },
                terminal_exit: { terminal_id: id, exit_code: outcome === 'completed' ? 0 : 1 },
              },
            }
          : {}),
      });
    } else {
      const text = outcome === 'cancelled' ? HERMES_CANCEL_TEXT : outcome === 'failed' ? failText : outcome === 'rejected' ? 'Denied by the user' : (s.output ?? '');
      await emit(env, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: textContent(text) });
    }
  };

  /** A step that runs for `ms` (a stop interrupts it). */
  const startCommand = (env: Env, s: StepSpec): void => {
    if (!s.spawn) return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: env.session.cwd, stdio: 'ignore' });
    env.children.push(child);
    mkdirSync(env.session.cwd, { recursive: true });
    writeFileSync(absolute(env, s.spawn), String(child.pid));
  };
  /** Claude and Hermes end the command when the turn is cancelled; Codex does not (measured). */
  const endCommands = (env: Env): void => {
    if (flavor === 'codex') return;
    for (const c of env.children) c.kill('SIGKILL');
  };

  const runStep = async (env: Env, s: StepSpec, parent?: string): Promise<'ok' | 'cancelled'> => {
    const id = s.id ?? nextId();
    await startStep(env, s, id, parent);
    startCommand(env, s);
    if (s.ms && !(await sleep(s.ms, env.signal))) {
      endCommands(env);
      await endStep(env, s, id, 'cancelled', parent);
      return 'cancelled';
    }
    if (env.signal.aborted) {
      endCommands(env);
      await endStep(env, s, id, 'cancelled', parent);
      return 'cancelled';
    }
    endCommands(env);
    await endStep(env, s, id, s.fail ? 'failed' : 'completed', parent);
    return 'ok';
  };

  const runHelper = async (env: Env, h: HelperAction): Promise<'ok' | 'cancelled'> => {
    if (flavor === 'claude') {
      const id = h.id ?? nextId();
      const parentSpec: StepSpec = {
        title: h.name,
        genericTitle: 'Task',
        kind: 'think',
        toolName: 'Agent',
        input: { description: h.name, subagent_type: h.agentType ?? 'general-purpose' },
      };
      await startStep(env, parentSpec, id);
      for (const child of h.steps ?? []) if ((await runStep(env, child, id)) === 'cancelled') return endHelperCancelled(env, parentSpec, id);
      if ((await runStep(env, { title: 'SubagentHandback', toolName: 'SubagentHandback', kind: 'other', input: { report: h.report ?? '' } }, id)) === 'cancelled')
        return endHelperCancelled(env, parentSpec, id);
      await endStep(
        env,
        {
          ...parentSpec,
          response: {
            status: 'completed',
            agentId: `agent_fake_${idCounter}`,
            agentType: h.agentType ?? 'general-purpose',
            toolsUsed: (h.steps ?? []).length,
            handbackReport: h.report ?? '',
          },
        },
        id,
        'completed',
      );
      return 'ok';
    }
    if (flavor === 'codex') {
      for (const title of [`Start subagent ${h.name}`, 'wait', `Complete subagent ${h.name}`]) {
        if ((await runStep(env, { title, kind: 'other' })) === 'cancelled') return 'cancelled';
      }
      return 'ok';
    }
    return runStep(env, {
      title: `delegate_task: 1 tasks: ${h.name}`,
      kind: 'execute',
      toolName: 'delegate_task',
      input: { tasks: [{ goal: h.name }] },
      output: '{"status": "dispatched", "mode": "background"}',
    });
  };
  const endHelperCancelled = async (env: Env, spec: StepSpec, id: string): Promise<'cancelled'> => {
    await endStep(env, spec, id, 'cancelled');
    return 'cancelled';
  };

  const runPlan = async (env: Env, entries: PlanEntryInput[]): Promise<'ok' | 'cancelled'> => {
    if (flavor === 'hermes') {
      // Hermes 0.21.5 sends no `plan`: the list is the `rawInput.todos` of its `todo_list` step.
      const merge = env.session.planCalls++ > 0;
      const todos = entries.map((e, i) => ({
        id: String(i + 1),
        content: e.content,
        status: e.status === 'in_progress' ? 'in_progress' : e.status === 'completed' ? 'completed' : 'pending',
      }));
      return runStep(env, {
        title: `todo_list: ${merge ? 'updating' : 'planning'} ${todos.length} task(s)`,
        kind: 'other',
        toolName: 'todo_list',
        input: { todos, ...(merge ? { merge: true } : {}) },
        output: JSON.stringify({ todos }),
      });
    }
    if (flavor === 'codex') return 'ok'; // Codex 2.6.0 never sent a plan in any measured run
    await emit(env, { sessionUpdate: 'plan', entries: entries.map((e) => ({ content: e.content, status: e.status ?? 'pending', priority: e.priority ?? 'medium' })) });
    return 'ok';
  };

  const permissionOptions = (p: PermissionAction): PermissionOption[] => {
    if (flavor === 'claude') {
      return [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ];
    }
    if (flavor === 'codex') {
      if (p.mcp) {
        return [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
        ];
      }
      return [
        { optionId: 'allow_once', name: 'Yes, proceed', kind: 'allow_once' },
        { optionId: 'cancel', name: 'No, and tell Codex what to do differently', kind: 'reject_once' },
      ];
    }
    return [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_session', name: 'Allow for this session', kind: 'allow_always' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      { optionId: 'deny_always', name: 'Always deny', kind: 'reject_always' },
    ];
  };

  const runPermission = async (env: Env, p: PermissionAction): Promise<'ok' | 'cancelled'> => {
    const s = p.step;
    const id = s.id ?? nextId();
    await startStep(env, s, id);
    const input = (s.input ?? {}) as { command?: string; description?: string };
    // Already cancelled: an adapter sends no new question after a cancel (unless it was already inside the call: `ignoreCancel`).
    if (env.signal.aborted && !p.ignoreCancel) {
      await endStep(env, s, id, 'cancelled');
      return 'cancelled';
    }
    const toolCall: Meta =
      flavor === 'hermes'
        ? {
            toolCallId: `perm-check-${++permCounter}`,
            title: `${input.description ?? s.title}: ${input.command ?? s.title}`,
            kind: s.kind ?? 'execute',
            status: 'pending',
            rawInput: { command: input.command ?? s.title, description: input.description ?? s.title },
          }
        : flavor === 'codex' && p.mcp
          ? { toolCallId: id, kind: 'execute', status: 'pending' }
          : {
              toolCallId: id,
              ...(flavor === 'claude' ? { name: s.toolName } : {}),
              status: 'pending',
              title: shownTitle(env, s),
              kind: s.kind ?? 'execute',
              rawInput: s.input ?? {},
              content: textContent(input.description),
              locations: locations(env, s),
            };
    const request = env.client.request(methods.client.session.requestPermission, {
      sessionId: env.session.id,
      toolCall: toolCall as never,
      options: permissionOptions(p),
      ...(flavor === 'codex' && p.mcp ? { _meta: { is_mcp_tool_approval: true } } : {}),
    });
    // The race has to look at the signal first: an abort that came while the request was being made would never fire the listener.
    const aborted = new Promise<'aborted'>((resolve) => {
      if (p.ignoreCancel) return;
      if (env.signal.aborted) resolve('aborted');
      else env.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    const answer = await Promise.race([request, aborted]);
    request.catch(() => undefined);
    if (answer === 'aborted' || answer.outcome.outcome === 'cancelled') {
      await endStep(env, s, id, 'cancelled');
      return 'cancelled';
    }
    const chosen = permissionOptions(p).find((o) => o.optionId === (answer.outcome as { optionId: string }).optionId);
    // A real adapter does not take an id it did not offer as a "Yes": the prompt fails.
    if (!chosen) throw RequestError.invalidParams({ optionId: (answer.outcome as { optionId: string }).optionId }, 'Unknown permission option');
    if (chosen?.kind === 'reject_once' || chosen?.kind === 'reject_always') {
      await endStep(env, s, id, 'rejected');
      // Like the model after a "No": it says what it makes of that and the turn ends.
      if ((await runActions(env, p.onReject ?? [])) === 'cancelled') return 'cancelled';
      throw new StopSignal('end_turn');
    }
    if (s.ms && !(await sleep(s.ms, env.signal))) {
      await endStep(env, s, id, 'cancelled');
      return 'cancelled';
    }
    await endStep(env, s, id, s.fail ? 'failed' : 'completed');
    return 'ok';
  };

  const sendUsage = async (env: Env, a: { used?: number; size?: number; cost?: number }): Promise<void> => {
    env.usageSent = true;
    env.session.used = a.used ?? env.session.used + 1500;
    env.session.cost += a.cost ?? 0;
    const size = a.size ?? (flavor === 'claude' ? 1_000_000 : flavor === 'codex' ? 258_400 : 262_144);
    await emit(
      env,
      { sessionUpdate: 'usage_update', used: env.session.used, size, ...(flavor === 'claude' ? { cost: { amount: env.session.cost, currency: 'USD' } } : {}) },
      false,
    );
  };

  /** The run's own MCP token as the client gave it to this session (`{{mcpToken}}` in a script puts it in a title, a message or an error, as a careless adapter might). */
  const withToken = (env: Env, text: string): string => {
    const header = env.session.mcpServers
      .flatMap((m) => ((m as { headers?: Array<{ name?: string; value?: string }> }).headers ?? []))
      .find((h) => h.name === 'Authorization');
    return text.replaceAll('{{mcpToken}}', header?.value?.replace(/^Bearer /, '') ?? '');
  };

  const fill = (env: Env, text: string): string =>
    withToken(env, text)
      .replaceAll('{{prompt}}', env.prompt)
      .replaceAll('{{turn}}', String(env.session.turns))
      .replaceAll('{{sessionId}}', env.session.id)
      .replaceAll('{{cwd}}', env.session.cwd)
      .replaceAll('{{steered}}', env.session.steered.join(' | '));

  const runActions = async (env: Env, actions: Action[]): Promise<'ok' | 'cancelled'> => {
    for (const a of actions) {
      if (env.signal.aborted && !(a.do === 'permission' && a.ignoreCancel)) return 'cancelled';
      let result: 'ok' | 'cancelled' = 'ok';
      switch (a.do) {
        case 'text':
          for (const piece of splitChunks(fill(env, a.text), a.chunks)) await emit(env, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece } });
          break;
        case 'thought':
          for (const piece of splitChunks(a.text, a.chunks)) await emit(env, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: piece } });
          break;
        case 'step':
          result = await runStep(env, a);
          break;
        case 'helper':
          result = await runHelper(env, a);
          break;
        case 'plan':
          result = await runPlan(env, a.entries);
          break;
        case 'permission':
          result = await runPermission(env, a);
          break;
        case 'usage':
          await sendUsage(env, a);
          break;
        case 'sleep':
          if (a.uninterruptible) await new Promise((r) => setTimeout(r, a.ms));
          else if (!(await sleep(a.ms, env.signal))) return 'cancelled';
          break;
        case 'fail':
          throw new RequestError(a.code ?? -32603, fill(env, a.message), a.data);
        case 'stop':
          throw new StopSignal(a.reason);
      }
      if (result === 'cancelled') return 'cancelled';
    }
    return 'ok';
  };

  const pickScenario = (prompt: string): Action[] => {
    const tag = /\[\[([\w-]+)\]\]/.exec(prompt)?.[1];
    const name = tag && script.scenarios[tag] ? tag : script.default && script.scenarios[script.default] ? script.default : Object.keys(script.scenarios)[0];
    return (name ? script.scenarios[name] : undefined) ?? [];
  };

  const promptText = (blocks: Array<{ type: string; text?: string }>): string =>
    blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n');

  const runPrompt = async (client: AgentContext, session: LiveSession, blocks: Array<{ type: string; text?: string }>, epoch: number): Promise<PromptResponse> => {
    if (authScript.requireSignIn && !readAuth().signedIn) throw new RequestError(-32000, 'Authentication required');
    // A `session/cancel` that came after this prompt was received and before it started (it was queued behind another) takes effect: the turn ends cancelled at once.
    if (session.cancelEpoch !== epoch) {
      if (script.cancelDelayMs) await new Promise((r) => setTimeout(r, script.cancelDelayMs));
      return { stopReason: 'cancelled', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } } as PromptResponse;
    }
    const abort = new AbortController();
    session.abort = abort;
    session.turns += 1;
    session.updatedAt = new Date().toISOString();
    const prompt = promptText(blocks);
    session.history.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: prompt } } as SessionUpdate);
    const env: Env = { client, session, signal: abort.signal, prompt, usageSent: false, children: [] };
    let stopReason: StopReason = 'end_turn';
    try {
      const outcome = await runActions(env, pickScenario(prompt));
      if (outcome === 'cancelled') stopReason = 'cancelled';
      else if (script.autoUsage !== false && !env.usageSent) await sendUsage(env, { cost: flavor === 'claude' ? 0.001 : 0 });
    } catch (error) {
      if (error instanceof StopSignal) stopReason = error.reason;
      else throw error;
    } finally {
      session.abort = null;
      persist(session);
    }
    if (stopReason === 'cancelled' && script.cancelDelayMs) await new Promise((r) => setTimeout(r, script.cancelDelayMs));
    const outputTokens = 40 * session.turns;
    return { stopReason, usage: { inputTokens: 12, outputTokens, totalTokens: 12 + outputTokens } } as PromptResponse;
  };

  // ---- replay for resume / load ---------------------------------------------------------------------------------------------------------
  const replay = async (client: AgentContext, session: LiveSession, which: 'all' | 'messages'): Promise<void> => {
    for (const update of session.history) {
      const kind = (update as { sessionUpdate: string }).sessionUpdate;
      if (which === 'messages' && kind !== 'user_message_chunk' && kind !== 'agent_message_chunk') continue;
      await client.notify(methods.client.session.update, { sessionId: session.id, update });
    }
  };
  const hermesMeta = (id: string): Meta => ({
    hermes: {
      sessionProvenance: { acpSessionId: id, currentHermesSessionId: id, rootHermesSessionId: id, parentHermesSessionId: null, sessionKind: 'root', compressionDepth: 0 },
    },
  });

  // ---- the app --------------------------------------------------------------------------------------------------------------------------
  const app = createAgent({ name: `fake-acp-agent-${flavor}` });
  const record = <P>(method: string, params: P): P => {
    received.push({ method, params });
    return params;
  };

  app.onRequest(methods.agent.initialize, ({ params, client }) => {
    record('initialize', params);
    clientCaps = params.clientCapabilities;
    setTimeout(() => void pushAuthStatus(client), 0);
    const name = flavor === 'claude' ? '@agentclientprotocol/claude-agent-acp' : flavor === 'codex' ? '@agentclientprotocol/codex-acp' : 'hermes-agent';
    return {
      protocolVersion: 1,
      agentCapabilities: agentCapabilities() as never,
      agentInfo: { name, title: `Fake ${flavor}`, version: '0.0.0-fake' },
      authMethods: authMethods(clientCaps),
      ...(flavor !== 'hermes' ? { _meta: { steering: { supported: true } } } : {}),
    };
  });

  app.onRequest(methods.agent.authenticate, async ({ params, client, signal, requestId }) => {
    record('authenticate', params);
    const methodId = params.methodId;
    if (methodId === 'chat-gpt-device-code') {
      const elicitationId = randomUUID();
      const method: string = methods.client.elicitation.create;
      const reply = await client.request<{ action: string }, Meta>(method, {
        mode: 'url',
        requestId,
        url: authScript.url ?? 'https://auth.example.test/device',
        message: `Sign in to ChatGPT and enter this code: ${authScript.deviceCode ?? 'ABCD-12345'}`,
        elicitationId,
      });
      if (reply.action !== 'accept') throw new RequestError(-32000, 'Authentication required: Sign-in did not complete');
      const pending = authScript.pendingMs === undefined ? 0 : authScript.pendingMs;
      if (pending === null) {
        await new Promise<void>((resolve, reject) => {
          signInWaiter = resolve;
          signal.addEventListener('abort', () => reject(new RequestError(-32800, 'Request cancelled')), { once: true });
        });
      } else if (pending > 0) {
        await new Promise((r) => setTimeout(r, pending));
      }
      writeAuth({ signedIn: true, kind: 'account' });
      await client.notify(methods.client.elicitation.complete, { elicitationId });
      await pushAuthStatus(client);
      return {};
    }
    if (methodId === 'gateway' || methodId === 'gateway-bedrock') {
      writeAuth({ signedIn: true, kind: 'gateway' });
      await pushAuthStatus(client);
      return {};
    }
    if (methodId === 'custom' || methodId === 'api-key' || methodId === 'chat-gpt') {
      writeAuth({ signedIn: true, kind: 'account' });
      await pushAuthStatus(client);
      return {};
    }
    throw RequestError.invalidParams({ methodId }, 'This method is run by the client in a terminal, not through authenticate');
  });

  if (flavor !== 'hermes' && faults.noLogout !== true) {
    app.onRequest(methods.agent.logout, async ({ params, client }) => {
      record('logout', params);
      writeAuth({ signedIn: false, kind: 'none' });
      await pushAuthStatus(client);
      return {};
    });
  }
  if (flavor === 'claude') {
    app.onRequest(
      'auth/status',
      (params: unknown) => params,
      () => {
        const a = readAuth();
        return {
          state: a.signedIn ? 'authenticated' : 'unauthenticated',
          accounts: a.signedIn
            ? [
                {
                  label: account.label,
                  active: true,
                  email: account.email,
                  organization: account.organization,
                  _meta: { claudeCode: { kind: a.kind, plan: account.plan } },
                },
              ]
            : [],
        };
      },
    );
  }

  const newSession = (id: string, cwd: string, mcpServers: unknown[]): LiveSession => {
    const s: LiveSession = {
      id,
      cwd,
      mode: MODES[flavor].current,
      mcpServers,
      turns: 0,
      cost: 0,
      used: flavor === 'hermes' ? 9494 : 0,
      planCalls: 0,
      title: '',
      updatedAt: new Date().toISOString(),
      history: [],
      options: {},
      steered: [],
      abort: null,
      queue: Promise.resolve(),
      cancelEpoch: 0,
    };
    sessions.set(id, s);
    persist(s);
    return s;
  };

  app.onRequest(methods.agent.session.new, ({ params }) => {
    record('session/new', params);
    const s = newSession(randomUUID(), params.cwd, (params.mcpServers ?? []) as unknown[]);
    return { sessionId: s.id, modes: modeState(s.mode), configOptions: configOptions(s) as never };
  });

  app.onRequest(methods.agent.session.resume, async ({ params, client }) => {
    record('session/resume', params);
    let s = findSession(params.sessionId);
    if (!s) {
      if (flavor !== 'hermes') throw unknownSession(params.sessionId);
      s = newSession(params.sessionId, params.cwd, []); // Hermes: an unknown id is not an error
      return { modes: modeState(s.mode), configOptions: configOptions(s) } as never;
    }
    if (faults.open) throw new RequestError(faults.open.code, faults.open.message, faults.open.data);
    s.cwd = params.cwd;
    s.mcpServers = (params.mcpServers ?? []) as unknown[];
    if (flavor === 'hermes') await replay(client, s, 'all');
    return { ...(flavor === 'claude' ? { sessionId: s.id } : {}), modes: modeState(s.mode), configOptions: configOptions(s), ...(flavor === 'hermes' ? { _meta: hermesMeta(s.id) } : {}) } as never;
  });

  app.onRequest(methods.agent.session.load, async ({ params, client }) => {
    record('session/load', params);
    const s = findSession(params.sessionId);
    if (!s) {
      if (flavor === 'hermes') return {};
      throw unknownSession(params.sessionId);
    }
    if (faults.open) throw new RequestError(faults.open.code, faults.open.message, faults.open.data);
    s.cwd = params.cwd;
    s.mcpServers = (params.mcpServers ?? []) as unknown[];
    await replay(client, s, flavor === 'hermes' ? 'all' : 'messages');
    return { modes: modeState(s.mode), configOptions: configOptions(s), ...(flavor === 'hermes' ? { _meta: hermesMeta(s.id) } : {}) } as never;
  });

  app.onRequest(methods.agent.session.list, ({ params }) => {
    record('session/list', params);
    const cwd = params.cwd;
    return {
      sessions: storedSessions()
        .filter((s) => !cwd || s.cwd === cwd)
        .map((s) => ({ sessionId: s.id, cwd: s.cwd, title: s.title || null, updatedAt: s.updatedAt })),
    };
  });

  app.onRequest(methods.agent.session.close, ({ params }) => {
    record('session/close', params);
    sessions.delete(params.sessionId);
    return {};
  });

  app.onRequest(methods.agent.session.delete, ({ params }) => {
    record('session/delete', params);
    sessions.delete(params.sessionId);
    const file = sessionFile(params.sessionId);
    if (file) rmSync(file, { force: true });
    return {};
  });

  app.onRequest(methods.agent.session.setMode, ({ params }) => {
    record('session/set_mode', params);
    const s = findSession(params.sessionId);
    if (!s) throw unknownSession(params.sessionId);
    if (faults.setMode) throw new RequestError(-32603, 'Internal error', { details: 'set_mode is not available' });
    if (!MODES[flavor].list.some(([id]) => id === params.modeId)) throw RequestError.invalidParams({ modeId: params.modeId }, 'Unknown mode');
    s.mode = params.modeId;
    return {};
  });

  app.onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    record('session/set_config_option', params);
    const s = findSession(params.sessionId);
    if (!s) throw unknownSession(params.sessionId);
    const id = (params as { configId: string }).configId;
    const value = String((params as { value: unknown }).value);
    if (faults.setConfig?.includes(id)) throw new RequestError(-32603, 'Internal error', { details: `${id} cannot be changed` });
    const option = configOptions(s).find((o) => o['id'] === id);
    if (!option) throw RequestError.invalidParams({ configId: id }, 'Unknown config option');
    if (!(option['options'] as Array<{ value: string }>).some((o) => o.value === value)) throw RequestError.invalidParams({ configId: id, value }, 'Unknown value');
    if (id === 'mode') s.mode = value;
    else s.options[id] = value;
    return { configOptions: configOptions(s) } as never;
  });

  app.onRequest(methods.agent.session.prompt, ({ params, client }) => {
    record('session/prompt', params);
    const s = findSession(params.sessionId);
    if (!s) throw unknownSession(params.sessionId);
    const epoch = s.cancelEpoch;
    const run = s.queue.then(() => runPrompt(client, s, params.prompt as Array<{ type: string; text?: string }>, epoch));
    s.queue = run.catch(() => undefined);
    return run;
  });

  if (flavor !== 'hermes') {
    // Steering: a note put to the turn that is running (`_session/steering`, advertised in the initialize result's `_meta.steering`).
    app.onRequest(
      '_session/steering',
      (params: unknown) => params as { sessionId: string; prompt: Array<{ type: string; text?: string }>; _meta?: unknown },
      ({ params }) => {
        record('_session/steering', params);
        const s = findSession(params.sessionId);
        if (!s) throw unknownSession(params.sessionId);
        if (!s.abort) throw new RequestError(-32602, 'No turn is running to steer');
        s.steered.push(promptText(params.prompt));
        return {};
      },
    );
  }

  app.onNotification(methods.agent.session.cancel, ({ params }) => {
    record('session/cancel', params);
    const s = sessions.get(params.sessionId);
    if (!s) return;
    s.cancelEpoch += 1;
    s.abort?.abort();
  });

  return {
    app,
    received,
    sessions,
    completeSignIn: () => signInWaiter?.(),
    isSignedIn: () => readAuth().signedIn,
  };
}
