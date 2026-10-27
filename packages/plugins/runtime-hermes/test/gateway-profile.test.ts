/* eslint-disable @typescript-eslint/no-explicit-any -- these tests read JSON documents of many shapes */
import { parseBotMd } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { GATEWAY_ENV, renderGatewayProfile, type GatewayProfileInput } from '../src/gateway-profile.ts';

// The profile of a managed bot (mode B), as the pod will read it. The bytes are asserted: a change to the profile is a change a reviewer sees here.

const FRONTMATTER = `name: Coder
role: Owns a task's branch
kind: agent
runtime: hermes
model: { aliases: [code, fast], effort: medium }
capabilities:
  native: [messages.*]
  runtime: [shell, files]
placement:
  gateway: { connection: managed }
`;
const BODY = '# Coder\nYou own a task until you hand it over.';

const definition = () => {
  const parsed = parseBotMd(`---\n${FRONTMATTER}---\n${BODY}\n`);
  if (!parsed.ok) throw new Error(`the fixture must parse: ${parsed.failure.message}`);
  return { frontmatter: parsed.frontmatter, body: parsed.body };
};

const input = (over: Partial<GatewayProfileInput> = {}): GatewayProfileInput => ({
  botSlug: 'coder',
  mcpUrl: 'http://manythreads-server:3000/api/mcp/bots/11111111-1111-1111-1111-111111111111',
  mcpTokenVar: GATEWAY_ENV.mcpToken,
  model: { baseUrl: 'http://manythreads-litellm:4000/v1', apiKeyVar: GATEWAY_ENV.llmKey, alias: 'code' },
  terminal: { backend: 'ssh', host: 'dev-box.internal', user: 'hermes', cwd: '/workspace/engineering' },
  ...over,
});

describe('renderGatewayProfile', () => {
  it('the config changes when a granted native tool changes, so the pod restarts the gateway that listed its tools once', () => {
    const base = renderGatewayProfile(definition(), input())['config.yaml'];
    const parsed = parseBotMd(`---\n${FRONTMATTER.replace('native: [messages.*]', 'native: [messages.*, tasks.describe]')}---\n${BODY}\n`);
    if (!parsed.ok) throw new Error(parsed.failure.message);
    const more = renderGatewayProfile({ frontmatter: parsed.frontmatter, body: parsed.body }, input())['config.yaml'];
    expect(more).not.toBe(base);
    expect(base).toMatch(/^# manythreads tools: [0-9a-f]{8}$/m);
    // the same grants in another order are the same file
    const reordered = parseBotMd(`---\n${FRONTMATTER.replace('native: [messages.*]', 'native: [tasks.describe, messages.*]')}---\n${BODY}\n`);
    if (!reordered.ok) throw new Error(reordered.failure.message);
    expect(renderGatewayProfile({ frontmatter: reordered.frontmatter, body: reordered.body }, input())['config.yaml']).toBe(more);
  });

  it('writes the BOT.md body as SOUL.md and lists the .env variables without values', () => {
    const files = renderGatewayProfile(definition(), input());
    expect(files['SOUL.md']).toBe(`${BODY}\n`);
    expect(files['.env.template']).toContain('API_SERVER_KEY=\n');
    expect(files['.env.template']).toContain('MANYTHREADS_MCP_TOKEN=\n');
    expect(files['.env.template']).toContain('MANYTHREADS_LLM_KEY=\n');
    expect(files['.env.template']).not.toMatch(/=\S/);
  });

  it('renders a config.yaml that parses: in-cluster model and MCP addresses, secrets by variable name only, MCP tools visible', () => {
    const files = renderGatewayProfile(definition(), input());
    const yaml = parseYaml(files['config.yaml']) as Record<string, any>;
    expect(yaml['model']).toEqual({ provider: 'manythreads', default: 'code' });
    expect(yaml['providers']['manythreads']).toMatchObject({ api: 'http://manythreads-litellm:4000/v1', api_key: '${MANYTHREADS_LLM_KEY}' });
    expect(yaml['mcp_servers']['manythreads']).toMatchObject({
      url: 'http://manythreads-server:3000/api/mcp/bots/11111111-1111-1111-1111-111111111111',
      headers: { Authorization: 'Bearer ${MANYTHREADS_MCP_TOKEN}' },
    });
    // Without this Hermes hides MCP tools behind a search tool and the model never calls them directly.
    expect(yaml['tools']).toEqual({ tool_search: { enabled: 'off' } });
    expect(yaml['agent']['reasoning_effort']).toBe('medium');
    // No secret value can be in the file: every secret is a ${NAME} reference.
    expect(files['config.yaml']).not.toMatch(/sk-|mtk_|Bearer [A-Za-z0-9_-]{10,}/);
  });

  it('turns capabilities.runtime into the profile toolsets, and the ssh terminal the shell runs in', () => {
    const yaml = parseYaml(renderGatewayProfile(definition(), input())['config.yaml']) as Record<string, any>;
    // with an ssh terminal the files are in the workbench: Hermes' own file tools would write the wrong disk, so the shell is the file tool
    expect(yaml['platform_toolsets']['api_server']).toEqual(['terminal']);
    expect(yaml['agent']['disabled_toolsets']).toContain('file');
    expect(yaml['agent']['disabled_toolsets']).not.toContain('terminal');
    expect(yaml['agent']['disabled_toolsets']).toContain('browser');
    expect(yaml['terminal']).toEqual({ backend: 'ssh', ssh_host: 'dev-box.internal', ssh_user: 'hermes', cwd: '/workspace/engineering' });
  });

  it('leaves the file tools out on a team pod even when the pod adds the terminal itself, and keeps them where files are local', () => {
    const pod = parseYaml(renderGatewayProfile(definition(), input({ terminal: undefined as never, filesInWorkbench: true }))['config.yaml']) as Record<string, any>;
    expect(pod['platform_toolsets']['api_server']).toEqual(['terminal']);
    expect(pod['agent']['disabled_toolsets']).toContain('file');
    const local = parseYaml(renderGatewayProfile(definition(), input({ terminal: undefined as never }))['config.yaml']) as Record<string, any>;
    expect(local['platform_toolsets']['api_server']).toEqual(['terminal', 'file']);
  });

  it('renders no terminal block when none is given, and is byte-stable', () => {
    const a = renderGatewayProfile(definition(), input({ terminal: undefined as never }));
    const rest: Partial<GatewayProfileInput> = input();
    delete rest.terminal;
    const b = renderGatewayProfile(definition(), rest as GatewayProfileInput);
    expect(b['config.yaml']).not.toContain('terminal:');
    expect(a['config.yaml']).toBe(b['config.yaml']);
    expect(renderGatewayProfile(definition(), input())).toEqual(renderGatewayProfile(definition(), input()));
  });

  it('refuses a variable name that is not an environment variable', () => {
    expect(() => renderGatewayProfile(definition(), input({ mcpTokenVar: 'bad name' }))).toThrow(/environment variable/);
    expect(() => renderGatewayProfile(definition(), input({ model: { baseUrl: 'x', apiKeyVar: 'lower', alias: 'code' } }))).toThrow(/environment variable/);
  });
});
