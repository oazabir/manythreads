import { describe, expect, it } from 'vitest';
import { MAX_CALLS_PER_STEP, MODEL_FAILURE, runLoop, type ChatMessage, type LoopInput, type ModelAnswer } from '../src/loop.ts';
import { TOOL_ANSWER_MAX_CHARS, type ToolResult } from '../src/tools.ts';

// P7-02: the helper's loop with a scripted model and scripted tools: no database, no network.

type Call = { id: string; name: string; arguments: string };
const calls = (...names: string[]): Call[] => names.map((name, i) => ({ id: `c${i}`, name, arguments: '{}' }));
const turn = (toolCalls: Call[], text: string | null = null): ModelAnswer => ({ ok: true, text, toolCalls, messages: [] });

function drive(script: ModelAnswer[], tools: Record<string, ToolResult>, over: Partial<LoopInput> = {}) {
  const ran: string[] = [];
  const seen: ChatMessage[][] = [];
  let at = 0;
  const input: LoopInput = {
    steps: 8,
    messages: [{ role: 'user', content: 'brief' }],
    checkedUpTo: 1,
    async model({ messages }) {
      seen.push([...messages]);
      const next = script[at++];
      if (!next) throw new Error('script ran out');
      return next.ok ? { ...next, messages: [...messages] } : next;
    },
    async tool(name) {
      ran.push(name);
      const result = tools[name];
      if (!result) throw new Error(`no such tool ${name}`);
      return result;
    },
    async keep() {
      return true;
    },
    ...over,
  };
  return { run: () => runLoop(input), ran, seen };
}

const answer = (end?: 'asking' | 'proposed'): ToolResult => ({ answer: { ok: true }, ...(end ? { end } : {}) });

describe('the helper loop', () => {
  it('looks around, then ends by asking', async () => {
    const d = drive([turn(calls('describe_self')), turn(calls('ask_clarification'))], { describe_self: answer(), ask_clarification: answer('asking') });
    const r = await d.run();
    expect(r).toMatchObject({ kind: 'ended', end: 'asking' });
    expect(d.ran).toEqual(['describe_self', 'ask_clarification']);
  });

  it('ends by proposing', async () => {
    const r = await drive([turn(calls('propose_config'))], { propose_config: answer('proposed') }).run();
    expect(r).toMatchObject({ kind: 'ended', end: 'proposed' });
  });

  it('answers each tool call in the conversation, in order, with its call id', async () => {
    const r = await drive([turn(calls('describe_self', 'knowledge_search')), turn(calls('ask_clarification'))], {
      describe_self: answer(),
      knowledge_search: answer(),
      ask_clarification: answer('asking'),
    }).run();
    const tools = r.messages.filter((m) => m.role === 'tool');
    expect(tools.map((m) => m.toolCallId)).toEqual(['c0', 'c1', 'c0']);
  });

  it('runs no call after the one that ended the turn, and does not run more than the limit in a step', async () => {
    const d = drive([turn(calls('ask_clarification', 'describe_self'))], { ask_clarification: answer('asking'), describe_self: answer() });
    expect(await d.run()).toMatchObject({ kind: 'ended' });
    expect(d.ran).toEqual(['ask_clarification']);

    const many = drive([turn(calls(...Array.from({ length: MAX_CALLS_PER_STEP + 2 }, () => 'describe_self'))), turn(calls('ask_clarification'))], {
      describe_self: answer(),
      ask_clarification: answer('asking'),
    });
    await many.run();
    expect(many.ran.filter((n) => n === 'describe_self')).toHaveLength(MAX_CALLS_PER_STEP);
  });

  it('tells the helper a tool failed in one plain sentence, never the cause, and tells the log', async () => {
    const logged: string[] = [];
    const d = drive([turn(calls('describe_self')), turn(calls('ask_clarification'))], { ask_clarification: answer('asking') }, { toolFailed: (name, err) => logged.push(`${name}: ${(err as Error).message}`) });
    const r = await d.run();
    expect(r.kind).toBe('ended');
    const failure = r.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c0')!;
    expect(failure.content).toBe(JSON.stringify({ ok: false, message: 'That tool did not work. Try something else.' }));
    expect(logged).toEqual(['describe_self: no such tool describe_self']);
  });

  it('reminds the helper once when it answers in plain words, and gives up the second time', async () => {
    const once = await drive([turn([], 'I think...'), turn(calls('ask_clarification'))], { ask_clarification: answer('asking') }).run();
    expect(once.kind).toBe('ended');
    expect(once.messages.some((m) => m.role === 'user' && /Do not reply with plain text/.test(m.content ?? ''))).toBe(true);
    const twice = await drive([turn([], 'a'), turn([], 'b')], {}).run();
    expect(twice).toMatchObject({ kind: 'failed' });
  });

  it('fails in a sentence when the steps run out', async () => {
    const r = await drive([turn(calls('describe_self')), turn(calls('describe_self'))], { describe_self: answer() }, { steps: 2 }).run();
    expect(r).toMatchObject({ kind: 'failed' });
    expect((r as { message: string }).message).toContain('used up its steps');
  });

  it('says why in plain words when the model call is not allowed or does not answer', async () => {
    for (const reason of ['refused', 'unbound', 'unavailable', 'timeout'] as const) {
      const r = await drive([{ ok: false, reason }], {}).run();
      expect(r).toEqual({ kind: 'failed', message: MODEL_FAILURE[reason], messages: [{ role: 'user', content: 'brief' }] });
    }
  });

  it('stops when the person cancelled, but a turn a tool ended stays final', async () => {
    const cancelled = await drive([turn(calls('describe_self')), turn(calls('ask_clarification'))], { describe_self: answer(), ask_clarification: answer('asking') }, { keep: async () => false }).run();
    expect(cancelled.kind).toBe('cancelled');
    const final = await drive([turn(calls('propose_config'))], { propose_config: answer('proposed') }, { keep: async () => false }).run();
    expect(final).toMatchObject({ kind: 'ended', end: 'proposed' });
  });

  it('cuts a very long tool answer', async () => {
    const big: ToolResult = { answer: { text: 'x'.repeat(TOOL_ANSWER_MAX_CHARS * 2) } };
    const r = await drive([turn(calls('describe_self')), turn(calls('ask_clarification'))], { describe_self: big, ask_clarification: answer('asking') }).run();
    const first = r.messages.find((m) => m.role === 'tool')!;
    expect(first.content!.length).toBeLessThan(TOOL_ANSWER_MAX_CHARS + 100);
    expect(first.content!.endsWith('...(cut)')).toBe(true);
  });
});
