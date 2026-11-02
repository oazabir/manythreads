import type {
  BotRuntimeEvent,
  BotRuntimeHandle,
  BotRuntimeInput,
  BotRuntimeProvider,
  BotRuntimeScope,
  ModelMessage,
  ModelToolSpec,
  PluginContext,
} from '@manythreads/sdk';
import { RunEndedError } from '@manythreads/sdk';
import { resolveRunner } from './resolve.ts';

// The `model` bot runtime (PLAN P19-10): how a bot placed (`placement.runs_on`) on an LLM gateway runner is answered. There is no Hermes and no process. The runtime asks the runner's model
// alias a question through the platform's own gateway, one turn at a time; when the model asks for a tool it is called through the same door the MCP gateway uses (so the bot's grants,
// approvals, the data-loss check and the source log apply to a tool call exactly as they do to a Hermes bot's), and the answer goes back to the model. The turn that ends without a tool call is
// the reply, and the run job posts it like any other run's reply.
//
// What it does not have: a shell, files or a browser. A bot that asks for any of them cannot be placed on this kind of runner (the bot loader refuses it, and the Runs on picker says why).
// Every failure is a result the run job turns into the one plain notice in the thread; nothing the model gateway said is repeated.
//
// The run job makes the model call and the tool call (`scope.model`, `scope.tools`): a runtime never touches the database, and the pre-call guard, the budgets, the rate limits and the
// spend ledger all stay inside the gateway. This file is the loop.

export const MODEL_RUNTIME_ID = 'model';

/** Model turns one run may take when the bot's definition sets no limit: each turn may call tools, so this bounds the loop. */
export const DEFAULT_STEP_LIMIT = 12;

/** The run's wall clock when the definition sets none (the same default a Hermes run has). */
const DEFAULT_RUN_BUDGET_SECONDS = 600;

/** The most one model turn may write, in tokens. */
const MAX_TOKENS_PER_TURN = 2048;

/** A tool answer longer than this is cut before the model reads it: a page or a file does not belong whole in the next turn. */
export const MAX_TOOL_ANSWER_CHARS = 20_000;

/** Tools one step may run (the model may ask for many at once), and tools one run may run in all. The rest of a step's calls are answered "too many" and not run. */
export const MAX_TOOL_CALLS_PER_TURN = 8;
export const MAX_TOOL_CALLS_PER_RUN = 40;

/** A tool name as it goes into an event: the model chose it, so control characters and length are not trusted. */
const cleanName = (name: string): string =>
  [...name]
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .slice(0, 100);

/**
 * Wait for `work`, but no longer than `ms` and not past a stop. A call that never answers cannot hold the run: the race ends, the run fails with its time limit, and the late answer (if it
 * ever comes) is dropped. The work itself cannot be cancelled from here, so its own failure is swallowed once the race is over.
 */
async function within<T>(work: Promise<T>, ms: number, stop: Promise<'stopped'>): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), Math.max(0, ms));
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work.then((value) => ({ done: true as const, value })), late, stop.then(() => ({ done: false as const }))]);
  } finally {
    clearTimeout(timer);
  }
}

const failed = (error: string, extra: Partial<Extract<BotRuntimeEvent, { type: 'result' }>> = {}): BotRuntimeEvent => ({ type: 'result', text: '', ok: false, error, tokens: null, ...extra });

const asHandle = (events: AsyncGenerator<BotRuntimeEvent>, stop: () => void): BotRuntimeHandle => ({ stop: async () => stop(), events });

/** What a model wrote as the arguments of a tool call, as an object; null when it is not one. */
function argumentsOf(text: string): Record<string, unknown> | null {
  if (text.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The names a model provider accepts for a tool are letters, digits, underscore and hyphen (a capability such as `memory.recall` has a dot). The model is offered the wire name; this table
 * answers which capability a wire name stands for, so the call goes to the real tool. Two names that collapse to one wire name get a number, so the table never loses a tool.
 */
export function wireNames(tools: ReadonlyArray<ModelToolSpec>): { offered: ModelToolSpec[]; real: Map<string, string> } {
  const real = new Map<string, string>();
  const offered: ModelToolSpec[] = [];
  for (const tool of tools) {
    const base = tool.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'tool';
    let wire = base;
    for (let n = 2; real.has(wire); n += 1) wire = `${base}_${String(n)}`;
    real.set(wire, tool.name);
    offered.push({ ...tool, name: wire });
  }
  return { offered, real };
}

const toolAnswer = (ok: boolean, code: string, message: string): string => JSON.stringify({ ok, code, message });

export function createModelRuntime(ctx: PluginContext): BotRuntimeProvider {
  return {
    id: MODEL_RUNTIME_ID,
    // The question goes to a model, so the bot's gate (BOT.md `guard.gate`) is asked first. The gateway's own pre-call check runs inside every turn, so `usesGateway` stays off: the run
    // job's one up-front check is for runtimes that hand a model the gateway's address and a key.
    gated: true,

    render: (input: BotRuntimeInput) => ({
      home: `${input.bot.slug}-${input.endpoint?.runId ?? 'no-run'}`,
      files: { 'SOUL.md': systemTextOf(input) },
    }),

    async run(input: BotRuntimeInput, scope: BotRuntimeScope): Promise<BotRuntimeHandle> {
      let stopped = false;
      // Resolves when the run is stopped, so a model call or a tool that never answers cannot hold the run (and the bot's one-run-at-a-time lock) past a stop or its time budget.
      let signalStop!: () => void;
      const stopSignal = new Promise<'stopped'>((resolve) => {
        signalStop = () => resolve('stopped');
      });
      const events = (async function* run(): AsyncGenerator<BotRuntimeEvent> {
        const runner = input.definition.frontmatter.placement?.runs_on;
        if (runner === undefined) {
          yield failed('this bot is not placed on an LLM gateway runner');
          return;
        }
        // The runner is judged first, in the catalog's own words: switched off, not open to the team, not ready, or gone.
        const answer = await resolveRunner(ctx, { teamId: input.bot.teamId, runner });
        if (!answer.ok) {
          yield failed(answer.message, { failure: 'runner_refused', refusal: { runner, reason: answer.reason, line: answer.message } });
          return;
        }
        const alias = answer.target.modelAlias;
        if (answer.target.kind !== 'llm_gateway' || alias === null) {
          yield failed(`${answer.target.label} is not an LLM gateway runner`, { failure: 'runner_refused', refusal: { runner, reason: 'not_runnable', line: `This bot runs on ${answer.target.label}, which cannot run bots yet.` } });
          return;
        }
        if (!scope.model) {
          yield failed('the model gateway is not available on this server', { failure: 'gateway' });
          return;
        }
        const model = scope.model;

        const stepLimit = input.limits.maxTurns ?? DEFAULT_STEP_LIMIT;
        const startedAt = Date.now();
        const budgetMs = (input.limits.runBudgetSeconds ?? DEFAULT_RUN_BUDGET_SECONDS) * 1000;
        const left = (): number => budgetMs - (Date.now() - startedAt);
        const { offered: tools, real: realName } = wireNames(scope.tools ? await scope.tools.list() : []);
        // The history the model sees. After every turn it is replaced by the copy the gateway sends back, which has any redaction applied, so a secret is never sent a second time in clear text.
        let messages: ModelMessage[] = [
          { role: 'system', content: systemTextOf(input) },
          { role: 'user', content: input.prompt },
        ];
        let checkedUpTo = 0;
        let toolCallsMade = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        const usage = (): { input: number; output: number; total: number } => ({ input: promptTokens, output: completionTokens, total: promptTokens + completionTokens });
        const timedOut = (): BotRuntimeEvent => failed('the run was stopped at its time limit', { failure: 'timeout', tokens: usage() });

        for (let step = 1; step <= stepLimit; step += 1) {
          if (stopped || left() <= 0) {
            yield timedOut();
            return;
          }
          const raced = await within(model.turn({ alias, messages, tools, maxTokens: MAX_TOKENS_PER_TURN, firstTurn: step === 1, checkedUpTo, timeoutMs: left() }), left(), stopSignal);
          if (!raced.done) {
            yield timedOut();
            return;
          }
          const turn = raced.value;
          if (!turn.ok) {
            scope.log(`runner ${runner}: model turn ${step} ended the run: ${turn.reason}`);
            // The words of the gateway's refusal stay in the log; the asker hears one fixed line for the cause.
            const failure = turn.reason === 'refused' ? 'limit' : turn.reason === 'timeout' ? 'timeout' : 'gateway';
            yield failed(`${turn.reason}: ${turn.detail}`, { failure, tokens: usage() });
            return;
          }
          promptTokens += turn.promptTokens;
          completionTokens += turn.completionTokens;
          messages = turn.messages;
          checkedUpTo = messages.length;
          if (turn.toolCalls.length === 0) {
            const text = (turn.text ?? '').trim();
            if (text === '') {
              yield failed('the model answered with nothing', { tokens: usage() });
              return;
            }
            // An answer cut off at the length limit is not an answer: it is never posted as if it were complete.
            if (turn.truncated) {
              yield failed('the answer was cut off at the length limit', { failure: 'too_long', tokens: usage() });
              return;
            }
            yield { type: 'result', text, ok: true, tokens: usage() };
            return;
          }
          messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
          for (const [index, call] of turn.toolCalls.entries()) {
            const shown = cleanName(realName.get(call.name) ?? call.name);
            const args = argumentsOf(call.arguments);
            yield { type: 'tool', name: shown, input: args };
            // Every call the model made gets an answer (a provider refuses a history with an unanswered call), but only so many are run.
            const answerWith = (code: string, message: string): BotRuntimeEvent => {
              messages.push({ role: 'tool', toolCallId: call.id, content: toolAnswer(false, code, message) });
              return { type: 'tool_result', name: shown, ok: false, reason: code };
            };
            if (args === null) {
              yield answerWith('bad_arguments', 'The arguments of the call were not a JSON object.');
              continue;
            }
            if (!scope.tools) {
              yield answerWith('no_tools', 'No tools are available to this bot.');
              continue;
            }
            const name = realName.get(call.name);
            if (name === undefined) {
              yield answerWith('unknown_tool', 'There is no such tool.');
              continue;
            }
            if (index >= MAX_TOOL_CALLS_PER_TURN) {
              yield answerWith('too_many_calls', `Only ${String(MAX_TOOL_CALLS_PER_TURN)} tools can be called in one step; ask again for the rest.`);
              continue;
            }
            if (toolCallsMade >= MAX_TOOL_CALLS_PER_RUN) {
              yield failed(`the run used all ${String(MAX_TOOL_CALLS_PER_RUN)} of its tool calls`, { failure: 'steps', tokens: usage() });
              return;
            }
            if (stopped || left() <= 0) {
              yield timedOut();
              return;
            }
            toolCallsMade += 1;
            let outcome: { text: string; isError: boolean };
            try {
              const result = await within(scope.tools.call(name, args), left(), stopSignal);
              if (!result.done) {
                yield timedOut();
                return;
              }
              outcome = result.value;
            } catch (err) {
              // A run that has ended is not a tool failure: it ends this loop. Any other throw is the tool's own fault and goes back to the model as that tool's answer.
              if (err instanceof RunEndedError) {
                yield failed('the run ended while a tool was being called', { tokens: usage() });
                return;
              }
              scope.log(`runner ${runner}: tool ${shown} threw: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`);
              yield answerWith('failed', 'The call failed.');
              continue;
            }
            messages.push({ role: 'tool', toolCallId: call.id, content: outcome.text.slice(0, MAX_TOOL_ANSWER_CHARS) });
            yield { type: 'tool_result', name: shown, ok: !outcome.isError, ...(outcome.isError ? { reason: 'refused' } : {}) };
          }
        }
        // The loop used every step and the model still wanted another tool: end it rather than let it run on.
        yield failed(`the run used all ${String(stepLimit)} of its steps`, { failure: 'steps', tokens: usage() });
      })();
      return asHandle(events, () => {
        stopped = true;
        signalStop();
      });
    },
  };
}

/** What the model is told it is: the body of BOT.md, verbatim, or one line naming the bot when the body is empty. */
export function systemTextOf(input: BotRuntimeInput): string {
  const body = input.definition.body.trim();
  return body === '' ? `You are ${input.bot.name}, a bot of a team on manythreads.` : body;
}
