import type { BotRuntimeEvent, BotRuntimeHandle, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { AGENT_BRIDGE_RUN_KEY, type AgentBridgeRunExtension, type HermesConnectionAgent } from '@manythreads/shared';
import { guardedFetch } from './outbound.ts';
import { refusedRun } from './refused.ts';

// The gateway transport: a bot's run as one request to a Hermes gateway (`api_server`, v0.21.5), instead of a process this server starts.
//
// The wire (docs/plugins/runtime-hermes.md, "The gateway wire"): the profile is chosen by the URL prefix `/p/<profile>/v1/...`; the profile's
// own API key goes in `Authorization: Bearer`; `POST /v1/runs` with an `Idempotency-Key` answers 202 `{run_id}`; `GET /v1/runs/<id>/events` is a
// stream of server-sent events (`tool.started`, `tool.completed`, `message.delta`, ..., then `run.completed | run.failed | run.cancelled`);
// `POST /v1/runs/<id>/stop` stops the run. A gateway over its live-run cap answers 429 with `Retry-After`.
//
// What makes it safe to repeat: the idempotency key is OUR run id, so a retried start returns the run that already exists (never a second
// one); and one Hermes *session* is one thread (`session_id = <bot id>:<thread root id>`), so the bot remembers the thread's earlier turns on
// its own side without this server resending them.
//
// The model, tools and the MCP connection back to this server live in the PROFILE, which is not ours in mode A and is rendered by us in mode B
// (`gateway-profile.ts`). Nothing about them travels in the request, except the prompt.

/** Where a gateway is and the key that opens it. */
export interface GatewayTarget {
  baseUrl: string;
  apiKey: string;
  /** True for an address a team lead typed: every request then goes through the outbound guard (`outbound.ts`). False for the platform's own pod. */
  guarded?: boolean;
  /** `managed` is the team's own pod, whose profiles already carry the definition's body as SOUL.md; `external` is a gateway the customer runs. */
  kind: 'managed' | 'external';
  /** What answers behind the address. `claude-code` and `codex` are the agent bridge, which gets a token for the run; `hermes` never does. */
  agent: HermesConnectionAgent;
}

/** The largest single event the stream may carry, and the largest document a gateway may answer a request with. A gateway is not trusted to be polite. */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export class GatewayResponseTooLarge extends Error {
  constructor(what: string) {
    super(`the Hermes gateway sent ${what} that is too large`);
    this.name = 'GatewayResponseTooLarge';
  }
}

/** Read a response body as text, refusing more than `MAX_BODY_BYTES`. */
export async function readLimitedText(res: Response, max = MAX_BODY_BYTES): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new GatewayResponseTooLarge('a response');
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return out + decoder.decode();
}

export async function readLimitedJson(res: Response, max = MAX_BODY_BYTES): Promise<unknown> {
  try {
    return JSON.parse(await readLimitedText(res, max));
  } catch (err) {
    if (err instanceof GatewayResponseTooLarge) throw err;
    return null;
  }
}

export interface GatewayRuntimeOptions {
  /** The connection a bot is placed on, resolved per run (a team can change its connections at any time). Null when there is none by that name. */
  resolve(query: { teamId: string; botId: string; botSlug: string; connection: string }): Promise<GatewayTarget | null>;
  /** Injectable for tests; the global `fetch`. */
  fetch?: typeof fetch;
  /** Between asking a run to stop and giving up on its stream. */
  killGraceSeconds: number;
  /** Test knobs: the pause unit of the 429 backoff (default 1000 ms) and how long one request may take (default 30 s). */
  retryUnitMs?: number;
  requestTimeoutMs?: number;
}

export interface GatewayPlacement {
  connection: string;
  profile?: string | undefined;
}

/** The profile a bot runs as: `mt-<slug>` on the team's own pod, the name the customer gave on their own gateway. */
export const managedProfileName = (botSlug: string): string => `mt-${botSlug}`;
export const profileFor = (botSlug: string, placement: GatewayPlacement): string =>
  placement.connection === 'managed' || placement.profile === undefined ? managedProfileName(botSlug) : placement.profile;

/** One Hermes session per thread: the bot id keeps two bots' sessions apart, though each lives in its own profile already. */
export const sessionIdFor = (botId: string, threadRootId: string | null, runId: string): string => `${botId}:${threadRootId ?? runId}`;

const DEFAULT_BUDGET_SECONDS = 600;
const MAX_START_WAIT_SECONDS = 120;
const MAX_STREAM_REOPENS = 5;
const POLL_MS = 2000;

type Terminal = { event: string; fields: Record<string, unknown> };

/** Split a stream of bytes into the JSON objects of its `data:` lines. Comment frames (`: keepalive`) and anything that is not JSON are skipped. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_FRAME_BYTES && buffer.indexOf('\n\n') === -1) throw new GatewayResponseTooLarge('an event');
      for (let cut = buffer.indexOf('\n\n'); cut !== -1; cut = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, cut);
        if (frame.length > MAX_FRAME_BYTES) throw new GatewayResponseTooLarge('an event');
        buffer = buffer.slice(cut + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data === '') continue;
        try {
          const parsed: unknown = JSON.parse(data);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
        } catch {
          /* a frame that is not JSON carries nothing we read */
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const tokensOf = (usage: unknown): { input: number; output: number; total: number } | null => {
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = n(u['input_tokens']);
  const output = n(u['output_tokens']);
  return { input, output, total: n(u['total_tokens']) || input + output };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runOnGateway(
  options: GatewayRuntimeOptions,
  input: BotRuntimeInput,
  scope: BotRuntimeScope,
  placement: GatewayPlacement,
): Promise<BotRuntimeHandle> {
  const runId = input.endpoint?.runId ?? '?';
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const retryUnitMs = options.retryUnitMs ?? 1000;
  const profile = profileFor(input.bot.slug, placement);

  let target: GatewayTarget | null;
  try {
    target = await options.resolve({ teamId: input.bot.teamId, botId: input.bot.id, botSlug: input.bot.slug, connection: placement.connection });
  } catch (err) {
    scope.log(`runtime-hermes: run ${runId}: the connection "${placement.connection}" could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return refusedRun(`the Hermes connection "${placement.connection}" could not be read`);
  }
  if (!target) {
    return refusedRun(`bot ${input.bot.slug} is placed on the Hermes connection "${placement.connection}", which this team does not have`);
  }
  const doFetch = options.fetch ?? (target.guarded === true ? guardedFetch : fetch);
  const base = `${target.baseUrl.replace(/\/+$/, '')}/p/${encodeURIComponent(profile)}/v1`;
  const headers = { authorization: `Bearer ${target.apiKey}` };

  /** A request with its own deadline; a network failure and a timeout both throw. */
  const call = async (path: string, init: RequestInit = {}, timeoutMs = requestTimeoutMs): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    return doFetch(`${base}${path}`, { ...init, redirect: 'error', headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal });
  };

  const budgetMs = (input.limits.runBudgetSeconds ?? DEFAULT_BUDGET_SECONDS) * 1000;
  const startedAt = Date.now();
  const unreachable = (what: string): BotRuntimeHandle => {
    scope.log(`runtime-hermes: run ${runId}: the Hermes gateway of connection "${placement.connection}" is unreachable (${what})`);
    return refusedRun(`the bot's Hermes is unreachable (connection "${placement.connection}")`, 'hermes_unreachable');
  };

  // Start: the same request is safe to repeat, because the key is the run's id.
  const runBody: Record<string, unknown> = {
    input: input.prompt,
    session_id: sessionIdFor(input.bot.id, input.thread?.threadRootId ?? null, runId),
  };
  // A gateway the customer runs knows nothing of the definition, so its body (what the bot is and how it behaves) goes with every run as
  // `instructions`, which Hermes adds to its system prompt on each model call. The team's own pod needs no copy: its profiles carry it as SOUL.md.
  const instructions = input.definition.body.trim();
  if (target.kind !== 'managed' && instructions !== '') runBody['instructions'] = instructions;
  // The agent bridge starts a fresh process per run and has no bot credential of its own, so what that process needs travels in the request,
  // including the token of this one run. A Hermes agent never gets the token: it reaches the platform with its profile's own credential.
  if (target.agent !== 'hermes') {
    if (input.endpoint === null) return refusedRun(`bot ${input.bot.slug} has no tools endpoint for this run, which the ${target.agent} agent on "${placement.connection}" needs`);
    const alias = input.definition.frontmatter.model?.aliases?.[0];
    const effort = input.definition.frontmatter.model?.effort;
    const extension: AgentBridgeRunExtension = {
      bot: input.bot.slug,
      runId,
      mcp: { url: input.endpoint.url, token: input.endpoint.token },
      tools: input.definition.frontmatter.capabilities?.runtime ?? [],
      ...(alias !== undefined || effort !== undefined ? { model: { ...(alias !== undefined ? { alias } : {}), ...(effort !== undefined ? { effort } : {}) } } : {}),
      budgetSeconds: input.limits.runBudgetSeconds,
      maxTurns: input.limits.maxTurns,
    };
    runBody[AGENT_BRIDGE_RUN_KEY] = extension;
  }
  const startRemote = async (requestBody: string, key: string): Promise<{ id: string } | { handle: BotRuntimeHandle }> => {
    let hermesRunId: string | null = null;
    for (let attempt = 0; hermesRunId === null; attempt += 1) {
      let res: Response;
      try {
        res = await call('/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: requestBody });
      } catch (err) {
        return { handle: unreachable(err instanceof Error ? err.name : 'error') };
      }
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const asked = Number(res.headers.get('retry-after'));
        const pause = Math.min(30, Math.max(Number.isFinite(asked) && asked > 0 ? asked : 1, 2 ** Math.min(attempt, 5)));
        if ((Date.now() - startedAt) / 1000 + pause > MAX_START_WAIT_SECONDS) return { handle: refusedRun("the bot's Hermes is busy: it is at its limit of runs at once") };
        scope.log(`runtime-hermes: run ${runId}: the gateway is at its run limit; retrying in ${pause}s`);
        await sleep(pause * retryUnitMs);
        continue;
      }
      if (res.status === 502 || res.status === 503 || res.status === 504) {
        await res.body?.cancel().catch(() => undefined);
        return { handle: unreachable('the gateway answered that it is not available') };
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        return { handle: refusedRun(`the Hermes gateway of connection "${placement.connection}" refused this bot's API key; check the connection's key`) };
      }
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        return { handle: refusedRun(`the Hermes gateway of connection "${placement.connection}" has no profile "${profile}"`) };
      }
      if (!res.ok) {
        // The status only: what a gateway (or whatever sits at a typed address) says in its body is not repeated into messages or logs.
        await res.body?.cancel().catch(() => undefined);
        return { handle: refusedRun(`the Hermes gateway did not accept the run (status ${res.status})`) };
      }
      const parsed = (await readLimitedJson(res).catch(() => null)) as { run_id?: unknown } | null;
      if (typeof parsed?.run_id !== 'string' || parsed.run_id === '') return { handle: refusedRun('the Hermes gateway answered a run without an id') };
      hermesRunId = parsed.run_id;
    }
    return { id: hermesRunId };
  };
  const first = await startRemote(JSON.stringify(runBody), runId);
  if ('handle' in first) return first.handle;
  let remoteId = first.id;

  let stopping: Promise<void> | undefined;
  let finished = false;
  const stop = (): Promise<void> =>
    finished
      ? Promise.resolve()
      : (stopping ??= call(`/runs/${encodeURIComponent(remoteId)}/stop`, { method: 'POST' }, 10_000).then(
      (r) => void r.body?.cancel().catch(() => undefined),
      () => undefined,
    ));

  // The platform's own ceiling: the budget plus the grace. Past it the run is stopped, and the stream given a moment to say so.
  let timedOut = false;
  const abort = new AbortController();
  const ceiling = setTimeout(() => {
    timedOut = true;
    scope.log(`runtime-hermes: run ${runId} exceeded ${Math.round(budgetMs / 1000) + options.killGraceSeconds}s and was stopped`);
    void stop();
    setTimeout(() => abort.abort(), 5000).unref?.();
  }, budgetMs + options.killGraceSeconds * 1000);
  ceiling.unref?.();

  /** The events of the run, until a terminal one: the stream, reopened where it dropped; then the status endpoint when the stream will not stay. */
  async function* terminalAware(): AsyncGenerator<{ kind: 'event'; event: Record<string, unknown> } | { kind: 'end'; terminal: Terminal | null }> {
    let lastSeq = -1;
    let delivered = 0; // frames handed on so far: a stream that carries no `seq` is replayed from its start, and these are skipped
    for (let reopen = 0; reopen <= MAX_STREAM_REOPENS && !abort.signal.aborted; reopen += 1) {
      try {
        const res = await doFetch(`${base}/runs/${encodeURIComponent(remoteId)}/events${lastSeq >= 0 ? `?last_seq=${lastSeq}` : ''}`, {
          redirect: 'error',
          headers: { ...headers, accept: 'text/event-stream', ...(lastSeq >= 0 ? { 'last-event-id': String(lastSeq) } : {}) },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => undefined);
          break;
        }
        let skip = lastSeq >= 0 ? 0 : delivered;
        for await (const event of sseFrames(res.body)) {
          if (skip > 0) {
            skip -= 1;
            continue;
          }
          if (typeof event['seq'] === 'number') lastSeq = event['seq'];
          delivered += 1;
          yield { kind: 'event', event };
          const name = String(event['event'] ?? '');
          if (/^run\.(completed|failed|cancelled|interrupted)$/.test(name)) {
            yield { kind: 'end', terminal: { event: name, fields: event } };
            return;
          }
        }
      } catch (err) {
        if (err instanceof GatewayResponseTooLarge) {
          await stop();
          yield { kind: 'end', terminal: { event: 'run.failed', fields: { error: err.message, own: true } } };
          return;
        }
        if (abort.signal.aborted) break;
      }
      await sleep(Math.min(1000, retryUnitMs));
    }
    // The stream would not stay: ask for the run's status until it says how it ended.
    while (!abort.signal.aborted) {
      try {
        const res = await call(`/runs/${encodeURIComponent(remoteId)}`, {}, 10_000);
        if (res.ok) {
          const status = (await readLimitedJson(res).catch(() => null)) as Record<string, unknown> | null;
          const name = typeof status?.['status'] === 'string' ? status['status'] : '';
          if (name === 'completed' || name === 'failed' || name === 'cancelled' || name === 'interrupted') {
            yield { kind: 'end', terminal: { event: `run.${name}`, fields: status ?? {} } };
            return;
          }
        } else {
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 404) break;
        }
      } catch {
        /* the gateway is down for now; the ceiling decides when to stop asking */
      }
      await sleep(POLL_MS * (retryUnitMs / 1000));
    }
    yield { kind: 'end', terminal: null };
  }

  async function* events(): AsyncGenerator<BotRuntimeEvent> {
    const deltas: string[] = [];
    const tools = new Map<string, number>();
    let terminal: Terminal | null = null;
    let retried = false;
    try {
      for (;;) {
      for await (const item of terminalAware()) {
        if (item.kind === 'end') {
          terminal = item.terminal;
          break;
        }
        const event = item.event;
        const name = String(event['event'] ?? '');
        if (name === 'message.delta' && typeof event['delta'] === 'string') {
          deltas.push(event['delta']);
          yield { type: 'text', text: event['delta'] };
        } else if (name === 'tool.started') {
          const tool = String(event['tool'] ?? 'tool');
          tools.set(tool, (tools.get(tool) ?? 0) + 1);
          yield { type: 'tool', name: tool, input: event['preview'] ?? null };
        } else if (name === 'tool.completed') {
          const failed = event['error'] === true;
          yield { type: 'tool_result', name: String(event['tool'] ?? 'tool'), ok: !failed, ...(failed ? { reason: 'the tool reported an error' } : {}) };
        }
      }
      // A pod evicted mid-run leaves Hermes' record of that execution as "unknown", and the session of the thread is reused, so every later
      // run of the bot in this thread fails at once with `unknown_execution` (or `revision_conflict`). Before any output, start once more on a
      // fresh session named after this run (a retry of the same platform run reuses it). The thread's own session id is not remembered: the next
      // run of the bot in the thread fails once the same way and is retried the same way, one cheap failed start per run, and no storage is added.
      const stale =
        !retried &&
        deltas.length === 0 &&
        tools.size === 0 &&
        terminal !== null &&
        terminal.event === 'run.failed' &&
        typeof terminal.fields['error'] === 'string' &&
        /unknown_execution|revision_conflict/.test(terminal.fields['error']) &&
        !timedOut &&
        !stopping &&
        !abort.signal.aborted;
      if (!stale) break;
      retried = true;
      const next = await startRemote(JSON.stringify({ ...runBody, session_id: `${String(runBody['session_id'])}:r${runId}` }), `${runId}:fresh`);
      if ('handle' in next) break; // the first failure is reported
      scope.log(`runtime-hermes: run ${runId}: the Hermes session of this thread was stale (unknown_execution); started again on a fresh session`);
      remoteId = next.id;
      terminal = null;
      }
    } finally {
      clearTimeout(ceiling);
    }
    const streamed = deltas.join('').trim();
    finished = terminal !== null && terminal.fields['own'] !== true;
    if (terminal === null) {
      yield {
        type: 'result',
        text: streamed,
        ok: false,
        error: timedOut ? 'the run was stopped at its time limit' : "lost touch with the bot's Hermes before the run ended",
        ...(timedOut ? { failure: 'timeout' as const } : { failure: 'hermes_unreachable' as const }),
        tokens: null,
      };
      return;
    }
    const f = terminal.fields;
    if (terminal.event === 'run.completed') {
      const output = typeof f['output'] === 'string' && f['output'].trim() !== '' ? f['output'] : streamed;
      yield { type: 'result', text: output, ok: true, tokens: tokensOf(f['usage']) };
      return;
    }
    const error =
      terminal.event === 'run.cancelled'
        ? timedOut ? 'the run was stopped at its time limit' : 'the run was stopped'
        : terminal.event === 'run.interrupted'
          ? "the bot's Hermes restarted during the run"
          : f['own'] === true && typeof f['error'] === 'string' ? f['error'] : f['error'] === undefined ? "the run failed on the bot's Hermes" : "the run failed on the bot's Hermes (its message is not repeated)";
    yield {
      type: 'result',
      text: streamed,
      ok: false,
      error,
      ...(timedOut ? { failure: 'timeout' as const } : terminal.event === 'run.interrupted' ? { failure: 'hermes_unreachable' as const } : {}),
      tokens: tokensOf(f['usage']),
    };
  }

  return {
    stop: async () => {
      clearTimeout(ceiling);
      await stop();
    },
    events: events(),
  };
}
