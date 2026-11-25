import { createHash, randomUUID } from 'node:crypto';
import { resolve as resolvePath } from 'node:path';
import { client as createClient, methods, RequestError } from '@agentclientprotocol/sdk';
import type { DriverJob, DriverResult, Usage } from '../drivers/types.ts';
import { MCP_SERVER_NAME } from '../drivers/claude-code.ts';
import { cgroupMemoryWatch } from '../memory-watch.ts';
import { lastLine } from '../process.ts';
import { CLAUDE_FULL_ACCESS_MODE, FULL_ACCESS_NOT_OFFERED } from '../full-access.ts';
import { adapterCommand, adapterEnv, desiredMode, flavorOf, hermesGrantProblem, mcpServers, OPENCODE_REFUSAL, optionFor, sessionMeta, sessionOption, wantedOptions, type PermissionOption } from './adapter.ts';
import { approvalOf, clipText, Frames, KIND_WORDS, mcpServerOf, viewOf } from './frames.ts';

// One run on an ACP adapter (P25-03, docs/plans/acp.md §2): start the adapter process, `initialize`, open the thread's session (resume, else load, else new, as measured
// per adapter), put it in the mode the bot's grants need, send ONE prompt, fold the updates into frames, answer permission requests through the P24 card, and end the
// process. The agent works in the profile's folder with its own tools; the bridge advertises no `fs` and no `terminal`.

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
type UsageFields = Record<string, unknown>;
const usageOf = (v: unknown): UsageFields | null => (isRecord(v) ? v : null);
/** The token counts of two turns added, so a run that was continued reports what all of its turns used. */
const addUsage = (a: UsageFields | null, b: UsageFields | null): UsageFields | null => {
  if (a === null || b === null) return a ?? b;
  const out: UsageFields = { ...a };
  for (const key of ['inputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'outputTokens']) out[key] = num(a[key]) + num(b[key]);
  return out;
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
/** Lets the notifications still in the SDK's queue arrive before the next step (a replay before the prompt, the last updates after it). */
const drain = async (): Promise<void> => {
  await tick();
  await tick();
};

/** Hermes denies a request nobody answered after its own `approvals.timeout` (default 300 s); the bridge gives up first, so it can say so. */
export const HERMES_APPROVAL_CAP_SECONDS = 290;
export const approvalWaitFor = (flavor: string, configuredSeconds: number): number => (flavor === 'hermes' ? Math.min(configuredSeconds, HERMES_APPROVAL_CAP_SECONDS) : configuredSeconds);

/**
 * Codex ends its turn after one step of a long job and the run would end there, the card neither handed off nor completed (P25-16, P26-07). A run of a Codex bot that
 * worked on a card (it called a `tasks` tool of the platform) and ended a turn with no hand-off, completion, post or question gets one more prompt, up to three in all,
 * while the run has at least this much of its budget left.
 */
export const MAX_CONTINUES = 3;
export const CONTINUE_MIN_BUDGET_MS = 120_000;
/** What the agent says to end the extra turn when there is nothing left to do; it is removed from the run's answer. */
export const CONTINUE_DONE = 'ALL DONE';
export const CONTINUE_PROMPT = `You ended your turn, but this card has not been handed off or completed yet. Carry on from where you stopped: finish the step you are on, run a long command in this same turn and check it until it ends (never leave it in the background), then hand the card off (tasks.handoff), complete it (tasks.complete), or post the result (messages.post). If everything is already done, reply with the single line ${CONTINUE_DONE}.`;

/**
 * The answer without the closing `ALL DONE` of the extra turns (the agent's own words before it stay). Each extra turn may say it, and the adapters join two turns'
 * text with nothing between, so the end can read "ALL DONEALL DONE" (seen 2026-11-21): every closing mark goes.
 */
export function withoutDoneMark(answer: string): string {
  let text = answer.trimEnd();
  for (;;) {
    const bare = text.endsWith('.') ? text.slice(0, -1) : text;
    if (!bare.endsWith(CONTINUE_DONE)) return text;
    text = bare.slice(0, -CONTINUE_DONE.length).trimEnd();
  }
}

/** The platform's tools that end a bot's part of the work: a hand-off, a completion, a post, a question to a person. */
const ENDING_TOOLS = new Set(['tasks_handoff', 'tasks_complete', 'messages_post', 'approvals_ask']);
const platformTool = (tool: string): string | null => {
  const m = /^mcp__manythreads__(.+)$/.exec(tool);
  return m ? m[1]!.replaceAll('.', '_') : null;
};
/** True when the agent worked on a card (called a `tasks` tool of the platform) and has not ended it with a hand-off, completion, post or question. */
export function endedEarly(mcpTools: Iterable<string>): boolean {
  let onCard = false;
  for (const tool of mcpTools) {
    const name = platformTool(tool);
    if (name === null) continue;
    if (ENDING_TOOLS.has(name)) return false;
    if (name.startsWith('tasks_')) onCard = true;
  }
  return onCard;
}

class AdapterExit extends Error {
  constructor(readonly code: number | null, readonly signal: string | null, readonly stderrTail: string, readonly spawnError: string | null) {
    super('the adapter ended');
  }
}

/** The thread's ACP session id is kept under this key (`sessions.json`), apart from the CLI drivers' keys. */
export function acpSessionKey(job: Pick<DriverJob, 'profileName' | 'profile' | 'request'>): string {
  return `acp:${job.profile.agent}:${createHash('sha1').update(`${job.profileName}\0${job.request.sessionId ?? ''}`).digest('hex')}`;
}

/**
 * A session the adapter no longer has, and nothing else. Measured: Claude answers -32002 "Resource not found", Codex -32603 with `data.details` "no rollout found for
 * thread id"; Hermes answers success (see `isFound`). Any other failure of a resume (a model that is not there, a refused folder) is not a lost session: the run fails
 * and the thread keeps its session for the next try.
 */
export function isMissingSession(err: unknown): boolean {
  if (!(err instanceof RequestError)) return false;
  if (err.code === -32002) return /resource not found/i.test(err.message);
  if (err.code !== -32603) return false;
  const details = isRecord(err.data) && typeof err.data['details'] === 'string' ? err.data['details'] : '';
  return /no rollout found/i.test(details);
}

/** Hermes answers success for an unknown id; a session that exists carries `_meta.hermes.sessionProvenance`. Others: an answer is a found session. */
export function isFound(flavor: string, answer: unknown): boolean {
  if (flavor !== 'hermes') return true;
  const meta = isRecord(answer) && isRecord(answer['_meta']) ? answer['_meta'] : {};
  return isRecord(meta['hermes']) && isRecord(meta['hermes']['sessionProvenance']);
}

interface Pending {
  id: string;
  /** What the person was asked about (the step's title), kept so a run that ends after a No can say which step it was. */
  title: string;
  options: readonly PermissionOption[];
  settle(outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }): void;
}

function errorText(err: unknown, secrets: readonly string[]): string {
  if (err instanceof RequestError) {
    const details = isRecord(err.data) && typeof err.data['details'] === 'string' ? ` ${err.data['details']}` : '';
    return clipText(`${err.message}${details}`, 300, secrets);
  }
  return clipText(err instanceof Error ? err.message : String(err), 300, secrets);
}

export async function runAcp(job: DriverJob): Promise<DriverResult> {
  const token = job.request.manythreads.mcp?.token ?? null;
  const secrets = token === null ? [] : [token];
  const flavor = flavorOf(job.profile.agent);
  // The adapters that cannot be held to the bot's grants are refused before any process starts.
  if (flavor === 'opencode') return { ok: false, error: OPENCODE_REFUSAL };
  if (flavor === 'hermes') {
    const problem = hermesGrantProblem(job);
    if (problem !== null) return { ok: false, error: problem };
  }
  const cwd = resolvePath(job.profile.workdir);
  const mode = desiredMode(job);
  const { command, args } = adapterCommand(job.profile);
  // The bridge's own control group tells a command the kernel killed for memory (P31-04); none on macOS, Windows or cgroup v1.
  const frames = new Frames({ cwd, secrets, emit: (event, fields) => job.emit(event, fields), memory: cgroupMemoryWatch() });

  // The adapter's stdio as an ACP stream: lines in, lines out. The adapter is started like any bridge child (its own process group, killed with the run).
  let inbound!: ReadableStreamDefaultController<never>;
  const readable = new ReadableStream<never>({
    start(c) {
      inbound = c;
    },
  });
  let readableOpen = true;
  const closeInbound = (): void => {
    if (!readableOpen) return;
    readableOpen = false;
    try {
      inbound.close();
    } catch {
      /* already closed */
    }
  };
  const child = job.start(command, args, {
    cwd,
    env: adapterEnv(job, mode),
    stdin: null,
    onLine: (line) => {
      const t = line.trim();
      if (t === '' || t[0] !== '{' || !readableOpen) return;
      try {
        (inbound as unknown as ReadableStreamDefaultController<unknown>).enqueue(JSON.parse(t));
      } catch {
        /* a line that is not JSON (an adapter's log line on stdout) carries nothing we read */
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
    throw new AdapterExit(end.code, end.signal, end.stderrTail, end.spawnError);
  });
  gone.catch(() => undefined);
  /** A request that also fails when the adapter ends under it (the SDK would wait for ever). */
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, gone]);

  let sessionId: string | null = null;
  let accepting = false;
  let promptRunning = false;
  let stopping = false;
  let steering = false;
  let turnLimitHit = false;
  const maxTurns = job.request.manythreads.maxTurns;
  const pending = new Map<string, Pending>();
  let permissionCounter = 0;
  // The step of the latest question that was refused (a person's No, or no answer in time), or null once a later question was allowed. A run that ends not done right
  // after a refusal is marked `denied` (P26-02): the agent stopped because of the No, and the platform says so in the person's words.
  let refusedStep: string | null = null;

  const answerAll = (): void => {
    for (const p of [...pending.values()]) p.settle({ outcome: 'cancelled' });
  };

  const handlePermission = async (params: { toolCall: unknown; options: PermissionOption[]; _meta?: unknown }): Promise<{ outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }> => {
    const options = params.options;
    const view = viewOf(params.toolCall, { cwd, secrets });
    // Codex puts the flag on the request itself (beside `toolCall`), not in the tool call (measured).
    const meta = isRecord(params._meta) ? params._meta : {};
    if (stopping) return { outcome: { outcome: 'cancelled' } };
    // Codex asks before every MCP call. The platform's own tools are covered by the bot's grants (the platform checks each call), so they are answered at once.
    const known = view === null ? undefined : frames.step(view.id);
    if (flavor === 'codex' && meta['is_mcp_tool_approval'] === true && known?.mcp === true && mcpServerOf(known.tool) === MCP_SERVER_NAME) {
      const o = sessionOption(options);
      if (o) return { outcome: { outcome: 'selected', optionId: o.optionId } };
    }
    const once = optionFor(options, 'once');
    const deny = optionFor(options, 'deny');
    const requestId = `perm-${++permissionCounter}-${randomUUID().slice(0, 8)}`;
    const kind = known?.kind ?? view?.kind ?? 'other';
    // What the person is shown is what will run (the command, the plan), not the step's one-line title.
    const shown = approvalOf(params.toolCall, { cwd, secrets });
    const title = shown.label ?? known?.title ?? view?.title ?? KIND_WORDS[kind];
    const paths = known?.paths.length ? known.paths : (view?.paths ?? []);
    const diff = known?.diff ?? view?.diff ?? null;
    frames.settle();
    job.emit('approval.request', {
      request_id: requestId,
      command: shown.text !== '' ? shown.text : title,
      title,
      description: KIND_WORDS[kind],
      choices: [...(once ? ['once'] : []), ...(deny || !once ? ['deny'] : [])],
      kind,
      paths,
      ...(diff !== null ? { diff } : {}),
      ...(view !== null && frames.step(view.id) ? { step_id: view.id } : {}),
      // Hermes and Claude answer a note through steering only where they advertise it; the card hides its note box otherwise.
      note_ok: steering,
    });
    const release = job.holdBudget();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Silence is not consent: the request is refused, and the person is told it ran out.
        job.emit('approval.expired', { request_id: requestId, message: 'Nobody answered in time, so the request was refused.' });
        refusedStep = title;
        entry.settle(deny ? { outcome: 'selected', optionId: deny.optionId } : { outcome: 'cancelled' });
      }, approvalWaitFor(flavor, job.config.approvalWaitSeconds) * 1000);
      timer.unref();
      const entry: Pending = {
        id: requestId,
        title,
        options,
        settle: (outcome) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer);
          release();
          resolve({ outcome });
        },
      };
      pending.set(requestId, entry);
    });
  };

  job.onApproval((requestId, choice) => {
    const entry = requestId === null ? pending.values().next().value : pending.get(requestId);
    if (!entry) return false;
    // "Always" is never granted: a session answer is one "Yes", and a standing rule belongs in the BOT.md.
    const o = optionFor(entry.options, choice === 'deny' ? 'deny' : 'once');
    refusedStep = choice === 'deny' ? entry.title : null;
    entry.settle(o ? { outcome: 'selected', optionId: o.optionId } : { outcome: 'cancelled' });
    return true;
  });

  const app = createClient({ name: 'manythreads-bridge' })
    .onNotification(methods.client.session.update, ({ params }) => {
      if (!accepting || params.sessionId !== sessionId) return;
      frames.update(params.update);
      // The CLI driver counts the model's replies against `maxTurns`; this is the same count over the steps and the text (Frames.turns).
      if (maxTurns !== null && !turnLimitHit && frames.turns > maxTurns) {
        turnLimitHit = true;
        job.abort('turn limit exceeded');
      }
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => handlePermission(params as unknown as { toolCall: unknown; options: PermissionOption[]; _meta?: unknown }))
    // Questions with choices are asked through `approvals.ask`, the one way (plan §4.2): a form from the agent is declined.
    .onRequest(methods.client.elicitation.create, () => ({ action: 'cancel' as const }))
    .onNotification('*', () => undefined);
  const connection = app.connect({ readable, writable } as never);
  const agent = connection.agent;

  /** Ends the adapter and everything it started. */
  const shutdown = async (): Promise<void> => {
    connection.close();
    child.endInput();
    child.signal('SIGTERM');
    const kill = setTimeout(() => child.signal('SIGKILL'), Math.max(1, job.config.killGraceSeconds) * 1000);
    kill.unref();
    await Promise.race([exited, sleep(Math.max(1, job.config.killGraceSeconds) * 1000 + 500)]);
    clearTimeout(kill);
  };

  const stopRun = (): void => {
    if (stopping) return;
    stopping = true;
    answerAll();
    if (sessionId !== null && promptRunning) void agent.notify('session/cancel', { sessionId }).catch(() => undefined);
    // Not ended 10 s later: the whole process group goes (as the CLI drivers' stop does).
    const timer = setTimeout(() => child.signal('SIGTERM'), job.config.cancelGraceSeconds * 1000);
    timer.unref();
    void exited.then(() => clearTimeout(timer));
    if (sessionId === null || !promptRunning) child.signal('SIGTERM');
  };
  job.onStop(stopRun, job.config.cancelGraceSeconds);
  if (job.stopped()) stopRun();

  try {
    const initialized = await race(
      agent.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'manythreads-bridge', version: '1' } }),
    );
    const init = initialized as unknown as Record<string, unknown>;
    const caps = isRecord(init['agentCapabilities']) ? init['agentCapabilities'] : {};
    const sessionCaps = isRecord(caps['sessionCapabilities']) ? caps['sessionCapabilities'] : {};
    const initMeta = isRecord(init['_meta']) ? init['_meta'] : {};
    const capsMeta = isRecord(caps['_meta']) ? caps['_meta'] : {};
    steering = [initMeta, capsMeta].some((m) => isRecord(m['steering']) && m['steering']['supported'] === true);
    const mcpCaps = isRecord(caps['mcpCapabilities']) ? caps['mcpCapabilities'] : null;
    const servers = mcpServers(job);
    // Hermes advertises no `mcpCapabilities` and takes an HTTP server with its header anyway (measured); an adapter that says it cannot is not given the token.
    if (servers.length > 0 && mcpCaps !== null && mcpCaps['http'] !== true) return { ok: false, error: "This agent's adapter cannot take the platform's tools over HTTP." };

    const meta = sessionMeta(job);
    const base = { cwd, mcpServers: servers, ...(meta !== undefined ? { _meta: meta } : {}) };
    const key = acpSessionKey(job);
    const known = job.request.sessionId === null ? undefined : job.sessions.get(key);
    let opened: Record<string, unknown> | null = null;
    if (known !== undefined) {
      // Updates are not accepted until the prompt is sent, so what a load or a Hermes resume replays is dropped.
      const method = isRecord(sessionCaps['resume']) ? 'session/resume' : caps['loadSession'] === true ? 'session/load' : null;
      let lost = false;
      if (method !== null) {
        try {
          const answer = await race(agent.request(method, { sessionId: known, ...base } as never));
          if (isFound(flavor, answer)) {
            sessionId = known;
            opened = isRecord(answer) ? (answer as Record<string, unknown>) : {};
          } else lost = true;
        } catch (err) {
          // Only "that session does not exist" starts a new one; any other failure fails the run and the thread keeps its session.
          if (err instanceof AdapterExit || !isMissingSession(err)) throw err;
          lost = true;
        }
        // The replay of a load (or a Hermes resume) may still be in the SDK's queue: it must arrive before updates are accepted.
        await drain();
      }
      if (lost) job.sessions.delete(key);
    }
    if (sessionId === null) {
      const answer = (await race(agent.request('session/new', base as never))) as unknown as Record<string, unknown>;
      if (typeof answer['sessionId'] !== 'string' || answer['sessionId'] === '') return { ok: false, error: 'The agent did not open a session.' };
      sessionId = answer['sessionId'];
      opened = answer;
    }
    if (job.request.sessionId !== null) job.sessions.set(key, sessionId);

    // The mode is the grant (measured): Claude starts in `auto`, Codex in "Auto review".
    const modes = isRecord(opened?.['modes']) ? opened['modes'] : null;
    const configOptions = Array.isArray(opened?.['configOptions']) ? (opened['configOptions'] as unknown[]) : null;
    if (mode !== null) {
      const available = modes !== null && Array.isArray(modes['availableModes']) ? (modes['availableModes'] as unknown[]).map((m) => (isRecord(m) ? m['id'] : null)) : null;
      // The guard for full access too (P35-01): claude-agent-acp leaves `bypassPermissions` out when it runs as root without IS_SANDBOX, which the bridge never sets. The run fails with
      // its reason rather than quietly asking about every command.
      if (available !== null && !available.includes(mode)) {
        if (mode === CLAUDE_FULL_ACCESS_MODE) return { ok: false, error: FULL_ACCESS_NOT_OFFERED };
        return { ok: false, error: `This agent has no "${mode}" mode, so its tools cannot be limited to what the bot may do.` };
      }
      if (modes === null || modes['currentModeId'] !== mode) {
        try {
          await race(agent.request('session/set_mode', { sessionId, modeId: mode }));
        } catch (err) {
          if (err instanceof AdapterExit) throw err;
          try {
            await race(agent.request('session/set_config_option', { sessionId, configId: 'mode', value: mode } as never));
          } catch (err2) {
            if (err2 instanceof AdapterExit) throw err2;
            return { ok: false, error: `Could not put the agent in "${mode}" mode (${errorText(err2, secrets)}).` };
          }
        }
      }
    }
    const optionIds = configOptions === null ? null : configOptions.map((o) => (isRecord(o) ? o['id'] : null));
    for (const want of wantedOptions(job)) {
      const what = want.configId === 'model' ? 'model' : 'effort';
      if (optionIds !== null && !optionIds.includes(want.configId)) {
        if (want.pinned) return { ok: false, error: `This agent does not let its ${what} be chosen, but the profile pins "${clipText(want.value, 60, secrets)}".` };
        job.log(`acp: the agent offers no "${want.configId}" option; the run keeps its own ${what}`);
        continue;
      }
      try {
        await race(agent.request('session/set_config_option', { sessionId, configId: want.configId, value: want.value } as never));
      } catch (err) {
        if (err instanceof AdapterExit) throw err;
        if (want.pinned) return { ok: false, error: `The agent did not take the ${what} "${clipText(want.value, 60, secrets)}" that the profile pins (${errorText(err, secrets)}).` };
        job.log(`acp: the agent did not take ${want.configId} "${clipText(want.value, 40, secrets)}": ${errorText(err, secrets)}; the run keeps its own ${what}`);
      }
    }

    job.onSteer(async (text) => {
      if (!steering || sessionId === null || !promptRunning) return false;
      try {
        await race(agent.request('_session/steering', { sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } }));
        return true;
      } catch {
        return false;
      }
    });

    if (stopping || job.stopped()) {
      await shutdown();
      return { ok: false, error: 'stopped' };
    }
    const instructions = job.request.instructions;
    // The instructions travel with the prompt: no adapter takes them the same way (not measured), and the server sends them on every run so an edit reaches old threads too.
    const text = instructions === null ? job.request.input : `${instructions}\n\n---\n\n${job.request.input}`;
    accepting = true;
    const sendPrompt = async (body: string): Promise<Record<string, unknown>> => {
      promptRunning = true;
      try {
        return (await race(agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: body }] }))) as unknown as Record<string, unknown>;
      } finally {
        promptRunning = false;
      }
    };
    let answer = await sendPrompt(text);
    let stopReason = typeof answer['stopReason'] === 'string' ? answer['stopReason'] : 'end_turn';
    // A Codex turn that ended early is followed by one "continue" (P26-07). Each turn's last updates are taken first, so the platform's calls of that turn are all seen.
    let continues = 0;
    let usageSoFar = usageOf(answer['usage']);
    while (flavor === 'codex' && stopReason === 'end_turn' && refusedStep === null && continues < MAX_CONTINUES && !stopping && !job.stopped() && job.budgetLeftMs() >= CONTINUE_MIN_BUDGET_MS) {
      await drain();
      if (!endedEarly(frames.mcpTools)) break;
      frames.settle();
      continues += 1;
      job.log(`acp: codex ended a turn before the card was handed off or completed; asking it to continue (${continues} of ${MAX_CONTINUES})`);
      answer = await sendPrompt(CONTINUE_PROMPT);
      stopReason = typeof answer['stopReason'] === 'string' ? answer['stopReason'] : 'end_turn';
      usageSoFar = addUsage(usageSoFar, usageOf(answer['usage']));
    }
    if (continues > 0) job.log(`acp: codex run continued ${continues} time(s)`);
    // The updates that came before the answer may still be in the SDK's queue: they are taken first, and only then are updates no longer accepted.
    await drain();
    accepting = false;
    answerAll(); // a question still open when the turn ended is over
    frames.finish(stopReason === 'cancelled');
    if (stopping) {
      // Codex ends a prompt `cancelled` in 15 ms and leaves its command running (measured): the process group is ended after a cancel, always.
      await shutdown();
      return { ok: false, error: 'stopped' };
    }
    await shutdown();
    // Codex ends its turn `cancelled` after a No (MISTAKES P25-16): the run is marked `denied` and keeps the step's title, so the thread can say whose No it was.
    if (refusedStep !== null && stopReason !== 'end_turn') return { ok: false, error: 'The agent stopped after a request was refused.', extra: { reason: 'denied', step: refusedStep } };
    if (stopReason === 'refusal') return { ok: false, error: 'The agent refused the request.' };
    if (stopReason === 'cancelled') return { ok: false, error: 'The agent ended the turn before it was done.' };
    const u = usageSoFar;
    const cost = frames.cost();
    let usage: Usage | null = null;
    if (u !== null) {
      const input = num(u['inputTokens']) + num(u['cachedReadTokens']) + num(u['cachedWriteTokens']);
      const output = num(u['outputTokens']);
      usage = { input_tokens: input, output_tokens: output, total_tokens: input + output, ...(cost !== null ? { cost: cost.amount } : {}) };
    } else if (cost !== null) usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cost: cost.amount };
    const output = continues > 0 ? withoutDoneMark(frames.answer()) : frames.answer();
    return { ok: true, output, usage, extra: { stop_reason: stopReason, ...(continues > 0 ? { continues } : {}), ...(cost !== null ? { cost } : {}) } };
  } catch (caught) {
    let err: unknown = caught;
    accepting = false;
    frames.finish(stopping, !stopping);
    answerAll();
    await shutdown();
    // The SDK fails a waiting request with "connection closed" when the adapter's output ends, which can come before the process's own end: the end is the better word.
    if (!(err instanceof AdapterExit) && /connection closed/i.test(err instanceof Error ? err.message : '')) {
      const end = await Promise.race([exited, sleep(1000)]);
      if (end) err = new AdapterExit(end.code, end.signal, end.stderrTail, end.spawnError);
    }
    if (err instanceof AdapterExit) {
      if (err.spawnError !== null) return { ok: false, error: `could not start "${command}" (${err.spawnError})` };
      const why = lastLine(err.stderrTail, secrets);
      return { ok: false, error: why !== '' ? why : `The agent's adapter ended (${String(err.code ?? err.signal)}).` };
    }
    return { ok: false, error: errorText(err, secrets) };
  }
}
