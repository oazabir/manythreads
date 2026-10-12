import { parseBotMd } from '@manythreads/shared';
import type { BotRuntimeInput } from '@manythreads/sdk';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { chatArgs, profileHome, renderConfig, renderProfile } from '../src/profile.ts';

// The profile a run executes in (PLAN P5-10): the BOT.md body is SOUL.md, and config.yaml points at two endpoints — the
// workspace's model gateway with the bot's own key, and the run's MCP endpoint with the run token. Nothing else. The tests
// assert the bytes a Hermes process would read, so a change to the profile is a change a reviewer sees here.

const FRONTMATTER = `name: Coder
role: Owns a task's branch
kind: agent
runtime: hermes
model: { aliases: [code, fast], effort: medium }
triggers:
  - { type: mention, source: { channels: ["#dev"] } }
capabilities:
  native: [messages.*, pages.write]
limits: { timeoutSeconds: 300, sessionMinutes: 45 }
`;
const BODY = '# Coder — Engineering\nYou own a task until you hand it over.';

const input = (overrides: Partial<BotRuntimeInput> = {}): BotRuntimeInput => {
  const parsed = parseBotMd(`---\n${FRONTMATTER}---\n${BODY}\n`);
  if (!parsed.ok) throw new Error('the fixture BOT.md must parse');
  return {
    bot: {
      id: '11111111-1111-1111-1111-111111111111',
      slug: 'coder',
      name: 'Coder',
      teamId: '22222222-2222-2222-2222-222222222222',
      workspaceId: '33333333-3333-3333-3333-333333333333',
      runtime: 'hermes',
      definitionSha: 'a'.repeat(64),
    },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: { actorId: '44444444-4444-4444-4444-444444444444', personId: null, displayName: 'Nadia' },
    prompt: 'Nadia in #dev:\n\n@coder what changed?',
    thread: { channelId: '55555555-5555-5555-5555-555555555555', threadRootId: '66666666-6666-6666-6666-666666666666' },
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://threads.example/api/mcp/runs/run-token', token: 'run-token' },
    gateway: { baseUrl: 'http://litellm:4000', key: 'sk-bot-key' },
    limits: { runBudgetSeconds: 300, maxTurns: null, sessionMinutes: 45 },
    ...overrides,
  };
};

describe('renderProfile', () => {
  it('writes the BOT.md body as SOUL.md, verbatim', () => {
    const profile = renderProfile(input());
    expect(profile.files['SOUL.md']).toBe(`${BODY}\n`);
    expect(profile.files['SOUL.md']).toContain('You own a task until you hand it over.');
  });

  it('renders config.yaml that parses, pointing at the gateway and the run endpoint and nowhere else', () => {
    const yaml = parseYaml(renderConfig(input())) as Record<string, never>;
    expect(yaml).toMatchObject({
      model: { provider: 'manythreads', default: 'code' },
      agent: { reasoning_effort: 'medium' },
      providers: {
        manythreads: {
          api: 'http://litellm:4000/v1',
          api_key: 'sk-bot-key',
          transport: 'chat_completions',
          default_model: 'code',
        },
      },
      mcp_servers: {
        manythreads: {
          url: 'https://threads.example/api/mcp/runs/run-token',
          headers: { Authorization: 'Bearer run-token' },
        },
      },
    });
  });

  it('carries no credential but the bot key and the run token', () => {
    const text = renderConfig(input());
    for (const line of text.split('\n')) {
      if (!/api_key|Authorization/.test(line)) continue;
      expect(line).toMatch(/sk-bot-key|Bearer run-token/);
    }
    expect(text).not.toMatch(/hindsight|postgres|repo-token/i);
  });

  it('names the profile home after the bot and the run', () => {
    expect(profileHome(input())).toBe('coder-77777777-7777-7777-7777-777777777777');
  });

  it('refuses to render without an alias, a gateway or the run endpoint', () => {
    const noAlias = input();
    noAlias.definition.frontmatter = { ...noAlias.definition.frontmatter, model: undefined };
    expect(() => renderConfig(noAlias)).toThrow(/needs model.aliases\[0\]/);
    expect(() => renderConfig(input({ gateway: null }))).toThrow(/no LLM gateway/);
    expect(() => renderConfig(input({ endpoint: null }))).toThrow(/needs the run's own MCP endpoint/);
  });

  it('omits the api_key line when the bot has no key yet', () => {
    const yaml = parseYaml(renderConfig(input({ gateway: { baseUrl: 'http://litellm:4000', key: null } }))) as Record<string, never>;
    expect(yaml['providers']).toMatchObject({ manythreads: { api: 'http://litellm:4000/v1' } });
    expect(JSON.stringify(yaml)).not.toContain('api_key');
  });
});

describe('chatArgs', () => {
  it('asks for one one-shot turn as stream-json, with the turn budget from the definition', () => {
    expect(chatArgs(input())).toEqual([
      'chat',
      '--query-file',
      '-',
      '--oneshot',
      '--format',
      'stream-json',
      '--run-budget',
      '300',
    ]);
  });

  it('leaves the budget out when the definition sets none', () => {
    expect(chatArgs(input({ limits: { runBudgetSeconds: null, maxTurns: null, sessionMinutes: null } }))).not.toContain('--run-budget');
  });
});
