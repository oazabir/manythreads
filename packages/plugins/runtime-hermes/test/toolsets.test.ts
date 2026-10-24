import { parseBotMd } from '@manythreads/shared';
import type { BotRuntimeInput } from '@manythreads/sdk';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { renderConfig } from '../src/profile.ts';
import { GUARDED_TOOLSETS, RUNTIME_GRANT_TOOLSETS, hermesToolsets } from '../src/toolsets.ts';

// `capabilities.runtime` is the definition's grant of what the bot's process may do; the profile turns it into Hermes' tool list. A bot without
// `shell` must have no terminal tool — measured against the real CLI (docs/plugins/runners.md): an empty list is NOT "no tools" to Hermes, so a
// bot with no grant gets the harmless `todo`, and everything not granted is also disabled by name.

describe('hermesToolsets', () => {
  it('a bot with no grant gets the harmless toolset and every guarded one disabled', () => {
    for (const grants of [undefined, [], ['git'], ['nonsense']]) {
      const t = hermesToolsets(grants);
      expect(t.enabled, JSON.stringify(grants)).toEqual(['todo']);
      expect(t.disabled).toEqual([...GUARDED_TOOLSETS]);
    }
  });

  it('shell turns on the terminal and nothing else; files the file tools and nothing else', () => {
    expect(hermesToolsets(['shell'])).toMatchObject({ enabled: ['terminal'] });
    expect(hermesToolsets(['shell']).disabled).not.toContain('terminal');
    expect(hermesToolsets(['shell']).disabled).toContain('file');
    expect(hermesToolsets(['files'])).toMatchObject({ enabled: ['file'] });
    expect(hermesToolsets(['files']).disabled).toContain('terminal');
  });

  it('a bot without shell has no terminal tool, whatever else it holds', () => {
    for (const grants of [['files'], ['files', 'git'], ['git'], ['browser', 'files'], ['web']]) {
      const t = hermesToolsets(grants);
      expect(t.enabled, JSON.stringify(grants)).not.toContain('terminal');
      expect(t.disabled, JSON.stringify(grants)).toContain('terminal');
    }
  });

  it('git is a program in the shell: it adds no toolset of its own', () => {
    expect(hermesToolsets(['files', 'git'])).toEqual(hermesToolsets(['files']));
    expect(hermesToolsets(['shell', 'files', 'git'])).toEqual(hermesToolsets(['files', 'shell']));
  });

  it('is pure and stable: the order of the grants does not change the answer, and enabled and disabled never overlap', () => {
    expect(hermesToolsets(['shell', 'files', 'browser'])).toEqual(hermesToolsets(['browser', 'files', 'shell']));
    for (const grants of [['shell'], ['files', 'browser'], ['shell', 'files', 'browser', 'web', 'vision']]) {
      const t = hermesToolsets(grants);
      expect(t.enabled.filter((name) => t.disabled.includes(name))).toEqual([]);
    }
  });

  it('every granted toolset is one the table knows, and the table only names guarded toolsets', () => {
    for (const toolset of Object.values(RUNTIME_GRANT_TOOLSETS)) expect(GUARDED_TOOLSETS).toContain(toolset);
    expect(new Set(GUARDED_TOOLSETS).size).toBe(GUARDED_TOOLSETS.length);
    // code execution, sub-agents, scheduled jobs and memory are never a runtime grant
    for (const never of ['code_execution', 'delegation', 'cronjob', 'memory']) expect(Object.values(RUNTIME_GRANT_TOOLSETS)).not.toContain(never);
  });
});

const profileInput = (runtime: string | undefined): BotRuntimeInput => {
  const caps = runtime === undefined ? '' : `capabilities:\n  runtime: [${runtime}]\n`;
  const parsed = parseBotMd(`---\nname: Coder\nrole: Writes code\nkind: agent\nruntime: hermes\nmodel: { aliases: [code] }\n${caps}---\nBody\n`);
  if (!parsed.ok) throw new Error('the fixture BOT.md must parse');
  return {
    bot: { id: '11111111-1111-1111-1111-111111111111', slug: 'coder', name: 'Coder', teamId: '22222222-2222-2222-2222-222222222222', workspaceId: '33333333-3333-3333-3333-333333333333', runtime: 'hermes', definitionSha: 'a'.repeat(64) },
    definition: { frontmatter: parsed.frontmatter, body: parsed.body },
    trigger: 'mention',
    asker: null,
    prompt: 'hi',
    thread: null,
    endpoint: { runId: '77777777-7777-7777-7777-777777777777', url: 'https://threads.example/api/mcp/runs/77777777-7777-7777-7777-777777777777', token: 'run-token' },
    gateway: { baseUrl: 'http://litellm:4000', key: 'sk-bot-key' },
    limits: { runBudgetSeconds: 300, maxTurns: null, sessionMinutes: null },
  };
};

describe('the rendered profile carries the grant', () => {
  it('writes platform_toolsets.cli and agent.disabled_toolsets from capabilities.runtime', () => {
    const yaml = parseYaml(renderConfig(profileInput('shell, files, git'))) as { platform_toolsets: { cli: string[] }; agent: { disabled_toolsets: string[] } };
    expect(yaml.platform_toolsets.cli).toEqual(['terminal', 'file']);
    expect(yaml.agent.disabled_toolsets).not.toContain('terminal');
    expect(yaml.agent.disabled_toolsets).not.toContain('file');
    expect(yaml.agent.disabled_toolsets).toContain('browser');
    expect(yaml.agent.disabled_toolsets).toContain('code_execution');
  });

  it('a definition with no runtime grant renders no terminal and no file tools', () => {
    const yaml = parseYaml(renderConfig(profileInput(undefined))) as { platform_toolsets: { cli: string[] }; agent: { disabled_toolsets: string[] } };
    expect(yaml.platform_toolsets.cli).toEqual(['todo']);
    expect(yaml.agent.disabled_toolsets).toEqual(expect.arrayContaining(['terminal', 'file', 'browser']));
  });

  it('keeps one agent section when the definition also sets an effort', () => {
    const text = renderConfig(profileInput('shell'));
    expect(text.match(/^agent:/gm)).toHaveLength(1);
    const withEffort = renderConfig({ ...profileInput('shell'), definition: { ...profileInput('shell').definition, frontmatter: { ...profileInput('shell').definition.frontmatter, model: { aliases: ['code'], effort: 'high' } } } });
    expect(withEffort.match(/^agent:/gm)).toHaveLength(1);
    expect((parseYaml(withEffort) as { agent: { reasoning_effort: string } }).agent.reasoning_effort).toBe('high');
  });
});
