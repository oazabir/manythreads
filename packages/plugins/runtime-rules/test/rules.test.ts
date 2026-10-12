import { parseBotMd } from '@manythreads/shared';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { RULES_RUNTIME_ID, ruleInput, rulesOf, rulesProvider } from '../src/index.ts';

// The no-model runtime (SPEC §8, PLAN P5-10): the definition's `capabilities.native`, in order, called with the run's trigger
// data and nothing else. No model call anywhere — the counting benchmark of P6-10 depends on exactly that.

const input = (native: string[] | null, body = 'Rules, not prose.'): BotRuntimeInput => {
  const parsed = parseBotMd(
    `---\nname: Counter\nrole: Adds one\nkind: automation\nruntime: rules\n${native ? `capabilities: { native: [${native.join(', ')}] }\n` : ''}---\n${body}\n`,
  );
  if (!parsed.ok) throw new Error(parsed.failure.message);
  return {
    bot: {
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'counter',
      name: 'Counter',
      teamId: '22222222-2222-2222-2222-222222222222',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      runtime: 'rules',
      definitionSha: 'b'.repeat(64),
    },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: { actorId: '44444444-4444-4444-4444-444444444444', personId: null, displayName: 'Nadia' },
    prompt: 'Nadia in #dev:\n\n@counter go',
    thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: '66666666-6666-6666-6666-666666666666' },
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://threads.example/api/mcp/runs/77777777-7777-7777-7777-777777777777', token: 't' },
    gateway: null,
    limits: { runBudgetSeconds: null, maxTurns: null, sessionMinutes: null },
  };
};

const scope = (invoke: BotRuntimeScope['invoke']): { scope: BotRuntimeScope; logs: string[] } => {
  const logs: string[] = [];
  return {
    logs,
    scope: { invoke, logSource: async () => 0, log: (line) => void logs.push(line) },
  };
};

const drain = async (iterable: AsyncIterable<BotRuntimeEvent>): Promise<BotRuntimeEvent[]> => {
  const out: BotRuntimeEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
};

describe('runtime-rules', () => {
  it('registers the provider a `runtime: rules` bot resolves to', () => {
    expect(rulesProvider.id).toBe(RULES_RUNTIME_ID);
    expect(rulesProvider.id).toBe('rules');
  });

  it('takes its rules from capabilities.native, in the author’s order', () => {
    expect(rulesOf(input(['tasks.claim', 'tasks.complete']))).toEqual(['tasks.claim', 'tasks.complete']);
    expect(rulesOf(input(null))).toEqual([]);
  });

  it('runs every rule in order, through the run’s scope, and answers no text', async () => {
    const calls: string[] = [];
    const { scope: s } = scope(async (capability) => {
      calls.push(capability);
      return { ok: true };
    });
    const handle = await rulesProvider.run(input(['tasks.claim', 'tasks.complete']), s);
    const events = await drain(handle.events);
    expect(calls).toEqual(['tasks.claim', 'tasks.complete']);
    expect(events.filter((e) => e.type === 'tool').map((e) => e.name)).toEqual(['tasks.claim', 'tasks.complete']);
    expect(events.at(-1)).toEqual({ type: 'result', text: '', ok: true, tokens: null });
  });

  it('hands each rule exactly the shape of a strict `messages.post` and no model anywhere', async () => {
    const seen: Record<string, unknown>[] = [];
    const { scope: s } = scope(async (_capability, args) => {
      seen.push(args);
      return {};
    });
    const handle = await rulesProvider.run(input(['tasks.claim']), s);
    await drain(handle.events);
    expect(seen).toEqual([
      {
        channelId: '55555555-5555-5555-5555-555555555555',
        body: 'Nadia in #dev:\n\n@counter go',
        threadRootId: '66666666-6666-6666-6666-666666666666',
      },
    ]);
    expect(ruleInput(input(['tasks.claim']))).not.toHaveProperty('model');
  });

  it('stops at the first rule that fails, and says why', async () => {
    let calls = 0;
    const { scope: s, logs } = scope(async (capability) => {
      calls += 1;
      if (capability === 'tasks.claim') throw new Error('no grant for "tasks.claim"');
      return {};
    });
    const handle = await rulesProvider.run(input(['tasks.claim', 'tasks.complete']), s);
    const events = await drain(handle.events);
    expect(calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: 'result', text: '', ok: false, error: 'no grant for "tasks.claim"', tokens: null });
    expect(logs.join(' ')).toMatch(/tasks\.claim failed/);
  });

  it('a definition with no rules runs, does nothing and says so', async () => {
    const { scope: s, logs } = scope(async () => ({}));
    const handle = await rulesProvider.run(input(null), s);
    const events = await drain(handle.events);
    expect(events).toEqual([{ type: 'result', text: '', ok: true, tokens: null }]);
    expect(logs.join(' ')).toMatch(/no capabilities\.native/);
  });

  it('renders the run’s rules as its profile', () => {
    const profile = rulesProvider.render(input(['tasks.claim']));
    expect(JSON.parse(profile.files['rules.json']!)).toEqual({ bot: 'counter', trigger: 'mention', steps: ['tasks.claim'] });
    expect(profile.home).toBe('counter-77777777-7777-7777-7777-777777777777');
  });
});
