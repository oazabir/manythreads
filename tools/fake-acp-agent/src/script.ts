import { readFileSync } from 'node:fs';

/*
 * The script a fake ACP agent plays (P25-02). A script is plain JSON, so a test, a file or an env var can hold it. The
 * shapes of what is sent follow `docs/spikes/acp-measured.md` (P25-01), per adapter "flavor".
 */

/** Which real adapter the fake imitates: its sign-in methods, option ids, step statuses, replay and error rules. */
export type Flavor = 'claude' | 'codex' | 'hermes';

export type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export interface StepAction {
  do: 'step';
  /** The tool call id. Default: made up per flavor (`toolu_fake_1`, `call_fake_1`, `tc-fake1`). */
  id?: string;
  /** The final title (Claude refines it in an update after the generic one). */
  title: string;
  /** Claude's first, generic title ("Read File", "Terminal"). Default: the title. */
  genericTitle?: string;
  kind?: ToolKind;
  /** The tool's name (`Read`, `Bash`, `mcp__manythreads__mt_note`); Claude puts it in `_meta.claudeCode.toolName`. */
  toolName?: string;
  /** Paths the step touches; a relative path is made absolute against the session's folder. */
  paths?: string[];
  /** What goes into `rawInput` (the bridge must drop it). */
  input?: unknown;
  /** The output the adapters leak (`toolResponse`, `terminal_output_delta`, `content`); the bridge must drop it. */
  output?: string;
  /** An edit: sent as a `diff` content block. */
  diff?: { path: string; oldText: string | null; newText: string };
  /** How long the step runs before it ends; a `session/cancel` interrupts it (a "slow step"). */
  ms?: number;
  /** The step fails. A string is the error text. */
  fail?: boolean | string;
  /** Put the adapter's leaks (`rawInput`, `toolResponse`, ...) on the wire. Default true: the real adapters do. */
  leak?: boolean;
  /**
   * Starts a real child process in the adapter's own process group when the step begins (a command the adapter runs) and writes its pid to this file. Claude and Hermes end
   * it when the turn is cancelled; Codex does not (measured: the command was still running 12 s after `session/cancel`), so only a stop of the process group ends it.
   */
  spawn?: string;
}

export interface HelperAction {
  do: 'helper';
  id?: string;
  /** The helper's description (Claude: the `Agent` call's title). */
  name: string;
  agentType?: string;
  /** The helper's own steps. Claude flavor sends them with `_meta.claudeCode.parentToolUseId`; Codex and Hermes send none. */
  steps?: Array<Omit<StepAction, 'do'>>;
  report?: string;
}

export interface PermissionAction {
  do: 'permission';
  /** The step that waits for the answer. */
  step: Omit<StepAction, 'do'>;
  /** An MCP tool approval (Codex: four options and no title). */
  mcp?: boolean;
  /** Actions that run when the person said no; the turn ends after them. */
  onReject?: Action[];
  /** The request is sent and waited for even when a cancel came first (an adapter already inside the call does that). Default false. */
  ignoreCancel?: boolean;
}

export interface PlanEntryInput {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export type Action =
  | { do: 'text'; text: string; /** Split into this many chunks. */ chunks?: number }
  | { do: 'thought'; text: string; chunks?: number }
  | StepAction
  | HelperAction
  /** Claude: a `plan` update with the whole list. Hermes: a `todo_list` step instead. Codex: nothing, as measured. */
  | { do: 'plan'; entries: PlanEntryInput[] }
  | PermissionAction
  /** A `usage_update`; `cost` (USD) is added to the session's cumulative cost, and only the Claude flavor sends it. */
  | { do: 'usage'; used?: number; size?: number; cost?: number }
  /** `uninterruptible`: a `session/cancel` does not end the sleep (a tool that does not look at the cancel). */
  | { do: 'sleep'; ms: number; uninterruptible?: boolean }
  /** Ends the prompt with a JSON-RPC error. */
  | { do: 'fail'; message: string; code?: number; data?: unknown }
  /** Ends the prompt with this stop reason (default `end_turn`). */
  | { do: 'stop'; reason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled' };

export interface AuthScript {
  /** Signed in at start. Default true. */
  signedIn?: boolean;
  /** `session/prompt` fails with -32000 "Authentication required" when not signed in. Default false. */
  requireSignIn?: boolean;
  /** The sign-in page (device code: Codex's `elicitation/create` url; terminal login: the URL the program prints). */
  url?: string;
  /** The one-time code in the device-code message text. */
  deviceCode?: string;
  /** After the person accepts, how long until the sign-in finishes: 0 at once, a number of ms, or `null` until `completeSignIn()`. */
  pendingMs?: number | null;
  /** What `auth/status` and `_auth/status_update` report as the account (they carry an e-mail, which the bridge must never forward). */
  account?: { label?: string; plan?: string; email?: string; organization?: string };
}

/** Things an adapter does wrong or does not offer, for a test of the client's answer to them. */
export interface FaultScript {
  /** `session/set_mode` answers an error (the client then tries `set_config_option`). */
  setMode?: boolean;
  /** `session/set_config_option` refuses these config ids with an error. */
  setConfig?: string[];
  /** `session/resume` and `session/load` of a session that exists answer this error. */
  open?: { code: number; message: string; data?: unknown };
  /** The adapter does not advertise `session/resume` (a client has to use `session/load`). */
  noResume?: boolean;
  /** The adapter does not advertise `logout` (a client falls back to the adapter's own `--cli auth logout` program). Claude and Codex flavors. */
  noLogout?: boolean;
  /** `mcpCapabilities.http` is false (Claude and Codex flavors; Hermes advertises none). */
  noHttp?: boolean;
}

export interface FakeScript {
  flavor?: Flavor;
  /** Where sessions and the sign-in are kept, so a second process can resume or load them. Default: in memory only. */
  stateDir?: string;
  auth?: AuthScript;
  faults?: FaultScript;
  /** Named scenarios. A prompt that contains `[[name]]` plays that one; else `default`; else the first. */
  scenarios: Record<string, Action[]>;
  default?: string;
  /** How long after `session/cancel` the prompt answers `cancelled` (the real adapters: 15 ms to 4 s). Default 0. */
  cancelDelayMs?: number;
  /** Send a `usage_update` at the end of a prompt that sent none. Default true. */
  autoUsage?: boolean;
  /** Pause between the notifications of one prompt, so a client sees them arrive one at a time. Default 0. */
  tickMs?: number;
}

/** A script that exercises every kind of frame once. */
export const DEFAULT_SCRIPT: FakeScript = {
  flavor: 'claude',
  scenarios: {
    hello: [{ do: 'text', text: 'Hello from the fake agent.', chunks: 3 }],
    work: [
      { do: 'thought', text: 'Looking at the project first.' },
      { do: 'plan', entries: [{ content: 'Read the package', status: 'in_progress' }, { content: 'Change the name' }] },
      { do: 'step', title: 'Read package.json', genericTitle: 'Read File', kind: 'read', toolName: 'Read', paths: ['package.json'], output: '{"name":"demo"}' },
      { do: 'step', title: 'Run the tests', genericTitle: 'Terminal', kind: 'execute', toolName: 'Bash', input: { command: 'pnpm test' }, output: '3 passed' },
      {
        do: 'step',
        title: 'Edit package.json',
        genericTitle: 'Preparing edit',
        kind: 'edit',
        toolName: 'Edit',
        paths: ['package.json'],
        diff: { path: 'package.json', oldText: '"name":"demo"', newText: '"name":"renamed"' },
      },
      {
        do: 'helper',
        name: 'Read notes.txt',
        agentType: 'general-purpose',
        steps: [{ title: 'Read notes.txt', genericTitle: 'Read File', kind: 'read', toolName: 'Read', paths: ['notes.txt'] }],
        report: 'The notes say hello.',
      },
      {
        do: 'plan',
        entries: [
          { content: 'Read the package', status: 'completed' },
          { content: 'Change the name', status: 'completed' },
        ],
      },
      { do: 'text', text: 'Done. The package is renamed.', chunks: 4 },
      { do: 'usage', used: 12555, cost: 0.0038 },
    ],
    permission: [
      { do: 'text', text: 'I need to create a file.' },
      {
        do: 'permission',
        step: {
          title: 'touch spike-a.txt',
          genericTitle: 'Terminal',
          kind: 'execute',
          toolName: 'Bash',
          paths: ['spike-a.txt'],
          input: { command: 'touch spike-a.txt' },
        },
        onReject: [{ do: 'text', text: 'Declined.' }],
      },
      { do: 'text', text: 'Created.' },
    ],
    slow: [
      { do: 'text', text: 'Starting a long command.' },
      { do: 'step', title: 'sleep 90', genericTitle: 'Terminal', kind: 'execute', toolName: 'Bash', input: { command: 'sleep 90' }, ms: 90_000 },
      { do: 'text', text: 'It finished.' },
    ],
    fail: [
      { do: 'text', text: 'Trying.' },
      { do: 'step', title: 'cat missing.txt', kind: 'execute', toolName: 'Bash', fail: 'No such file', ms: 0 },
      { do: 'fail', message: 'The model is overloaded', code: -32603 },
    ],
  },
  default: 'work',
};

/** Loads a script from `--script=<file>`, `FAKE_ACP_SCRIPT` (a file) or `FAKE_ACP_SCRIPT_JSON` (the JSON itself); else the default. */
export function loadScript(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): FakeScript {
  const arg = argv.find((a) => a.startsWith('--script='))?.slice('--script='.length);
  const file = arg ?? env.FAKE_ACP_SCRIPT;
  let script: FakeScript;
  if (file) script = JSON.parse(readFileSync(file, 'utf8')) as FakeScript;
  else if (env.FAKE_ACP_SCRIPT_JSON) script = JSON.parse(env.FAKE_ACP_SCRIPT_JSON) as FakeScript;
  else script = structuredClone(DEFAULT_SCRIPT);
  if (env.FAKE_ACP_FLAVOR) script.flavor = env.FAKE_ACP_FLAVOR as Flavor;
  if (env.FAKE_ACP_STATE_DIR) script.stateDir = env.FAKE_ACP_STATE_DIR;
  if (!script.scenarios || Object.keys(script.scenarios).length === 0) throw new Error('A fake ACP script needs at least one scenario');
  return script;
}
