import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { adapterCommand, adapterEnv, desiredMode, flavorOf, mcpServers, optionFor, sessionMeta, sessionOption, wantedOptions, type PermissionOption } from '../src/acp/adapter.ts';
import { clipText, diffCounts, Frames, isHiddenStep, relativePath, viewOf } from '../src/acp/frames.ts';
import { isFound, isMissingSession } from '../src/acp/session.ts';
import { parseConfig } from '../src/config.ts';
import type { DriverJob } from '../src/drivers/types.ts';

// The mapping from the adapters' own frames to the bridge's, over the RECORDED sessions (test/fixtures/acp, P25-01), not over the fake agent: the fixtures are the contract.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp');
type Line = { dir: 'c2a' | 'a2c'; msg: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string): Line[] =>
  readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);

const CWD = '<cwd>'; // the fixtures are sanitised: the run folder is written <cwd>
type Out = { event: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

function fold(name: string, secrets: string[] = []): { out: Out[]; frames: Frames } {
  const out: Out[] = [];
  const frames = new Frames({ cwd: CWD, secrets, emit: (event, fields) => out.push({ event, ...fields }) });
  for (const l of fixture(name)) if (l.dir === 'a2c' && l.msg['method'] === 'session/update') frames.update(l.msg['params'].update);
  frames.finish(false);
  return { out, frames };
}
const of = (out: Out[], event: string): Out[] => out.filter((o) => o.event === event);

describe('frames over the recorded sessions', () => {
  it('claude: steps with ids, the refined title and path, a helper with its child, a plan, and no tool of the bridge\'s own bookkeeping', () => {
    const { out, frames } = fold('claude-work');
    const started = of(out, 'tool.started');
    expect(started.map((s) => s['tool'])).toEqual(['Glob', 'Read', 'mcp__manythreads__mt_note', 'Read']);
    expect(of(out, 'step.update').find((s) => s['title'] === 'Read package.json')).toMatchObject({ paths: ['package.json'] });
    // the platform's own tool is shown by its name; its arguments never
    expect(started[2]).toMatchObject({ title: 'mcp__manythreads__mt_note', mcp: true });
    // the helper: its child step names it as the parent, and it ends done
    const helper = of(out, 'agent.update');
    expect(helper.at(-1)).toMatchObject({ name: 'Read package.json name', status: 'done', steps: 1 });
    expect(started[3]).toMatchObject({ parent_step_id: helper[0]!['agent_id'] });
    // the plan: replaced as a whole each time it changes
    expect(of(out, 'plan.update').map((p) => p['entries'].length)).toEqual([1, 2, 2]);
    expect(of(out, 'plan.update').at(-1)!['entries'][0]).toEqual({ content: 'Run the listed steps in order', status: 'completed' });
    // no hand-back tool and no task bookkeeping among the steps
    expect(out.some((o) => JSON.stringify(o).includes('SubagentHandback'))).toBe(false);
    expect(frames.cost()?.currency).toBe('USD');
    expect(frames.answer()).toContain('Done: the folder holds');
  });

  it('claude: a step the person refused is failed, one that ran is not', () => {
    const { out } = fold('claude-permission');
    expect(of(out, 'tool.completed').map((c) => c['error'])).toEqual([false, true, true]);
    expect(of(out, 'tool.started').every((s) => s['kind'] === 'execute')).toBe(true);
  });

  it('claude: an edit carries its counts of lines, not the text', () => {
    const { out } = fold('claude-edit');
    expect(of(out, 'tool.completed').map((c) => c['diff'])).toEqual([{ added: 2, removed: 0 }, { added: 1, removed: 1 }]);
    expect(of(out, 'step.update').map((s) => s['paths'])).toEqual([['edit-me.txt'], ['edit-me.txt']]);
    expect(JSON.stringify(out)).not.toMatch(/oldText|newText/);
  });

  it('claude: a cancelled run closes its step as failed', () => {
    const { out } = fold('claude-cancel');
    expect(of(out, 'tool.completed')).toHaveLength(1);
    expect(of(out, 'tool.completed')[0]!['error']).toBe(true);
  });

  it('codex: an edit has no locations, and the path comes from its diff block', () => {
    const { out } = fold('codex-edit');
    expect(of(out, 'tool.started').map((s) => s['paths'])).toEqual([['edit-me.txt'], ['edit-me.txt']]);
    expect(of(out, 'tool.completed').map((c) => c['diff'])).toEqual([{ added: 2, removed: 0 }, { added: 1, removed: 1 }]);
  });

  it('codex: the steps of one run, its helper as start and complete steps, and the platform\'s tool by name', () => {
    const { out } = fold('codex-work');
    expect(of(out, 'tool.started').map((s) => s['title'])).toEqual(['List files', "Read file 'package.json'", 'mcp__manythreads__mt_note', 'wait']);
    const helper = of(out, 'agent.update');
    expect(helper.map((a) => a['status'])).toEqual(['working', 'done']);
    expect(helper[0]!['name']).toBe('read package name');
    // "Start subagent" and "Complete subagent" are the helper, not two steps of the list
    expect(JSON.stringify(of(out, 'tool.started'))).not.toContain('subagent');
  });

  it('codex: the request to implement a plan, ended with an update of its own, is not a step', () => {
    const { out } = fold('codex-plan');
    expect(of(out, 'tool.started').every((s) => s['title'] !== '')).toBe(true);
    expect(JSON.stringify(out)).not.toContain('plan-review');
  });

  it('hermes: the plan is the todo list the agent keeps, "thinking" is a mark, and what Hermes loads for itself is hidden', () => {
    const { out } = fold('hermes-work');
    expect(of(out, 'plan.update').map((p) => p['entries'].map((e: Out) => e['status']))).toEqual([['in_progress', 'pending'], ['completed', 'completed']]);
    expect(of(out, 'tool.started').map((s) => s['tool'])).toEqual(['search', 'read', 'mcp__manythreads__mt_note']);
    expect(of(out, 'thinking').length).toBeGreaterThan(0);
    // two reads at once end in the order they finish: each closes its own step
    expect(of(out, 'tool.completed').map((c) => c['step_id']).sort()).toEqual(of(out, 'tool.started').map((s) => s['step_id']).sort());
  });

  it('hermes: paths in the run folder are made relative, those outside are not named', () => {
    const { out } = fold('hermes-work');
    expect(of(out, 'tool.started').find((s) => s['kind'] === 'read')!['paths']).toEqual(['package.json']);
    expect(relativePath('/etc/passwd', '/work/demo')).toBe('a file outside the project');
    expect(relativePath('/work/demo/src/a.ts', '/work/demo')).toBe('src/a.ts');
    expect(relativePath('/work/demo', '/work/demo')).toBe('.');
  });

  it('never carries what the adapters leak', () => {
    const forbidden = /rawInput|rawOutput|toolResponse|terminal_output|terminal_exit|"content":\{/;
    for (const name of ['claude-work', 'claude-permission', 'claude-edit', 'codex-work', 'codex-edit', 'codex-plan', 'codex-permission-exec', 'hermes-work', 'hermes-resume-load']) {
      expect(JSON.stringify(fold(name).out), name).not.toMatch(forbidden);
    }
  });

  it('puts a secret out of every title and path before they are cut', () => {
    const view = viewOf({ toolCallId: 'a', title: 'curl -H "Authorization: Bearer run-token-SECRET-12345" https://x', kind: 'execute' }, { cwd: CWD, secrets: ['run-token-SECRET-12345'] });
    expect(view!.title).not.toContain('SECRET');
    expect(clipText('x'.repeat(500), 160, [])).toHaveLength(160);
    // a secret that sits across the cut is gone too: redaction comes first
    expect(clipText(`${'a'.repeat(150)}run-token-SECRET-12345`, 160, ['run-token-SECRET-12345'])).not.toContain('SECRET');
  });

  it('ignores a kind of update it does not know, and one that is not an update', () => {
    const out: Out[] = [];
    const f = new Frames({ cwd: CWD, secrets: [], emit: (event, fields) => out.push({ event, ...fields }) });
    for (const u of [{ sessionUpdate: 'available_commands_update', availableCommands: [] }, { sessionUpdate: 'session_info_update', title: 'x' }, { sessionUpdate: 'config_option_update', configOptions: [] }, { sessionUpdate: 'a_new_one' }, null, 'text', 4, {}]) f.update(u);
    f.finish(false);
    expect(out).toEqual([]);
  });

  it('counts the lines of a diff as a multiset', () => {
    expect(diffCounts(null, 'a\nb')).toEqual({ added: 2, removed: 0 });
    expect(diffCounts('a\nb', 'a\nc')).toEqual({ added: 1, removed: 1 });
    expect(diffCounts('a', 'a')).toEqual({ added: 0, removed: 0 });
  });

  it('hides the steps that only load or check things for the agent', () => {
    expect(isHiddenStep({ toolName: '', rawTitle: 'tool_search: edit' })).toBe(true);
    expect(isHiddenStep({ toolName: '', rawTitle: 'tool_describe: x' })).toBe(true);
    expect(isHiddenStep({ toolName: 'SubagentHandback', rawTitle: '' })).toBe(true);
    expect(isHiddenStep({ toolName: '', rawTitle: 'Guardian Review' })).toBe(true);
    expect(isHiddenStep({ toolName: 'Read', rawTitle: 'Read File' })).toBe(false);
  });
});

describe('the answers to a permission request, chosen by kind from the recorded requests', () => {
  const requests = (name: string): Array<{ options: PermissionOption[]; toolCall: Record<string, any>; _meta?: Record<string, any> }> => // eslint-disable-line @typescript-eslint/no-explicit-any
    fixture(name)
      .filter((l) => l.msg['method'] === 'session/request_permission')
      .map((l) => l.msg['params']);

  it('claude: allow-once and reject', () => {
    for (const r of requests('claude-permission')) {
      expect(optionFor(r.options, 'once')?.optionId).toBe('allow-once');
      expect(optionFor(r.options, 'deny')?.optionId).toBe('reject');
    }
  });

  it('codex: allow_once and cancel, four options for a call of an MCP tool, with the flag on the request', () => {
    const [mcp] = requests('codex-work');
    expect(mcp!.options).toHaveLength(4);
    expect(mcp!._meta).toEqual({ is_mcp_tool_approval: true });
    expect(mcp!.toolCall['_meta']).toBeUndefined();
    expect(optionFor(mcp!.options, 'once')?.optionId).toBe('allow_once');
    expect(optionFor(mcp!.options, 'deny')?.optionId).toBe('cancel');
    // "for this session" is chosen by its own id, and never "always"
    expect(sessionOption(mcp!.options)?.optionId).toBe('allow_session');
    const [, exec] = requests('codex-plan');
    expect(optionFor(exec!.options, 'once')?.optionId).toBe('allow_once');
    expect(optionFor(exec!.options, 'deny')?.optionId).toBe('cancel');
  });

  it('a request that offers no No still can be answered, and one that offers no Yes cannot be allowed', () => {
    expect(optionFor([{ optionId: 'x', kind: 'allow_always' }], 'once')).toBeNull();
    expect(optionFor([{ optionId: 'y', kind: 'allow_once' }], 'deny')).toBeNull();
  });

  it('hermes: its ids are its own (`deny`, not `reject`), found by kind', () => {
    const options: PermissionOption[] = [
      { optionId: 'allow_once', kind: 'allow_once' },
      { optionId: 'allow_session', kind: 'allow_always' },
      { optionId: 'allow_always', kind: 'allow_always' },
      { optionId: 'deny', kind: 'reject_once' },
      { optionId: 'deny_always', kind: 'reject_always' },
    ];
    expect(optionFor(options, 'once')?.optionId).toBe('allow_once');
    expect(optionFor(options, 'deny')?.optionId).toBe('deny');
  });
});

describe('opening a session', () => {
  it('knows a session the adapter lost, by each adapter\'s own error', () => {
    expect(isMissingSession(new RequestError(-32002, 'Resource not found'))).toBe(true);
    expect(isMissingSession(new RequestError(-32603, 'Internal error', { details: 'no rollout found for thread id abc' }))).toBe(true);
    expect(isMissingSession(new RequestError(-32603, 'Internal error', { details: 'the disk is full' }))).toBe(false);
    expect(isMissingSession(new Error('no rollout found'))).toBe(false);
  });

  it('hermes answers success for an unknown id; a session that exists carries its provenance', () => {
    const resume = fixture('hermes-resume-load').filter((l) => l.dir === 'a2c' && l.msg['result'] !== undefined && l.msg['result']['_meta']?.hermes);
    expect(resume.length).toBeGreaterThan(0);
    for (const l of resume) expect(isFound('hermes', l.msg['result'])).toBe(true);
    expect(isFound('hermes', {})).toBe(false);
    expect(isFound('hermes', { modes: {} })).toBe(false);
    expect(isFound('claude', {})).toBe(true);
    expect(isFound('codex', { modes: {} })).toBe(true);
  });

  it('what the recorded adapters offered: set the mode by `session/set_mode`; Claude starts in auto and has `default`', () => {
    const created = fixture('claude-init-ours').find((l) => l.dir === 'a2c' && l.msg['result']?.modes)!.msg['result'];
    expect(created.modes.currentModeId).toBe('auto');
    expect(created.modes.availableModes.map((m: { id: string }) => m.id)).toContain('default');
    const codex = fixture('codex-init-ours').find((l) => l.dir === 'a2c' && l.msg['result']?.modes)!.msg['result'];
    expect(codex.modes.availableModes.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining(['read-only', 'workspace-write']));
    expect(codex.configOptions.map((o: { id: string }) => o.id)).toContain('mode');
  });
});

// ---- the adapter module ---------------------------------------------------------------------------------------------------------------

function jobOf(agent: string, over: Record<string, unknown> = {}, request: Record<string, unknown> = {}, baseEnv: NodeJS.ProcessEnv = {}): DriverJob {
  const config = parseConfig({ profiles: { default: { agent, workdir: '/work/demo', ...over } }, bin: { claude: '/opt/claude', codex: 'codex' } });
  return {
    profileName: 'default',
    profile: config.profiles['default']!,
    config,
    baseEnv: () => ({ ...baseEnv }),
    request: { input: 'hi', instructions: null, sessionId: null, manythreads: { tools: ['files'], mcp: { url: 'https://x.test/mcp', token: 'tok-SECRET' }, model: { alias: null, effort: null }, ...((request['manythreads'] as object) ?? {}) }, ...request },
  } as unknown as DriverJob;
}

describe('the adapter module', () => {
  it('names the program of each adapter, and takes the profile\'s own', () => {
    expect(adapterCommand(jobOf('claude-code').profile)).toEqual({ command: 'claude-agent-acp', args: [] });
    expect(adapterCommand(jobOf('codex').profile)).toEqual({ command: 'codex-acp', args: [] });
    expect(adapterCommand(jobOf('hermes-acp').profile)).toEqual({ command: 'hermes', args: ['acp'] });
    expect(adapterCommand(jobOf('opencode').profile)).toEqual({ command: 'opencode', args: ['acp'] });
    expect(adapterCommand(jobOf('claude-code', { acp: { command: '/opt/bin/adapter', args: ['--x'] } }).profile)).toEqual({ command: '/opt/bin/adapter', args: ['--x'] });
    expect(flavorOf('opencode')).toBe('opencode');
  });

  it('the mode is the grant: Claude is put in default, Codex follows the tools, the others are left', () => {
    expect(desiredMode(jobOf('claude-code'))).toBe('default');
    expect(desiredMode(jobOf('codex'))).toBe('workspace-write');
    expect(desiredMode(jobOf('codex', {}, { manythreads: { tools: ['web'] } }))).toBe('read-only');
    expect(desiredMode(jobOf('codex', {}, { manythreads: { tools: ['shell'] } }))).toBe('workspace-write');
    expect(desiredMode(jobOf('hermes-acp'))).toBeNull();
    expect(desiredMode(jobOf('opencode'))).toBeNull();
  });

  it('points the adapter at the bridge\'s own claude and codex when `bin` is a path, and keeps the token out of its environment', () => {
    const env = adapterEnv(jobOf('claude-code', {}, {}, { PATH: '/bin' }), 'default');
    expect(env['CLAUDE_CODE_EXECUTABLE']).toBe('/opt/claude');
    expect(JSON.stringify(env)).not.toContain('SECRET');
    expect(adapterEnv(jobOf('codex'), 'read-only')['INITIAL_AGENT_MODE']).toBe('read-only');
    expect(adapterEnv(jobOf('codex'), 'read-only')['CODEX_PATH']).toBeUndefined(); // `codex` on PATH is not a path
    expect(adapterEnv(jobOf('hermes-acp'), null)['INITIAL_AGENT_MODE']).toBeUndefined();
  });

  it('claude: the CLI driver\'s grants as the adapter\'s options, with the helper and plan tools, and no settings, memory or connectors of the operator', () => {
    const meta = sessionMeta(jobOf('claude-code')) as { claudeCode: { options: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const o = meta.claudeCode.options;
    expect(o['settingSources']).toEqual([]);
    expect(o['extraArgs']).toEqual({ restricted: null, 'strict-mcp-config': null });
    expect(o['allowDangerouslySkipPermissions']).toBe(false);
    for (const t of ['Agent', 'TaskCreate', 'TaskUpdate', 'TaskList']) {
      expect(o['tools']).toContain(t);
      expect(o['allowedTools']).toContain(t);
    }
    expect(sessionMeta(jobOf('codex'))).toBeUndefined();
    expect(sessionMeta(jobOf('hermes-acp'))).toBeUndefined();
  });

  it('gives the run\'s endpoint as an HTTP server with a bearer header, and nothing when the run has none', () => {
    expect(mcpServers(jobOf('claude-code'))).toEqual([{ type: 'http', name: 'manythreads', url: 'https://x.test/mcp', headers: [{ name: 'Authorization', value: 'Bearer tok-SECRET' }] }]);
    expect(mcpServers(jobOf('claude-code', {}, { manythreads: { mcp: null } }))).toEqual([]);
  });

  it('the model and the effort are config options, by each adapter\'s own ids', () => {
    expect(wantedOptions(jobOf('codex', { model: 'gpt-5.4' }, { manythreads: { model: { alias: null, effort: 'high' } } }))).toEqual([
      { configId: 'model', value: 'gpt-5.4', pinned: true },
      { configId: 'reasoning_effort', value: 'high', pinned: false },
    ]);
    expect(wantedOptions(jobOf('claude-code', { model: 'sonnet' }, { manythreads: { model: { alias: null, effort: 'low' } } }))).toEqual([
      { configId: 'model', value: 'sonnet', pinned: true },
      { configId: 'effort', value: 'low', pinned: false },
    ]);
    expect(wantedOptions(jobOf('claude-code', { model: 'sonnet', modelAliases: { fast: 'haiku' } }, { manythreads: { model: { alias: 'fast', effort: null } } }))).toEqual([{ configId: 'model', value: 'haiku', pinned: true }]);
    // Hermes takes its model from its own home: a model the profile pins is still wanted (and the run fails, as the adapter offers no such option); an unknown effort is not sent
    expect(wantedOptions(jobOf('hermes-acp', { model: 'x' }, { manythreads: { model: { alias: null, effort: 'high' } } }))).toEqual([{ configId: 'model', value: 'x', pinned: true }]);
    expect(wantedOptions(jobOf('codex', {}, { manythreads: { model: { alias: null, effort: 'enormous' } } }))).toEqual([]);
  });
});

describe('the profile\'s driver', () => {
  const parse = (p: Record<string, unknown>) => parseConfig({ profiles: { a: p } }).profiles['a']!;
  it('is the CLI for Claude and Codex unless the profile says acp, and acp for the others', () => {
    expect(parse({ agent: 'claude-code', workdir: '/w' }).driver).toBe('cli');
    expect(parse({ agent: 'codex', workdir: '/w', driver: 'acp' }).driver).toBe('acp');
    expect(parse({ agent: 'hermes-acp', workdir: '/w' }).driver).toBe('acp');
    expect(parse({ agent: 'opencode', workdir: '/w', acp: { command: '/x/opencode', args: ['acp'] } }).acp).toEqual({ command: '/x/opencode', args: ['acp'] });
  });

  it('refuses what cannot be: a driver word that is not one, a CLI for an agent that has none, a bad acp block', () => {
    expect(() => parse({ agent: 'claude-code', workdir: '/w', driver: 'rpc' })).toThrow(/driver must be/);
    expect(() => parse({ agent: 'hermes-acp', workdir: '/w', driver: 'cli' })).toThrow(/only driven through ACP/);
    expect(() => parse({ agent: 'codex', workdir: '/w', acp: 'x' })).toThrow(/acp must be an object/);
    expect(() => parse({ agent: 'codex', workdir: '/w', acp: { args: [1] } })).toThrow(/acp.args/);
  });
});
