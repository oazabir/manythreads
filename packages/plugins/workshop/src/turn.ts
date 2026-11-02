import type { WorkshopStepOutcome } from '@manythreads/shared';
import { MODEL_FAILURE, type ChatMessage } from './loop.ts';
import type { NewEntry, ToolSpec } from './wtools.ts';

// One turn of a Workshop conversation (PLAN P7-05): ask the model, run the tools it asked for, give it the answers, and go on until it answers in plain words, up to a number of steps. Unlike the
// "Add a bot" loop (loop.ts), a tool does not end the turn: the helper (or the rehearsed bot) finishes by speaking. The model call and the tools are injected, so the tests drive it with a scripted
// model and no database, including a hostile one.

export type TurnModelAnswer =
  | { ok: true; text: string | null; toolCalls: Array<{ id: string; name: string; arguments: string }>; messages: ChatMessage[]; promptTokens: number; completionTokens: number; truncated: boolean }
  | { ok: false; reason: 'refused' | 'unbound' | 'unavailable' | 'timeout' };

export interface TurnToolAnswer {
  /** What the model reads. */
  content: string;
  step: { tool: string; what: string; outcome: WorkshopStepOutcome; badge: string | null };
}

export interface TurnInput {
  /** One model turn over the conversation so far (the platform's system text first). */
  model(input: { messages: ChatMessage[]; checkedUpTo: number; tools: ToolSpec[] }): Promise<TurnModelAnswer>;
  /** Offered to the model; a name outside this list is answered "no such tool" without running anything. */
  tools: ToolSpec[];
  call(name: string, rawArguments: string): Promise<TurnToolAnswer>;
  /** Told when a tool threw, so the server log can say why; the model only reads "did not work". */
  toolFailed?(name: string, err: unknown): void;
  push(entry: NewEntry): void;
  /** Called after every step with the conversation so far and the usage counted; returns false when the conversation was ended meanwhile. */
  keep(messages: ChatMessage[], usage: Usage): Promise<boolean>;
  steps: number;
  messages: ChatMessage[];
  checkedUpTo: number;
  /** The reply of a rehearsal is the bot's, and says so. */
  rehearsal: boolean;
}

export type TurnResult =
  | { kind: 'replied'; messages: ChatMessage[]; usage: Usage }
  /** `retry`: the person may simply send the message again (the model was busy). Otherwise the conversation is over. */
  | { kind: 'failed'; message: string; retry: boolean; messages: ChatMessage[]; usage: Usage }
  | { kind: 'cancelled'; messages: ChatMessage[]; usage: Usage };

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
}

/** Tool calls one step may run; the rest are answered "too many" and not run. */
export const MAX_CALLS_PER_STEP = 6;
const MAX_TOOL_ANSWER_CHARS = 20_000;
const MAX_REPLY_CHARS = 8000;

const cap = (text: string): string => (text.length > MAX_TOOL_ANSWER_CHARS ? `${text.slice(0, MAX_TOOL_ANSWER_CHARS)} ...(cut)` : text);

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  let messages = input.messages;
  let checkedUpTo = input.checkedUpTo;
  const usage = { calls: 0, promptTokens: 0, completionTokens: 0 };
  const known = new Set(input.tools.map((t) => t.name));
  for (let step = 1; step <= input.steps; step += 1) {
    const turn = await input.model({ messages, checkedUpTo, tools: input.tools });
    if (!turn.ok) return { kind: 'failed', message: MODEL_FAILURE[turn.reason], retry: true, messages, usage };
    usage.calls += 1;
    usage.promptTokens += turn.promptTokens;
    usage.completionTokens += turn.completionTokens;
    // the copy the gateway sends back has any redaction applied: it is the history from here on
    messages = turn.messages;
    checkedUpTo = messages.length;

    if (turn.toolCalls.length === 0) {
      const text = (turn.text ?? '').trim();
      messages.push({ role: 'assistant', content: turn.text });
      if (text === '') return { kind: 'failed', message: 'The model answered with nothing. Try again.', retry: true, messages, usage };
      const body = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)} …(cut)` : text;
      input.push({ kind: 'reply', text: turn.truncated ? `${body} …(the model ran out of room here)` : body, rehearsal: input.rehearsal });
      return { kind: 'replied', messages, usage };
    }

    messages.push({ role: 'assistant', content: turn.text, toolCalls: turn.toolCalls });
    for (const [i, call] of turn.toolCalls.entries()) {
      let content: string;
      if (i >= MAX_CALLS_PER_STEP) {
        content = JSON.stringify({ ok: false, message: `Only ${String(MAX_CALLS_PER_STEP)} tools can be called in one step. Ask again for the rest.` });
        input.push({ kind: 'step', tool: call.name.slice(0, 100), what: 'Skipped a tool call: too many in one step', outcome: 'refused', badge: null });
      } else if (!known.has(call.name)) {
        // a name the model was never offered does not reach any tool (in Rehearse: not the broker)
        content = JSON.stringify({ ok: false, code: 'unknown_tool', message: 'There is no such tool.' });
        // eslint-disable-next-line no-control-regex -- a tool name from a model is stripped of control characters
        input.push({ kind: 'step', tool: call.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100), what: `Asked for “${call.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60)}”, which is not a tool here`, outcome: 'refused', badge: null });
      } else {
        try {
          const done = await input.call(call.name, call.arguments);
          content = cap(done.content);
          input.push({ kind: 'step', tool: done.step.tool.slice(0, 100), what: done.step.what.slice(0, 300), outcome: done.step.outcome, badge: done.step.badge });
        } catch (err) {
          input.toolFailed?.(call.name, err);
          content = JSON.stringify({ ok: false, message: 'That tool did not work. Try something else.' });
          input.push({ kind: 'step', tool: call.name.slice(0, 100), what: 'A tool did not work', outcome: 'failed', badge: null });
        }
      }
      messages.push({ role: 'tool', content, toolCallId: call.id });
    }
    if (!(await input.keep(messages, usage))) return { kind: 'cancelled', messages, usage };
  }
  return { kind: 'failed', message: 'That took more steps than one message may use. Ask for one smaller thing at a time.', retry: true, messages, usage };
}
