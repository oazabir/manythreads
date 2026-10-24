import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/*
 * fake-hermes-gateway — the part of Hermes v0.21.5's `api_server` platform that manythreads talks to, as a server that is not Hermes.
 *
 * Mirrors what was measured on the real gateway (docs/plugins/runtime-hermes.md, "The gateway wire"):
 *  - a profile is chosen by the URL prefix `/p/<profile>/v1/...`; an unknown profile is 404; each profile has its own bearer key, and
 *    another profile's key is 401;
 *  - `POST /v1/runs` answers 202 `{run_id, status: "started"}`; with an `Idempotency-Key` the same key and body answer 202 again with
 *    `Idempotency-Replayed: true` and the ORIGINAL run id, and the same key with another body is 409 `idempotency_key_conflict`;
 *  - over `max_concurrent_runs` live runs the answer is 429 `rate_limit_exceeded` with `Retry-After: 1`;
 *  - `GET /v1/runs/<id>/events` is a server-sent-event stream of `data: {"event": "...", "run_id", "seq", ...}` frames (the event name is
 *    inside the JSON, there is no `event:` line), with `: keepalive` comments, ending after `run.completed | run.failed | run.cancelled`;
 *    `Last-Event-ID` / `?last_seq=` replays from that point;
 *  - `POST /v1/runs/<id>/stop` cancels a live run;  `GET /v1/runs/<id>` is the pollable status; a run of another profile is 404.
 * What a run DOES is a script a test supplies (`script`): steps that emit tool events, text deltas, wait, or call the profile's MCP server
 * (the way a real profile's model would, through the MCP address and token the test registered for the profile).
 */

export interface FakeHermesProfile {
  apiKey: string;
  /** Where this profile's MCP server (manythreads) is, and the bearer token it sends: what a real profile's `config.yaml` + `.env` hold. */
  mcp?: { url: string; token: string };
}

export type FakeRunStep =
  | { type: 'tool'; name: string; error?: boolean }
  | { type: 'delta'; text: string }
  /** Call a manythreads tool over the profile's MCP server (a JSON-RPC `tools/call`); the answer text goes to `onResult`. */
  | { type: 'mcp'; tool: string; args: Record<string, unknown>; onResult?: (result: { ok: boolean; status: number; body: unknown }) => void }
  | { type: 'wait'; ms: number }
  /** Wait until the run is stopped (or `ms` pass), then end cancelled. */
  | { type: 'hang'; ms?: number }
  | { type: 'finish'; output?: string; usage?: { input_tokens: number; output_tokens: number; total_tokens: number } }
  | { type: 'fail'; error: string };

export type FakeRunScript = (run: FakeHermesRun) => FakeRunStep[] | Promise<FakeRunStep[]>;

export interface FakeHermesRun {
  runId: string;
  profile: string;
  body: Record<string, unknown>;
  idempotencyKey: string | null;
}

export interface FakeHermesCall {
  method: string;
  path: string;
  profile: string | null;
  authorized: boolean;
  idempotencyKey: string | null;
  body: unknown;
}

export interface FakeHermesOptions {
  port?: number;
  profiles: Record<string, FakeHermesProfile>;
  /** What a run does. Default: echo the input as the answer. */
  script?: FakeRunScript;
  /** Live runs allowed at once across profiles (default 10, like Hermes). */
  maxConcurrentRuns?: number;
  /** Send event frames without `seq`/`id` and replay from the start on every connection (a gateway that cannot resume). */
  omitSeq?: boolean;
}

export interface FakeHermesGateway {
  readonly url: string;
  /** Every request in order, including the refused ones. */
  readonly calls: FakeHermesCall[];
  /** Runs started, oldest first. */
  readonly runs: FakeHermesRun[];
  /** Replace what runs do. */
  setScript(script: FakeRunScript): void;
  /** Answer the next `n` run creations with 429. */
  rejectNextRuns(n: number): void;
  /** Drop the next `n` event-stream connections after the first frame (a flaky network). */
  dropNextStreams(n: number): void;
  /** The highest number of runs that were live at once. */
  readonly peakLive: number;
  /** Register or change a profile (the way a controller adds a directory to the real gateway). */
  setProfile(name: string, profile: FakeHermesProfile): void;
  close(): Promise<void>;
}

interface RunState {
  run: FakeHermesRun;
  events: Array<{ seq: number; data: Record<string, unknown> }>;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  output: string;
  usage: unknown;
  error: string | null;
  bodyJson: string;
  stop: () => void;
  subscribers: Set<() => void>;
}

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

const errorBody = (message: string, code: string): { error: { message: string; code: string; type: string } } => ({ error: { message, code, type: 'invalid_request_error' } });

export async function startFakeHermesGateway(options: FakeHermesOptions): Promise<FakeHermesGateway> {
  const profiles = new Map(Object.entries(options.profiles));
  const runs = new Map<string, RunState>();
  const idem = new Map<string, { runId: string; body: string }>();
  const calls: FakeHermesCall[] = [];
  const started: FakeHermesRun[] = [];
  let script: FakeRunScript =
    options.script ?? ((run) => [{ type: 'delta', text: 'echo: ' }, { type: 'finish', output: `echo: ${String(run.body['input'] ?? '')}` }]);
  let rejectRuns = 0;
  let dropStreams = 0;
  let live = 0;
  let peak = 0;
  const maxLive = options.maxConcurrentRuns ?? 10;

  const emitEvent = (state: RunState, name: string, fields: Record<string, unknown> = {}): void => {
    state.events.push({ seq: state.events.length, data: { event: name, run_id: state.run.runId, timestamp: Date.now() / 1000, ...fields } });
    for (const wake of state.subscribers) wake();
  };

  const drive = async (state: RunState): Promise<void> => {
    let cancelled = false;
    let wakeHang: (() => void) | null = null;
    state.stop = () => {
      cancelled = true;
      wakeHang?.();
    };
    const finish = (status: RunState['status'], fields: Record<string, unknown>): void => {
      if (state.status !== 'running') return;
      state.status = status;
      live -= 1;
      emitEvent(state, `run.${status}`, fields);
      for (const wake of state.subscribers) wake();
    };
    try {
      const steps = await script(state.run);
      let deltas = '';
      for (const step of steps) {
        if (cancelled) break;
        if (step.type === 'tool') {
          emitEvent(state, 'tool.started', { tool: step.name, preview: '' });
          emitEvent(state, 'tool.completed', { tool: step.name, duration: 0.01, error: step.error ?? false });
        } else if (step.type === 'delta') {
          deltas += step.text;
          emitEvent(state, 'message.delta', { delta: step.text });
        } else if (step.type === 'wait') {
          await new Promise((r) => setTimeout(r, step.ms));
        } else if (step.type === 'hang') {
          await new Promise<void>((r) => {
            wakeHang = r;
            setTimeout(r, step.ms ?? 60_000);
          });
        } else if (step.type === 'mcp') {
          const mcp = profiles.get(state.run.profile)?.mcp;
          emitEvent(state, 'tool.started', { tool: `mcp__manythreads__${step.tool}`, preview: '' });
          let outcome: { ok: boolean; status: number; body: unknown } = { ok: false, status: 0, body: 'this profile has no MCP server' };
          if (mcp) {
            const r = await fetch(mcp.url, {
              method: 'POST',
              headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: step.tool, arguments: step.args } }),
            });
            const text = await r.text();
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* keep the text */
            }
            const isError = (parsed as { result?: { isError?: boolean } } | null)?.result?.isError === true || (parsed as { error?: unknown } | null)?.error !== undefined;
            outcome = { ok: r.ok && !isError, status: r.status, body: parsed };
          }
          emitEvent(state, 'tool.completed', { tool: `mcp__manythreads__${step.tool}`, duration: 0.01, error: !outcome.ok });
          step.onResult?.(outcome);
        } else if (step.type === 'fail') {
          state.error = step.error;
          finish('failed', { error: step.error });
          return;
        } else if (step.type === 'finish') {
          state.output = step.output ?? deltas;
          state.usage = step.usage ?? { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
          finish('completed', { output: state.output, usage: state.usage, runtime: { provider: 'fake', model: 'fake' } });
          return;
        }
      }
      if (cancelled) finish('cancelled', {});
      else finish('completed', { output: deltas, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
      finish('failed', { error: state.error });
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, errorBody(String(err), 'server_error'));
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake');
    const raw = req.method === 'POST' ? await readBody(req) : '';
    let json: unknown = null;
    try {
      json = raw === '' ? null : JSON.parse(raw);
    } catch {
      json = null;
    }
    const match = /^\/p\/([^/]+)(\/.*)$/.exec(url.pathname);
    const profile = match?.[1] ?? null;
    const path = match?.[2] ?? url.pathname;
    const idempotencyKey = (req.headers['idempotency-key'] as string | undefined) ?? null;
    const auth = req.headers['authorization'];
    const known = profile !== null ? profiles.get(profile) : undefined;
    const authorized = known !== undefined && auth === `Bearer ${known.apiKey}`;
    calls.push({ method: req.method ?? 'GET', path: url.pathname, profile, authorized, idempotencyKey, body: json });

    if (path === '/health') return send(res, 200, { status: 'ok' });
    if (profile === null) return send(res, 404, errorBody('use /p/<profile>/v1/...', 'not_found'));
    if (!known) return send(res, 404, errorBody(`unknown profile ${profile}`, 'profile_not_found'));
    if (!authorized) return send(res, 401, errorBody('Invalid API key', 'invalid_api_key'));

    if (req.method === 'GET' && path === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: profile, object: 'model' }] });
    if (req.method === 'GET' && path === '/v1/capabilities') return send(res, 200, { object: 'hermes.capabilities', platform: 'api_server' });

    if (req.method === 'POST' && path === '/v1/runs') {
      if (rejectRuns > 0 || live >= maxLive) {
        if (rejectRuns > 0) rejectRuns -= 1;
        return send(res, 429, errorBody('too many runs', 'rate_limit_exceeded'), { 'retry-after': '1' });
      }
      const body = (json ?? {}) as Record<string, unknown>;
      if (typeof body['input'] !== 'string' && !Array.isArray(body['input'])) return send(res, 400, errorBody('input is required', 'invalid_request'));
      const bodyJson = JSON.stringify(body);
      const scopedKey = idempotencyKey === null ? null : `${profile}\u0000${idempotencyKey}`;
      if (scopedKey !== null) {
        const earlier = idem.get(scopedKey);
        if (earlier) {
          if (earlier.body !== bodyJson) return send(res, 409, errorBody('same key, different body', 'idempotency_key_conflict'));
          return send(res, 202, { run_id: earlier.runId, status: 'started' }, { 'idempotency-replayed': 'true' });
        }
      }
      const runId = `run_${randomUUID().replaceAll('-', '')}`;
      const run: FakeHermesRun = { runId, profile, body, idempotencyKey };
      const state: RunState = { run, events: [], status: 'running', output: '', usage: null, error: null, bodyJson, stop: () => undefined, subscribers: new Set() };
      runs.set(runId, state);
      started.push(run);
      if (scopedKey !== null) idem.set(scopedKey, { runId, body: bodyJson });
      live += 1;
      peak = Math.max(peak, live);
      void drive(state);
      return send(res, 202, { run_id: runId, status: 'started' });
    }

    const runMatch = /^\/v1\/runs\/([^/]+)(\/events|\/stop)?$/.exec(path);
    if (runMatch) {
      const state = runs.get(runMatch[1]!);
      if (!state || state.run.profile !== profile) return send(res, 404, errorBody(`run not found: ${runMatch[1]}`, 'run_not_found'));
      const tail = runMatch[2];
      if (req.method === 'POST' && tail === '/stop') {
        state.stop();
        return send(res, 200, { object: 'hermes.run.stop', run_id: state.run.runId, status: state.status === 'running' ? 'stopping' : state.status });
      }
      if (req.method === 'GET' && tail === undefined) {
        return send(res, 200, { run_id: state.run.runId, status: state.status, output: state.output, usage: state.usage, error: state.error });
      }
      if (req.method === 'GET' && tail === '/events') return stream(req, res, state, url);
    }
    return send(res, 404, errorBody('not found', 'not_found'));
  }

  async function stream(req: IncomingMessage, res: ServerResponse, state: RunState, url: URL): Promise<void> {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(': open\n\n');
    const rawLast = (req.headers['last-event-id'] as string | undefined) ?? url.searchParams.get('last_seq');
    let sent = !options.omitSeq && rawLast !== null && rawLast !== undefined && Number.isFinite(Number(rawLast)) ? Number(rawLast) + 1 : 0;
    const drop = dropStreams > 0;
    if (drop) dropStreams -= 1;
    let closed = false;
    req.on('close', () => {
      closed = true;
    });
    let wake: (() => void) | null = null;
    const poke = (): void => wake?.();
    state.subscribers.add(poke);
    try {
      for (;;) {
        while (sent < state.events.length) {
          const ev = state.events[sent]!;
          res.write(options.omitSeq ? `data: ${JSON.stringify(ev.data)}\n\n` : `id: ${ev.seq}\ndata: ${JSON.stringify({ ...ev.data, seq: ev.seq })}\n\n`);
          sent += 1;
          if (drop) {
            res.destroy();
            return;
          }
        }
        if (state.status !== 'running' || closed) break;
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 200);
        });
        if (!closed && state.status === 'running' && sent >= state.events.length) res.write(': keepalive\n\n');
      }
      res.write(': stream closed\n\n');
      res.end();
    } finally {
      state.subscribers.delete(poke);
    }
  }

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    runs: started,
    get peakLive() {
      return peak;
    },
    setScript(next) {
      script = next;
    },
    rejectNextRuns(n) {
      rejectRuns = n;
    },
    dropNextStreams(n) {
      dropStreams = n;
    },
    setProfile(name, profile) {
      profiles.set(name, profile);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
