import { mkdtempSync, openSync, readSync, rmSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type OomScoreFile, parseArgv, parseHelperConfig, programFor, raiseForChild, readFirstLine, RUN_OOM_SCORE, setprivArgv, SH_EXEC, SH_MKDIR, SH_PUT, SH_RM } from '../src/team-helper.ts';

// The root helper's own checks (P26-22). What it does as root needs root and is run by the container test (install/container-test/run.sh); here are the parts that decide WHAT it will do.

describe('the helper\'s arguments (after the sudoers rule matched its words)', () => {
  it('takes exactly ensure-user <team> and run <team> <kind>', () => {
    expect(parseArgv(['ensure-user', 'eng'])).toEqual({ ok: true, command: 'ensure-user', team: 'eng' });
    for (const kind of ['claude', 'codex', 'hermes', 'sync', 'clean-kube']) expect(parseArgv(['run', 'eng', kind])).toEqual({ ok: true, command: 'run', team: 'eng', kind });
  });
  it.each([
    [[]],
    [['run']],
    [['run', 'eng']],
    [['run', 'eng', 'bash']],
    [['run', 'eng', 'claude', '--extra']],
    [['run', 'eng', 'claude', 'codex']],
    [['run', '../etc', 'claude']],
    [['run', 'Eng', 'claude']],
    [['run', '', 'claude']],
    [['run', 'a b', 'claude']],
    [['run', '-rf', 'claude']],
    [['ensure-user']],
    [['ensure-user', 'eng', 'extra']],
    [['ensure-user', 'a;b']],
    [['ensure-user', 'x'.repeat(64)]],
    [['delete-user', 'eng']],
    [['exec', 'eng', 'claude']],
    [['--help']],
    [['sh', '-c', 'id']],
  ])('refuses %j', (argv) => {
    expect(parseArgv(argv as string[])).toMatchObject({ ok: false });
  });
});

describe('the table the installer writes', () => {
  const good = { dataRoot: '/var/lib/manythreads-bridge', agents: { claude: { command: '/opt/acp/claude-agent-acp' }, hermes: { command: '/opt/h/hermes', args: ['acp'] } }, syncScript: '/opt/manythreads-bridge/current/tools/repo-sync.sh', publisherGroup: 'manythreads-publisher' };
  it('parses, with no arguments by default', () => {
    const cfg = parseHelperConfig(JSON.stringify(good));
    expect(cfg.agents.claude).toEqual({ command: '/opt/acp/claude-agent-acp', args: [] });
    expect(cfg.agents.hermes).toEqual({ command: '/opt/h/hermes', args: ['acp'] });
    expect(cfg.publisherGroup).toBe('manythreads-publisher');
  });
  it('names the group that may open the publisher\'s socket, and refuses a name that is not a group name', () => {
    expect(parseHelperConfig(JSON.stringify({ ...good, publishClientsGroup: 'mt-publish' })).publishClientsGroup).toBe('mt-publish');
    expect(parseHelperConfig(JSON.stringify(good)).publishClientsGroup).toBeUndefined();
    expect(() => parseHelperConfig(JSON.stringify({ ...good, publishClientsGroup: 'a b' }))).toThrow();
  });
  it.each([
    ['text that is not JSON', 'nope'],
    ['no data root', JSON.stringify({ ...good, dataRoot: undefined })],
    ['a relative data root', JSON.stringify({ ...good, dataRoot: 'var/lib' })],
    ['an unknown agent', JSON.stringify({ ...good, agents: { gemini: { command: '/x' } } })],
    ['a relative command', JSON.stringify({ ...good, agents: { claude: { command: 'claude-agent-acp' } } })],
    ['an argument that is not text', JSON.stringify({ ...good, agents: { claude: { command: '/x', args: [1] } } })],
    ['a relative sync script', JSON.stringify({ ...good, syncScript: 'repo-sync.sh' })],
    ['a group name with a space', JSON.stringify({ ...good, publisherGroup: 'a b' })],
  ])('refuses %s', (_w, text) => {
    expect(() => parseHelperConfig(text)).toThrow();
  });
});

describe('the program a kind starts: from the table, never from the bridge', () => {
  const cfg = parseHelperConfig(JSON.stringify({ dataRoot: '/d', agents: { claude: { command: '/a/claude-agent-acp' }, hermes: { command: '/a/hermes', args: ['acp'] } }, syncScript: '/t/repo-sync.sh' }));
  it('adapters come from the table with their own arguments', () => {
    expect(programFor(cfg, 'claude')).toEqual({ argv: ['/a/claude-agent-acp'], umask: '0007' });
    expect(programFor(cfg, 'hermes')).toEqual({ argv: ['/a/hermes', 'acp'], umask: '0007' });
  });
  it('the sync is the pod\'s script under sh, with the stricter umask; clean-kube starts nothing', () => {
    expect(programFor(cfg, 'sync')).toEqual({ argv: ['/bin/sh', '/t/repo-sync.sh'], umask: '0027' });
    expect(programFor(cfg, 'clean-kube')).toBeNull();
  });
  it('an agent this machine does not have is a plain sentence', () => {
    expect(() => programFor(cfg, 'codex')).toThrow(/no codex agent/);
    expect(() => programFor(parseHelperConfig(JSON.stringify({ dataRoot: '/d', agents: {} })), 'sync')).toThrow(/no repository sync/);
  });
});

describe('starting a program as the team user', () => {
  it('numeric ids, the user\'s groups, a parent-death signal, and the program after `--`', () => {
    expect(setprivArgv('/usr/bin/setpriv', 990, 991, ['/bin/sh', '-c', 'x'])).toEqual(['/usr/bin/setpriv', '--reuid', '990', '--regid', '991', '--init-groups', '--pdeathsig', 'SIGKILL', '--', '/bin/sh', '-c', 'x']);
  });
  it('the small programs run as the user are constants with their input as arguments, never spliced into the text', () => {
    for (const text of [SH_MKDIR, SH_PUT, SH_RM, SH_EXEC]) {
      expect(text).not.toMatch(/\$\(?(HOME|PATH)\b|\bsudo\b/);
      expect(text.length).toBeLessThan(200);
    }
    expect(SH_PUT).toContain('mv -f -- "$1.new" "$1"');
    expect(SH_RM).toBe('rm -rf -- "$@"');
  });
});

describe('the out-of-memory score of a run (P31-04: root raises it for the spawn, the helper keeps its own)', () => {
  /** A stand-in for /proc/self/oom_score_adj: what was written, in order, and what a read answers. */
  const fakeFile = (start: string, opts: { refuse?: (text: string) => boolean; ignore?: boolean } = {}) => {
    const writes: string[] = [];
    let value = start;
    const file: OomScoreFile = {
      read: () => `${value}\n`,
      write: (text) => {
        writes.push(text);
        if (opts.refuse?.(text) === true) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        if (opts.ignore !== true) value = text;
      },
    };
    return { file, writes, now: () => value };
  };

  it('writes 1000 before the spawn and the old value after it', () => {
    const f = fakeFile('0');
    const oom = raiseForChild(f.file);
    expect(RUN_OOM_SCORE).toBe(1000);
    expect(oom.raised).toBe(true);
    expect(f.now()).toBe('1000');
    expect(oom.restore()).toBe(true);
    expect(f.writes).toEqual(['1000', '0']);
    expect(f.now()).toBe('0');
  });
  it('puts back whatever value the helper had, once', () => {
    const f = fakeFile('-17');
    const oom = raiseForChild(f.file);
    expect(oom.restore()).toBe(true);
    expect(oom.restore()).toBe(true);
    expect(f.writes).toEqual(['1000', '-17']);
  });
  it('a refused write never throws, and nothing is put back that was not changed', () => {
    const f = fakeFile('0', { refuse: () => true });
    const oom = raiseForChild(f.file);
    expect(oom.raised).toBe(false);
    expect(oom.restore()).toBe(true);
    expect(f.writes).toEqual(['1000']);
  });
  it('a write the kernel did not keep counts as not raised', () => {
    const f = fakeFile('0', { ignore: true });
    expect(raiseForChild(f.file).raised).toBe(false);
  });
  it('a refused put-back is reported, not thrown', () => {
    const f = fakeFile('0', { refuse: (t) => t === '0' });
    const oom = raiseForChild(f.file);
    expect(oom.raised).toBe(true);
    expect(oom.restore()).toBe(false);
  });
  it('an unreadable or odd old value is put back as 0', () => {
    const f = fakeFile('garbage');
    raiseForChild(f.file).restore();
    expect(f.writes).toEqual(['1000', '0']);
  });
  it('is not done by the team user\'s shell (an unprivileged write would set no floor)', () => {
    expect(SH_EXEC).not.toContain('oom_score_adj');
  });
});

describe('the first line of standard input', () => {
  it('is read a byte at a time: what follows stays for the program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helper-line-'));
    try {
      const file = join(dir, 'in');
      writeFileSync(file, '{"v":1}\n{"jsonrpc":"2.0"}\nmore');
      const fd = openSync(file, 'r');
      expect(readFirstLine(fd)).toBe('{"v":1}');
      const rest = Buffer.alloc(100);
      const n = readSync(fd, rest, 0, 100, null);
      expect(rest.subarray(0, n).toString()).toBe('{"jsonrpc":"2.0"}\nmore');
      closeSync(fd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a line over the limit is refused, and an empty input is an empty line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'helper-line-'));
    try {
      const file = join(dir, 'in');
      writeFileSync(file, 'x'.repeat(50));
      const fd = openSync(file, 'r');
      expect(() => readFirstLine(fd, 10)).toThrow(/too long/);
      closeSync(fd);
      writeFileSync(file, '');
      const fd2 = openSync(file, 'r');
      expect(readFirstLine(fd2)).toBe('');
      closeSync(fd2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
