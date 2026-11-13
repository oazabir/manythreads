import type { BotFrontmatter } from '@manythreads/shared';
import type { ProviderImpl } from './types.ts';

// The `provider.bot_runtime` contract (SPEC §7.1, §7.2; PLAN P5-10): what a runtime plugin offers the platform, and the
// only way a bot definition becomes something that runs. `runtime-hermes` registers the `hermes` provider, `runtime-rules`
// the `rules` one, and the router asks for the provider the loaded bot's `runtime` column names
// (`ctx.providers.get<BotRuntimeProvider>('bot_runtime', bot.runtime)`).
//
// A provider never touches the database: it is handed a definition, the per-run endpoint and a scope whose `invoke` calls
// the capabilities the run may use — so a runtime is testable without a server, and the trust boundaries (the run's bot
// transaction, the asker's visibility, the source log) stay in one place, the router that opened the run.

/** The definition a run executes: the parsed `BOT.md` (frontmatter and body), never the file. */
export interface BotRuntimeDefinition {
  frontmatter: BotFrontmatter;
  /** The prose after the fence — the Hermes profile's `SOUL.md`, verbatim. */
  body: string;
}

/** The bot a run belongs to, as the roster row has it. */
export interface BotRuntimeBot {
  id: string;
  slug: string;
  name: string;
  teamId: string;
  workspaceId: string;
  /** The `bots.runtime` value (also the provider's `id`). */
  runtime: string;
  definitionSha: string;
}

/** Who asked, when a person did. */
export interface BotRuntimeAsker {
  actorId: string;
  personId: string | null;
  displayName: string | null;
}

/** Where the run answers (`conversation`, `mention` and `channel_message` runs always have one). */
export interface BotRuntimeThread {
  channelId: string;
  threadRootId: string | null;
}

/** The run's own MCP endpoint (`ctx.runs.open`): the bot's tools, scoped to this run alone. */
export interface BotRuntimeEndpoint {
  runId: string;
  url: string;
  token: string;
}

/** The LLM gateway a model-backed runtime points its profile at, with the bot's own virtual key (null when it has none). */
export interface BotRuntimeGateway {
  baseUrl: string;
  key: string | null;
}

/** The definition's `limits`, resolved: what the run may spend. */
export interface BotRuntimeLimits {
  runBudgetSeconds: number | null;
  maxTurns: number | null;
  sessionMinutes: number | null;
}

export interface BotRuntimeInput {
  bot: BotRuntimeBot;
  definition: BotRuntimeDefinition;
  /** The `BOT.md` trigger that fired this run (`conversation`, `mention`, `channel_message`, ...). */
  trigger: string;
  asker: BotRuntimeAsker | null;
  /** What the run was asked, as one prompt: the message that named the bot, or the question a person sent. */
  prompt: string;
  thread: BotRuntimeThread | null;
  /** The per-run endpoint (`url` carries no credential: the run's token goes in an `Authorization: Bearer` header); null for a runtime with no tools. */
  endpoint: BotRuntimeEndpoint | null;
  gateway: BotRuntimeGateway | null;
  limits: BotRuntimeLimits;
}

/**
 * What a running runtime may do beyond its own profile. Every call lands in the run's own transactions, so a tool call
 * carries the run's bot (for a write) or the asking person (for a read) and the run id the source log insists on.
 */
export interface BotRuntimeScope {
  /**
   * One model turn through the platform's LLM gateway, for a runtime that has no model of its own (the `model` runtime, P19-10). The run job makes the call as the run's bot: the
   * pre-call guard, the budgets and rate limits and the spend ledger all apply, and the spend lands under the bot and the run. Absent when the gateway is not loaded.
   */
  model?: { turn(request: ModelTurnRequest): Promise<ModelTurnResult> };
  /**
   * The bot's tools as the MCP gateway offers them (the same list and the same door: grants, approvals, the data-loss check, the source log), for a runtime that calls tools itself.
   * Absent when the MCP gateway is not loaded.
   */
  tools?: {
    list(): Promise<ModelToolSpec[]>;
    call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  };
  /** Call a capability the run may use, through the broker (`ctx.runs.invoke` in the run's own transaction). */
  invoke(capability: string, input: Record<string, unknown>): Promise<unknown>;
  /** Record something the run read (`run_source_log`); answers the line's position. */
  logSource(source: { sourceType: string; sourceRef: string; scope: 'team' | 'channel' | 'person' }): Promise<number>;
  /** One line to the server log (`job.log`): run metrics, never secrets. */
  log(message: string): void;
}

/** Why a run failed, when the runtime knows it better than the error text says. `limit` is a budget, rate limit or safety rule; `gateway` a model gateway that did not answer; `steps` a loop that used up its steps; `too_long` an answer the model could not finish within its length limit. */
export type BotRuntimeFailure = 'runner_offline' | 'hermes_unreachable' | 'timeout' | 'runner_refused' | 'limit' | 'gateway' | 'steps' | 'too_long';

/** A tool as a model is told about it. */
export interface ModelToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A tool the model asked to call. `arguments` is the JSON text the model wrote. */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** One message of a model conversation, in the shape every chat model takes. */
export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** On an assistant message: the tools it asked for. */
  toolCalls?: ModelToolCall[];
  /** On a tool message: which call it answers. */
  toolCallId?: string;
}

export interface ModelTurnRequest {
  /** The gateway alias to call (`smart`, `fast`, ...). */
  alias: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens: number;
  /** The first turn of a run counts as one request against the bot's per-minute limit; the turns after it do not (budgets count every token). */
  firstTurn: boolean;
  /**
   * How many leading messages the gateway has already checked and redacted on an earlier turn. Every user and tool message after that point is checked this turn, so a secret in any of
   * them (several parallel tool answers, say) is caught once and never sent again in clear text.
   */
  checkedUpTo: number;
  timeoutMs?: number;
}

export type ModelTurnResult =
  | {
      ok: true;
      text: string | null;
      toolCalls: ModelToolCall[];
      promptTokens: number;
      completionTokens: number;
      /** The conversation as it was sent, with any redaction applied: the caller keeps THIS as its history, so a redacted secret is never sent again in clear text. Same length and order as the request's. */
      messages: ModelMessage[];
      /** The model stopped because it ran out of room to write (its answer is cut off), not because it was done. */
      truncated: boolean;
    }
  /** `refused`: a budget, a rate limit or a guardrail said no. `unbound`: the alias is not bound to a model here. `unavailable`: the model did not answer. `timeout`: the clock ran out. */
  | { ok: false; reason: 'refused' | 'unbound' | 'unavailable' | 'timeout'; detail: string };

/** One event off a run's stream. `result` is the terminal one and carries the final text. */
export type BotRuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; reason?: string | undefined }
  /**
   * The bot's own program stopped inside the run to ask a person (P24): its shell wants to run a command it thinks is risky. The run is paused until `answer` is
   * called; the stream carries on only after that. `choices` are the answers the program accepts (`once`, `session`, `always`, `deny`). `answer` resolves false when the
   * program no longer waits (the run ended, or the question was already answered).
   */
  | {
      type: 'approval';
      command: string;
      description: string;
      choices: readonly string[];
      answer(choice: 'once' | 'session' | 'deny', note?: string): Promise<boolean>;
    }
  | {
      type: 'result';
      text: string;
      ok: boolean;
      error?: string;
      /** Why a failed run failed, when the runtime knows it better than the error text says: the runner was not there, or the clock ran out. */
      failure?: BotRuntimeFailure;
      /** With `failure: 'runner_refused'`: the runner catalog turned the run away before anything started. `line` is the one plain sentence to post; `reason` is from a fixed list. */
      refusal?: { runner: string; reason: string; line: string };
      /** What the model reported for this turn, when the runtime knows (a Hermes `result` record carries it). */
      tokens?: { input: number; output: number; total: number } | null;
      /**
       * Set when the run was served by a team's Hermes pod: every model call of a pod goes through the platform's model gateway, so the run job expects a spend
       * line for it (and raises `bot_runner.run.unmetered` when there is none). `runner` is the pod runner's name.
       */
      viaPod?: { runner: string };
      /**
       * Set when the run was served by a shared Claude Code runner (P19-07): the run job counts it per team (`recordUsage`) and, when the plan's limit was reached or the sign-in was
       * refused, pauses the runner (`pauseRunner`). `failure` is a fixed word from the bridge; `resetsAt` an ISO time; `cost` is the CLI's own figure, its number and not a price.
       */
      viaClaude?: { runner: string; seconds: number; cost: number | null; failure?: 'plan_limit' | 'needs_sign_in'; resetsAt?: string | null };
    };

export interface BotRuntimeHandle {
  /** Stop the run (kill the process, release the container). Idempotent. */
  stop(): Promise<void>;
  /** The run's events, in order, ending after the terminal `result`. */
  events: AsyncIterable<BotRuntimeEvent>;
}

/** What `render` produces: the files of the profile home, and where that home is. */
export interface BotRuntimeProfile {
  /**
   * The profile's files by path relative to `home` (`config.yaml`, `SOUL.md`). `run` writes them where its own runtime
   * reads them; `render` is separate and pure so the profile a definition produces can be asserted in a test.
   */
  files: Record<string, string>;
  /** The directory name under the runtime's data root (`MANYTHREADS_RUNTIME_DIR`): one per run, removed when it ends. */
  home: string;
}

/**
 * One bot runtime. `render` is pure — same input, same files — so a definition's profile can be diffed and tested; `run`
 * is the only part that executes anything.
 */
export interface BotRuntimeProvider extends ProviderImpl {
  /** The `bots.runtime` value this provider runs: `hermes` or `rules`. */
  id: string;
  /**
   * The runtime talks to a model through the LLM gateway. The router then hands it the gateway and the bot's virtual key and
   * asks the gateway's pre-call check (preset, DLP hook, budgets) before the run; a provider without it (`rules`) gets none
   * of that and is never refused for a missing model, because it makes no model call.
   */
  usesGateway?: boolean;
  /**
   * The runtime sends the asker's message to **a model**, by whatever route, and so must pass the bot's gate (SPEC §7.3, `guard.gate` in BOT.md) first.
   * Separate from `usesGateway` on purpose: a subscription runtime (Claude Code, Codex; SPEC §10.3) reaches its model without the LLM gateway, and
   * "no gateway" must not read as "no gate". Required, so a new runtime that talks to a model cannot be left ungated by forgetting a field: every provider says `true` (it sends the message to a model) or `false` (it makes no model call, like `rules`).
   */
  gated: boolean;
  /** The profile a run of `input` executes in. */
  render(input: BotRuntimeInput): BotRuntimeProfile;
  /** Start one run. The caller stops it (and ends the run) when `events` ends or the run is too long. */
  run(input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle>;
}
