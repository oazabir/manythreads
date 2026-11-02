import type { McpToolsProvider } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { MODEL_FAILURE, type ChatMessage } from '../src/loop.ts';
import { rehearsalTools, wireNames } from '../src/rehearse.ts';
import { MAX_CALLS_PER_STEP, runTurn, type TurnInput, type TurnModelAnswer, type TurnToolAnswer } from '../src/turn.ts';
import type { NewEntry, ToolSpec } from '../src/wtools.ts';

// P7-05: one turn of a Workshop conversation with a scripted model and scripted tools (no database), and the Rehearse door with a fake broker.

type Call = { id: string; name: string; arguments: string };
const calls = (...names: string[]): Call[] => names.map((name, i) => ({ id: `c${String(i)}`, name, arguments: '{}' }));
const toolTurn = (toolCalls: Call[]): TurnModelAnswer => ({ ok: true, text: null, toolCalls, messages: [], promptTokens: 10, completionTokens: 5, truncated: false });
const textTurn = (text: string | null, truncated = false): TurnModelAnswer => ({ ok: true, text, toolCalls: [], messages: [], promptTokens: 10, completionTokens: 5, truncated });
const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: { type: 'object' } });

function drive(script: TurnModelAnswer[], offered: string[], over: Partial<TurnInput> = {}) {
  const ran: string[] = [];
  const entries: NewEntry[] = [];
  let at = 0;
  const input: TurnInput = {
    steps: 8,
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
    checkedUpTo: 2,
    rehearsal: false,
    tools: offered.map(spec),
    async model({ messages }) {
      const next = script[at++];
      if (!next) throw new Error('script ran out');
      return next.ok ? { ...next, messages: [...messages] } : next;
    },
    async call(name): Promise<TurnToolAnswer> {
      ran.push(name);
      return { content: JSON.stringify({ ok: true }), step: { tool: name, what: `ran ${name}`, outcome: 'ok', badge: null } };
    },
    push: (e) => entries.push(e),
    async keep() {
      return true;
    },
    ...over,
  };
  return { run: () => runTurn(input), ran, entries };
}

describe('the turn loop', () => {
  it('a plain-text answer ends the turn and is the reply; usage is counted', async () => {
    const d = drive([toolTurn(calls('read_bot')), textTurn('All done.')], ['read_bot']);
    const r = await d.run();
    expect(r.kind).toBe('replied');
    expect(r.usage).toEqual({ calls: 2, promptTokens: 20, completionTokens: 10 });
    expect(d.entries.map((e) => e.kind)).toEqual(['step', 'reply']);
    expect(d.ran).toEqual(['read_bot']);
  });

  it('marks a reply of a rehearsal, and says when the model ran out of room', async () => {
    const d = drive([textTurn('Half an ans', true)], [], { rehearsal: true });
    await d.run();
    expect(d.entries[0]).toMatchObject({ kind: 'reply', rehearsal: true });
    expect((d.entries[0] as { text: string }).text).toMatch(/ran out of room/);
  });

  it('a hostile model: a name that was never offered runs nothing, however it is spelled', async () => {
    const d = drive([toolTurn(calls('messages.post', 'repo_commit', 'Read_Bot', 'read_bot ', '__proto__', 'x'.repeat(500))), textTurn('ok')], ['read_bot']);
    const r = await d.run();
    expect(r.kind).toBe('replied');
    expect(d.ran).toEqual([]);
    const steps = d.entries.filter((e) => e.kind === 'step');
    expect(steps).toHaveLength(6);
    expect(steps.every((s) => s.kind === 'step' && s.outcome === 'refused' && s.tool.length <= 100)).toBe(true);
  });

  it('runs at most six calls in one step; the rest are answered "too many" and not run', async () => {
    const names = Array.from({ length: MAX_CALLS_PER_STEP + 2 }, () => 'read_bot');
    const d = drive([toolTurn(calls(...names)), textTurn('ok')], ['read_bot']);
    await d.run();
    expect(d.ran).toHaveLength(MAX_CALLS_PER_STEP);
  });

  it('a tool that throws is answered "did not work" and the turn goes on', async () => {
    const d = drive([toolTurn(calls('read_bot')), textTurn('ok')], ['read_bot'], {
      async call() {
        throw new Error('database password is hunter2');
      },
    });
    const r = await d.run();
    expect(r.kind).toBe('replied');
    const toolMessage = r.messages.find((m: ChatMessage) => m.role === 'tool');
    expect(toolMessage?.content).not.toContain('hunter2');
    expect(d.entries[0]).toMatchObject({ kind: 'step', outcome: 'failed' });
  });

  it('a model failure ends the turn so the person can send the message again', async () => {
    const r = await drive([{ ok: false, reason: 'timeout' }], []).run();
    expect(r).toMatchObject({ kind: 'failed', retry: true, message: MODEL_FAILURE.timeout });
  });

  it('an empty answer is a failure; a turn that keeps calling tools stops at the step limit', async () => {
    expect((await drive([textTurn('   ')], []).run()).kind).toBe('failed');
    const loop = drive(Array.from({ length: 3 }, () => toolTurn(calls('read_bot'))), ['read_bot'], { steps: 3 });
    const r = await loop.run();
    expect(r).toMatchObject({ kind: 'failed', retry: true });
    expect(r.kind === 'failed' && r.message).toMatch(/more steps/);
  });

  it('stops when the conversation was ended meanwhile', async () => {
    const d = drive([toolTurn(calls('read_bot')), textTurn('never')], ['read_bot'], {
      async keep() {
        return false;
      },
    });
    expect((await d.run()).kind).toBe('cancelled');
  });
});

describe('the Rehearse door', () => {
  const fakeMcp = () => {
    const sent: string[] = [];
    const mcp = {
      async sandboxCall(_run: unknown, name: string) {
        sent.push(name);
        return name === 'messages.search' ? { text: '{"ok":true}', isError: false, held: false } : { text: '{"ok":true,"done":false}', isError: false, held: true };
      },
    } as unknown as McpToolsProvider;
    return { mcp, sent };
  };
  const run = { runId: 'r1' } as never;

  it('wire names are what a model provider accepts, and two that collapse stay apart', () => {
    const { offered, real } = wireNames([spec('messages.post'), spec('messages_post'), spec('a b')]);
    expect(offered.map((t) => t.name)).toEqual(['messages_post', 'messages_post_2', 'a_b']);
    expect(real.get('messages_post')).toBe('messages.post');
    expect(real.get('messages_post_2')).toBe('messages_post');
  });

  it('only a wire name the broker offered reaches the broker; a held call carries the badge', async () => {
    const { mcp, sent } = fakeMcp();
    const t = rehearsalTools(mcp, run, [spec('messages.post'), spec('messages.search'), spec('test.write')]);
    const hostile = ['messages.post', 'shell_exec', '../../etc/passwd', 'constructor', 'toString'];
    for (const name of hostile) expect((await t.call(name, '{}')).step.outcome).toBe('refused');
    expect(sent).toEqual([]);
    const held = await t.call('messages_post', '{"channelId":"c1","body":"SECRET TEXT"}');
    expect(held.step).toMatchObject({ outcome: 'held', badge: 'not really done' });
    expect(held.step.what).toContain('c1');
    expect(held.step.what).not.toContain('SECRET TEXT');
    expect((await t.call('test_write', '{}')).step.badge).toBe('not really done');
    expect((await t.call('messages_search', '{"query":"x"}')).step).toMatchObject({ outcome: 'read', badge: null });
    expect(sent).toEqual(['messages.post', 'test.write', 'messages.search']);
  });

  it('arguments that are not an object are refused before the broker', async () => {
    const { mcp, sent } = fakeMcp();
    const t = rehearsalTools(mcp, run, [spec('messages.post')]);
    for (const raw of ['[1]', 'null', '"x"', '{nope']) expect((await t.call('messages_post', raw)).step.outcome).toBe('refused');
    expect(sent).toEqual([]);
  });
});
