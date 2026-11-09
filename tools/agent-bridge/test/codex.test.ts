import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexArgs, toml } from '../src/drivers/codex.ts';
import type { DriverJob } from '../src/drivers/types.ts';
import { events, harness, start, type Harness } from './support.ts';

// Against a fake `codex`: this checks the bridge's mapping of the documented JSON lines, NOT a real Codex install.

let h: Harness;
beforeEach(async () => {
  h = await harness({}, 'codex');
});
afterEach(async () => {
  await h.close();
});

const mcp = { url: 'https://example.test/mcp', token: 'run-token-SECRET-12345' };

describe('the codex driver', () => {
  it('maps the JSON lines to gateway events', async () => {
    const { run_id } = (await (await start(h, { input: 'hello', manythreads: { tools: ['files'], mcp } })).json()) as { run_id: string };
    const evs = await events(h, run_id);
    expect(evs.map((e) => e.data['event'])).toEqual(['tool.started', 'tool.completed', 'tool.started', 'tool.completed', 'message.delta', 'run.completed']);
    expect(evs[0]!.data).toMatchObject({ tool: 'shell', preview: 'ls' });
    expect(evs[1]!.data).toMatchObject({ tool: 'shell', error: false });
    expect(evs[3]!.data).toMatchObject({ tool: 'mcp__manythreads__post', error: true });
    expect(evs[5]!.data).toMatchObject({ output: 'All done.', usage: { input_tokens: 20, output_tokens: 7, total_tokens: 27 } });
  });

  it('picks the sandbox from the grants, puts the prompt on stdin and the token only in the environment', async () => {
    for (const [tools, sandbox] of [[[], 'read-only'], [['files'], 'workspace-write'], [['shell'], 'workspace-write'], [['web'], 'read-only']] as const) {
      const { run_id } = (await (await start(h, { input: 'the prompt', instructions: 'BOT body', manythreads: { tools: [...tools], mcp } })).json()) as { run_id: string };
      await events(h, run_id);
      const call = h.calls().at(-1)!;
      const argv = call['argv'] as string[];
      expect(argv.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
      expect(argv).toContain(`sandbox_mode="${sandbox}"`);
      expect(argv).toContain('mcp_servers.manythreads.url="https://example.test/mcp"');
      expect(argv).toContain('mcp_servers.manythreads.bearer_token_env_var="MANYTHREADS_RUN_TOKEN"');
      expect(argv).toContain('developer_instructions="BOT body"');
      expect(argv.at(-1)).toBe('-');
      expect(argv.join(' ')).not.toContain(mcp.token);
      expect(argv.join(' ')).not.toContain('the prompt');
      expect(argv).not.toContain('danger-full-access');
      expect(argv.join(' ')).not.toContain('bypass');
      expect(call['stdin']).toBe('the prompt');
      expect(call['token']).toBe(mcp.token);
      expect(call['hasBridgeKey']).toBe(false);
    }
  });

  it('starts a thread, then resumes it by the id Codex gave', async () => {
    for (let i = 0; i < 2; i++) {
      const { run_id } = (await (await start(h, { input: `turn ${i}`, session_id: 's1' })).json()) as { run_id: string };
      expect((await events(h, run_id)).at(-1)!.data['event']).toBe('run.completed');
    }
    const [first, second] = h.calls().map((c) => c['argv'] as string[]);
    expect(first).not.toContain('resume');
    expect(second!.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(second).toContain('thread-abc');
  });
});

describe('codex hardening', () => {
  it('redacts the run token from the final output', async () => {
    const { run_id } = (await (await start(h, { input: 'ECHOTOKEN', manythreads: { mcp } })).json()) as { run_id: string };
    const done = (await events(h, run_id)).at(-1)!.data;
    expect(done['output']).toBe('All done. token=[hidden]');
  });

  it('keeps unrelated variables away from the child', async () => {
    process.env['GITHUB_TOKEN'] = 'ghp_nope';
    try {
      const { run_id } = (await (await start(h, { input: 'hello' })).json()) as { run_id: string };
      await events(h, run_id);
      expect(h.calls().at(-1)!['githubToken']).toBeNull();
    } finally {
      delete process.env['GITHUB_TOKEN'];
    }
  });

  it('writes TOML basic strings: escapes, control characters, lone surrogates', () => {
    expect(toml('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
    expect(toml('\u0001\u007f')).toBe('"\\u0001\\u007F"');
    expect(toml('x\ud800y')).toBe('"x\\uFFFDy"');
    expect(toml('\udc00')).toBe('"\\uFFFD"');
    expect(toml('\u{1F600}')).toBe('"\u{1F600}"');
  });

  it('passes instructions over 4 KB on stdin, not in argv', async () => {
    const big = 'RULE '.repeat(1000);
    const { run_id } = (await (await start(h, { input: 'the prompt', instructions: big })).json()) as { run_id: string };
    await events(h, run_id);
    const call = h.calls().at(-1)!;
    expect((call['argv'] as string[]).join(' ')).not.toContain('developer_instructions');
    expect(call['stdin']).toBe(`${big}\n\n---\n\nthe prompt`);
    expect(typeof codexArgs).toBe('function');
  });
});

// ---- the flags, against docs/spikes/codex-flags.md (P19-13) ------------------------------------------------------------------------------------------------------
// That page holds the two flag lists the driver is meant to use and the program's own `--help` text for `exec` and `exec resume` (codex-cli 0.166.0). This keeps the three in
// step: the flags `codexArgs` builds, the lists, and the help. It checks flag NAMES only; the config keys behind `-c` cannot be read from help text.

const DOC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'spikes', 'codex-flags.md'), 'utf8');
const section = (heading: string): string => {
  const at = DOC.indexOf(`## ${heading}`);
  expect(at, heading).toBeGreaterThan(-1);
  const open = DOC.indexOf('```text\n', at) + '```text\n'.length;
  return DOC.slice(open, DOC.indexOf('\n```', open));
};
const listed = (key: string): string[] => {
  const m = new RegExp(`^${key}: (.+)$`, 'm').exec(DOC);
  expect(m, key).not.toBeNull();
  return m![1]!.trim().split(/\s+/).sort();
};
const flagsOf = (args: string[]): string[] => [...new Set(args.filter((a) => /^-[A-Za-z-]/.test(a)))].sort();
const mentioned = (help: string, flag: string): boolean => new RegExp(`(^|[\\s,])${flag.replace(/[-]/g, '\\-')}(?=[,\\s<]|$)`, 'm').test(help);

// every option the driver can add at once: files and shell grants, instructions, the platform's MCP address, a model alias
const fullJob = (): DriverJob =>
  ({
    request: { instructions: 'rules', input: 'go', sessionId: 's', manythreads: { tools: ['files', 'shell'], mcp: { url: 'https://example.test/mcp', token: 't' }, model: { alias: 'smart' } } },
    profile: { agent: 'codex', workdir: '/work', model: 'base-model', modelAliases: { smart: 'mapped-model' } },
  }) as unknown as DriverJob;

describe('codexArgs against docs/spikes/codex-flags.md', () => {
  it('builds exactly the flags the page lists, for a new thread and for a resumed one', () => {
    const fresh = codexArgs(fullJob(), null, true);
    const resumed = codexArgs(fullJob(), 'thread-1', true);
    expect(flagsOf(fresh)).toEqual(listed('flags-exec'));
    expect(flagsOf(resumed)).toEqual(listed('flags-resume'));
  });

  it('every flag it builds is in the program\'s own help text for that subcommand', () => {
    const exec = section('Help output: codex exec');
    const resume = section('Help output: codex exec resume');
    expect(exec).toContain('Usage: codex exec [OPTIONS] [PROMPT]');
    expect(resume).toContain('Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]');
    for (const f of flagsOf(codexArgs(fullJob(), null, true))) expect(mentioned(exec, f), `exec: ${f}`).toBe(true);
    for (const f of flagsOf(codexArgs(fullJob(), 'thread-1', true))) expect(mentioned(resume, f), `resume: ${f}`).toBe(true);
    // the page's own claims: `resume` is a subcommand of exec, and only exec has -C and -s
    expect(exec).toMatch(/^\s+resume\s/m);
    expect(mentioned(exec, '-C') && mentioned(exec, '-s')).toBe(true);
    expect(mentioned(resume, '-C') || mentioned(resume, '-s')).toBe(false);
  });

  it('reads the prompt from stdin: "-" last, after the thread id on a resume; and a resume names the thread, never --last', () => {
    expect(codexArgs(fullJob(), null, true).at(-1)).toBe('-');
    expect(codexArgs(fullJob(), 'thread-1', true).slice(-2)).toEqual(['thread-1', '-']);
    expect(codexArgs(fullJob(), 'thread-1', true)).not.toContain('--last');
    expect(mentioned(section('Help output: codex exec resume'), '--last')).toBe(true);
  });

  it('never sets a flag the page says is not used on purpose', () => {
    const all = [...codexArgs(fullJob(), null, true), ...codexArgs(fullJob(), 'x', false)];
    for (const banned of ['-s', '--sandbox', '--dangerously-bypass-approvals-and-sandbox', '--ephemeral', '--oss', '--approve-for-me']) expect(all, banned).not.toContain(banned);
  });

  it('the page names the CLI version it was captured from, and the check against a real install is still open', () => {
    expect(DOC).toMatch(/codex-cli \d+\.\d+\.\d+/);
    expect(DOC).toContain('[owner test]');
  });
});
