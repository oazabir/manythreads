import { TOOL_ANSWER_MAX_CHARS, type ToolResult } from './tools.ts';

// The helper's loop (PLAN P7-02): ask the model for a turn, run the tools it asked for, give it the answers, and go on until a tool ends the turn (it asked the person, or it proposed) or
// the steps run out. The model call and the tools are injected, so the tests drive it with a scripted model and no database. It is deliberately small and it is not the `model` runtime
// of bot-runners: that one serves a bot's run and needs a bot, a runner and a run, none of which exist while a bot is still being set up (docs/plugins/workshop.md says why).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  toolCallId?: string;
}

export type ModelAnswer =
  | { ok: true; text: string | null; toolCalls: Array<{ id: string; name: string; arguments: string }>; messages: ChatMessage[] }
  | { ok: false; reason: 'refused' | 'unbound' | 'unavailable' | 'timeout' };

export interface LoopInput {
  /** One model turn over the conversation so far; `checkedUpTo` is how many leading messages the gateway has already checked (and redacted in the copy it returns). */
  model(input: { messages: ChatMessage[]; checkedUpTo: number }): Promise<ModelAnswer>;
  /** Runs one tool call. */
  tool(name: string, rawArguments: string): Promise<ToolResult>;
  /** Called after every step with the conversation so far; returns false when the session was cancelled meanwhile. */
  keep(messages: ChatMessage[]): Promise<boolean>;
  /** Told when a tool threw, so the server log can say why; the helper only reads "did not work". */
  toolFailed?(name: string, err: unknown): void;
  steps: number;
  messages: ChatMessage[];
  checkedUpTo: number;
}

export type LoopResult =
  | { kind: 'ended'; end: 'asking' | 'proposed'; messages: ChatMessage[] }
  | { kind: 'failed'; message: string; messages: ChatMessage[] }
  | { kind: 'cancelled'; messages: ChatMessage[] };

/** Tool calls one step may run; the rest are answered "too many" and not run. */
export const MAX_CALLS_PER_STEP = 4;

/** One plain sentence for each way the model call can fail; nothing the gateway said is repeated. */
export const MODEL_FAILURE: Record<'refused' | 'unbound' | 'unavailable' | 'timeout', string> = {
  refused: "The workspace's model limits or guardrails did not allow the helper's call. Try again later, or ask an admin.",
  unbound: 'No model is connected for the setup helper yet. Ask an admin to connect a model, then try again.',
  unavailable: 'The model did not answer. Try again in a minute.',
  timeout: 'The model took too long to answer. Try again in a minute.',
};

const cap = (text: string): string => (text.length > TOOL_ANSWER_MAX_CHARS ? `${text.slice(0, TOOL_ANSWER_MAX_CHARS)} ...(cut)` : text);

export async function runLoop(input: LoopInput): Promise<LoopResult> {
  let messages = input.messages;
  let checkedUpTo = input.checkedUpTo;
  let nudged = false;
  for (let step = 1; step <= input.steps; step += 1) {
    const turn = await input.model({ messages, checkedUpTo });
    if (!turn.ok) return { kind: 'failed', message: MODEL_FAILURE[turn.reason], messages };
    // the copy the gateway sends back has any redaction applied: it is the history from here on
    messages = turn.messages;
    checkedUpTo = messages.length;
    messages.push({ role: 'assistant', content: turn.text, ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls } : {}) });

    if (turn.toolCalls.length === 0) {
      // Plain words and no tool: the helper must finish with a tool. Remind it once; after that it has not understood the job.
      if (nudged) return { kind: 'failed', message: 'The helper did not finish. Try again, or add the bot by hand.', messages };
      nudged = true;
      messages.push({ role: 'user', content: 'Finish by calling ask_clarification (if anything is unclear or missing) or propose_config. Do not reply with plain text.' });
      if (!(await input.keep(messages))) return { kind: 'cancelled', messages };
      continue;
    }

    let ended: 'asking' | 'proposed' | null = null;
    for (const [i, call] of turn.toolCalls.entries()) {
      let answer: string;
      if (ended !== null) {
        answer = JSON.stringify({ ok: false, message: 'This turn is already over.' });
      } else if (i >= MAX_CALLS_PER_STEP) {
        answer = JSON.stringify({ ok: false, message: 'Too many tool calls in one step. Call fewer at a time.' });
      } else {
        try {
          const result = await input.tool(call.name, call.arguments);
          answer = cap(JSON.stringify(result.answer));
          if (result.end) ended = result.end;
        } catch (err) {
          // the person sees one sentence; the cause is in the server log, never in what the helper reads
          input.toolFailed?.(call.name, err);
          answer = JSON.stringify({ ok: false, message: 'That tool did not work. Try something else.' });
        }
      }
      messages.push({ role: 'tool', content: answer, toolCallId: call.id });
    }
    // a turn a tool ended is final whatever `keep` says (after `propose_config` the row is no longer "working", so keep has nothing left to write)
    const alive = await input.keep(messages);
    if (ended !== null) return { kind: 'ended', end: ended, messages };
    if (!alive) return { kind: 'cancelled', messages };
  }
  return { kind: 'failed', message: 'The helper used up its steps without finishing. Try again with a shorter brief, or add the bot by hand.', messages };
}
