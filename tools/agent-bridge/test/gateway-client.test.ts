import { parseBotMd } from '@manythreads/shared';
import type { BotRuntimeEvent, BotRuntimeInput, BotRuntimeScope } from '@manythreads/sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOnGateway } from '../../../packages/plugins/runtime-hermes/src/gateway.ts';
import { harness, KEY, type Harness } from './support.ts';

// The real server-side client (`runOnGateway`) against the bridge with a fake `claude`: the wire the two share is the one under test.

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const scope: BotRuntimeScope = { invoke: async () => ({}), logSource: async () => 0, log: () => undefined };

const input = (): BotRuntimeInput => {
  const parsed = parseBotMd('---\nname: Coder\nrole: r\nkind: agent\nruntime: hermes\ncapabilities:\n  runtime: [files]\n---\nYou are Coder.\n');
  if (!parsed.ok) throw new Error('fixture');
  return {
    bot: { id: '11111111-1111-1111-1111-111111111111', slug: 'coder', name: 'Coder', teamId: '22222222-2222-2222-2222-222222222222', workspaceId: '33333333-3333-3333-3333-333333333333', runtime: 'hermes', definitionSha: 'a'.repeat(64) },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: null,
    prompt: 'what changed?',
    thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: '66666666-6666-6666-6666-666666666666' },
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://mt.example/mcp', token: 'run-token-abc' },
    gateway: null,
    limits: { runBudgetSeconds: 30, maxTurns: null, sessionMinutes: null },
  };
};

describe('runOnGateway against the bridge', () => {
  it('runs a bot on Claude Code and reads the events the server expects', async () => {
    const handle = await runOnGateway(
      { resolve: async () => ({ baseUrl: h.bridge.url, apiKey: KEY, kind: 'external', agent: 'claude-code' }), killGraceSeconds: 1, retryUnitMs: 10 },
      input(),
      scope,
      { connection: 'laptop' },
    );
    const out: BotRuntimeEvent[] = [];
    for await (const e of handle.events) out.push(e);
    expect(out.map((e) => e.type)).toEqual(['text', 'tool', 'tool_result', 'tool', 'tool_result', 'text', 'result']);
    const result = out.at(-1)!;
    expect(result).toMatchObject({ type: 'result', ok: true, text: 'Looking. Done.', tokens: { input: 110, output: 5, total: 115 } });
    const call = h.calls()[0]!;
    expect(call['instructions']).toBe('You are Coder.');
    expect(call['token']).toBe('run-token-abc');
    expect((call['argv'] as string[])[(call['argv'] as string[]).indexOf('--tools') + 1]).toContain('Read');
  });

  it('is refused with a wrong key', async () => {
    const handle = await runOnGateway(
      { resolve: async () => ({ baseUrl: h.bridge.url, apiKey: 'wrong-key-0123456789', kind: 'external', agent: 'claude-code' }), killGraceSeconds: 1, retryUnitMs: 10 },
      input(),
      scope,
      { connection: 'laptop' },
    );
    const out: BotRuntimeEvent[] = [];
    for await (const e of handle.events) out.push(e);
    expect(out.at(-1)).toMatchObject({ type: 'result', ok: false });
  });
});
