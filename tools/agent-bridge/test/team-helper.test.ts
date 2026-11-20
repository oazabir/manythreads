import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  type CodexCopyIo,
  CodexMarkers,
  codexCopyIn,
  codexSync,
  type OomScoreFile,
  parseArgv,
  parseHelperConfig,
  procStartTime,
  programFor,
  raiseForChild,
  readFirstLine,
  RUN_OOM_SCORE,
  setprivArgv,
  SH_EXEC,
  SH_MKDIR,
  SH_PRIVATE_DIR,
  SH_PUT,
  SH_READ,
  SH_READ_MISSING,
  SH_REPLACE,
  SH_RM,
  SHARED_AUTH_FOLDERS,
  withCodexLock,
} from '../src/team-helper.ts';

// The root helper's own checks (P26-22). What it does as root needs root and is run by the container test (install/container-test/run.sh); here are the parts that decide WHAT it will do.

describe('the helper\'s arguments (after the sudoers rule matched its words)', () => {
  it('takes exactly ensure-user <team> and run <team> <kind>', () => {
    expect(parseArgv(['ensure-user', 'eng'])).toEqual({ ok: true, command: 'ensure-user', team: 'eng' });
    for (const kind of ['claude', 'codex', 'hermes', 'sync', 'clean-kube', 'clean-codex']) expect(parseArgv(['run', 'eng', kind])).toEqual({ ok: true, command: 'run', team: 'eng', kind });
  });
  it('names every kind when it refuses one (clean-codex among them)', () => {
    expect(parseArgv(['run', 'eng', 'bash'])).toEqual({ ok: false, error: 'the kinds are claude, codex, hermes, sync, clean-kube and clean-codex, and nothing follows them' });
  });
  it.each([
    [[]],
    [['run']],
    [['run', 'eng']],
    [['run', 'eng', 'bash']],
    [['run', 'eng', 'claude', '--extra']],
    [['run', 'eng', 'claude', 'codex']],
    [['run', 'eng', 'clean-codex', '--all']],
    [['run', '--all', 'clean-codex']],
    [['run', 'all', 'clean-codex', 'eng']],
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
    expect(cfg.bridgeUser).toBeUndefined();
  });
  it('names the bridge\'s user (who owns the Codex main copy), never root', () => {
    expect(parseHelperConfig(JSON.stringify({ ...good, bridgeUser: 'manythreads-bridge' })).bridgeUser).toBe('manythreads-bridge');
    for (const bad of ['root', 'a b', '../x', 7]) expect(() => parseHelperConfig(JSON.stringify({ ...good, bridgeUser: bad }))).toThrow(/bridgeUser/);
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
    expect(programFor(cfg, 'clean-codex')).toBeNull();
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
    for (const text of [SH_MKDIR, SH_PUT, SH_RM, SH_EXEC, SH_PRIVATE_DIR, SH_READ, SH_REPLACE]) {
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

// ---- P31-01: the team's copy of the Codex sign-in ---------------------------------------------------------------------------------------------------------------------------

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims: Record<string, unknown>): string => `${b64({ alg: 'none' })}.${b64(claims)}.c2ln`;
const signin = (refresh: string, when: string, account = 'acct-1'): string =>
  JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: account } }), access_token: jwt({ exp: 4102444800 }), refresh_token: refresh, account_id: account }, last_refresh: when });

/** The two files as plain variables, and what was done to them. */
function fakeIo(main: string | null) {
  const files = { main, team: null as string | null, mainFails: false };
  const did: string[] = [];
  const logs: string[] = [];
  const io: CodexCopyIo = {
    readMain: () => (files.mainFails ? { kind: 'failed' } : files.main === null ? { kind: 'missing' } : { kind: 'ok', text: files.main }),
    readTeam: () => files.team,
    writeMain: (t) => {
      did.push('writeMain');
      files.main = t;
      return true;
    },
    writeTeam: (t) => {
      did.push('writeTeam');
      files.team = t;
      return true;
    },
    removeTeam: () => {
      did.push('removeTeam');
      files.team = null;
    },
    log: (l) => logs.push(l),
  };
  return { files, did, logs, io };
}

describe('the team\'s copy of the Codex sign-in (P31-01)', () => {
  const A = signin('rt-A', '2026-11-10T00:00:00Z');
  const B = signin('rt-B', '2026-11-18T00:00:00Z');
  const C = signin('rt-C', '2026-11-19T00:00:00Z');

  it('Claude\'s folder is the only one the helper keeps open to the group', () => {
    expect(SHARED_AUTH_FOLDERS).toEqual(['claude']);
  });

  it('copies the main copy in for the run; with no sign-in on the machine none is copied and a stale copy goes', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    expect(f.files.team).toBe(A);
    expect(state.base?.sha256).toMatch(/^[0-9a-f]{64}$/);
    const g = fakeIo(null);
    g.files.team = B;
    expect(codexCopyIn(g.io).base).toBeNull();
    expect(g.files.team).toBeNull();
    const h = fakeIo('{"auth_mode":"apikey","OPENAI_API_KEY":"sk-made-up"}');
    expect(codexCopyIn(h.io).base).toBeNull();
    expect(h.did).toEqual(['removeTeam']);
  });

  it('a renewal made by the run goes back to the main copy, once, as a file rebuilt from the known fields (the team\'s copy gets the same file)', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    const extra = JSON.parse(B) as Record<string, unknown>;
    extra['planted'] = 'x';
    f.files.team = JSON.stringify(extra);
    codexSync(state, f.io);
    const main = JSON.parse(f.files.main!) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(main.tokens.refresh_token).toBe('rt-B');
    expect(main['planted']).toBeUndefined();
    expect(f.files.team).toBe(f.files.main);
    codexSync(state, f.io);
    expect(f.did.filter((d) => d === 'writeMain')).toHaveLength(1);
    expect(f.logs).toEqual([]);
  });

  it('a main copy that could not be read (a timeout, a failed start) keeps the run\'s copy and decides nothing; only a missing one is a sign-out', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    f.files.mainFails = true;
    f.files.team = B;
    codexSync(state, f.io);
    expect(f.files.team).toBe(B);
    expect(state.base).not.toBeNull();
    expect(f.did).toEqual(['writeTeam']);
    // the next look, with the main copy readable again, copies the renewal back
    f.files.mainFails = false;
    codexSync(state, f.io);
    expect(JSON.parse(f.files.main!).tokens.refresh_token).toBe('rt-B');
    // a main copy that is there but not a sign-in (half written) decides nothing either
    const g = fakeIo(A);
    const s2 = codexCopyIn(g.io);
    g.files.main = '{"half":';
    codexSync(s2, g.io);
    expect(g.files.team).toBe(A);
  });

  it('a renewal dated in the future is refused and never spreads; a main copy dated in the future is repaired by a real renewal and is not pushed to others', () => {
    const now = Date.parse('2026-11-20T12:00:00Z');
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    f.files.team = signin('rt-F', '9999-01-01T00:00:00Z');
    codexSync(state, f.io, now);
    expect(f.files.main).toBe(A);
    expect(f.logs).toEqual(['a team\'s Codex copy is dated in the future; it was not copied back']);
    // a broken main copy from the future: another run's look does not take it as newer, and a real renewal replaces it
    const future = signin('rt-Q', '9999-01-01T00:00:00Z');
    const g = fakeIo(future);
    const s2 = codexCopyIn(g.io);
    g.files.team = signin('rt-R', '2026-11-20T11:00:00Z');
    codexSync(s2, g.io, now);
    expect(JSON.parse(g.files.main!).tokens.refresh_token).toBe('rt-R');
    const h = fakeIo(A);
    const s3 = codexCopyIn(h.io);
    h.files.main = signin('rt-Q', '9999-01-01T00:00:00Z');
    codexSync(s3, h.io, now);
    expect(h.files.team).toBe(A);
  });

  it('nothing changed: nothing is written', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    codexSync(state, f.io);
    expect(f.did).toEqual(['writeTeam']);
  });

  it('a main copy renewed by another run comes into this run\'s copy (Codex reads auth.json again before it renews)', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    f.files.main = B;
    codexSync(state, f.io);
    expect(f.files.team).toBe(B);
    // and a renewal from there is copied back as usual
    f.files.team = C;
    codexSync(state, f.io);
    expect(JSON.parse(f.files.main!).tokens.refresh_token).toBe('rt-C');
  });

  it('a sign-out (main copy gone) or a sign-in of another account removes the run\'s copy, and nothing is copied back after', () => {
    for (const after of [null, signin('rt-Z', '2026-11-19T00:00:00Z', 'acct-2')]) {
      const f = fakeIo(A);
      const state = codexCopyIn(f.io);
      f.files.main = after;
      codexSync(state, f.io);
      expect(f.files.team).toBeNull();
      expect(state.base).toBeNull();
      f.files.team = B;
      codexSync(state, f.io);
      expect(f.files.main).toBe(after);
    }
  });

  it('two runs renewed at once: the main copy keeps the first, the line says so once, and the second run is given the first when it is newer', () => {
    const f = fakeIo(A);
    const state = codexCopyIn(f.io);
    f.files.main = C; // another run renewed first, to a later time
    f.files.team = B; // this run renewed too
    codexSync(state, f.io, Date.parse('2026-11-20T00:00:00Z'));
    codexSync(state, f.io, Date.parse('2026-11-20T00:00:00Z'));
    expect(f.files.main).toBe(C);
    expect(f.logs.filter((l) => l.includes('two runs renewed the Codex sign-in at once'))).toHaveLength(1);
    expect(f.files.team).toBe(C);
  });

  it('a copy that names another account, is not a login, or is gone is never copied back, and is logged once', () => {
    for (const bad of [signin('rt-X', '2026-11-19T00:00:00Z', 'acct-2'), 'garbage', null]) {
      const f = fakeIo(A);
      const state = codexCopyIn(f.io);
      f.files.team = bad;
      codexSync(state, f.io);
      codexSync(state, f.io);
      expect(f.files.main).toBe(A);
      expect(f.did).not.toContain('writeMain');
      expect(f.logs).toHaveLength(1);
    }
  });

  it('two runs of one team share the copy: the second sees the first one\'s write-back and takes it as its own', () => {
    const f = fakeIo(A);
    const first = codexCopyIn(f.io);
    const second = codexCopyIn(f.io);
    f.files.team = B;
    codexSync(first, f.io);
    codexSync(second, f.io);
    expect(JSON.parse(f.files.main!).tokens.refresh_token).toBe('rt-B');
    expect(second.base?.sha256).toBe(first.base?.sha256);
    expect(f.logs).toEqual([]);
  });
});

describe('the small programs of the Codex copy, run for real (as this user)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'helper-sh-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (snippet: string, args: string[], input?: string) => spawnSync('/bin/sh', ['-c', snippet, 'sh', ...args], { encoding: 'utf8', timeout: 10_000, ...(input !== undefined ? { input } : {}) });

  it('SH_READ answers a file, one byte over the limit of a big one, and gives up on a FIFO within its two seconds', () => {
    writeFileSync(join(dir, 'auth.json'), '{"a":1}');
    expect(sh(SH_READ, [join(dir, 'auth.json')]).stdout).toBe('{"a":1}');
    writeFileSync(join(dir, 'big'), 'x'.repeat(100_000));
    expect(sh(SH_READ, [join(dir, 'big')]).stdout.length).toBe(64 * 1024 + 1);
    expect(sh(SH_READ, [join(dir, 'missing')]).status).toBe(SH_READ_MISSING);
    spawnSync('ln', ['-s', join(dir, 'nowhere'), join(dir, 'dangling')]);
    expect(sh(SH_READ, [join(dir, 'dangling')]).status).not.toBe(SH_READ_MISSING);
    expect(spawnSync('mkfifo', [join(dir, 'fifo')]).status).toBe(0);
    const t0 = Date.now();
    const r = sh(SH_READ, [join(dir, 'fifo')]);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(SH_READ_MISSING);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('SH_REPLACE puts a new 0600 file in place in one step and leaves no temporary file', () => {
    const f = join(dir, 'main.json');
    writeFileSync(f, 'old');
    expect(sh(SH_REPLACE, [f], 'new').status).toBe(0);
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(existsSync(`${f}.new`)).toBe(false);
  });

  it('SH_PRIVATE_DIR makes the Codex home 0700 and fixes one made with other bits, the setgid bit too', () => {
    const home = join(dir, 'team', '.codex');
    mkdirSync(home, { recursive: true });
    spawnSync('chmod', ['2755', home]);
    expect(statSync(home).mode & 0o7777).toBe(0o2755);
    expect(sh(SH_PRIVATE_DIR, [home]).status).toBe(0);
    expect(statSync(home).mode & 0o7777).toBe(0o700);
  });
});

describe('the live markers and the lock (root\'s own folder in the server; any folder here)', () => {
  it('reads a process\'s start time from /proc/<pid>/stat, also with spaces and brackets in its name', () => {
    const stat = '4242 (my (odd) prog) S 1 4242 4242 0 -1 4194560 120 0 0 0 1 0 0 0 20 0 1 0 987654 1000 100';
    expect(procStartTime(4242, () => stat)).toBe('987654');
    expect(procStartTime(4242, () => { throw new Error('gone'); })).toBeNull();
    if (existsSync('/proc/self/stat')) expect(procStartTime(process.pid)).toMatch(/^\d+$/);
  });

  it('counts the markers of helpers that are alive, and removes those of helpers that are gone', async () => {
    if (!existsSync('/proc/self/stat')) return;
    const locks = mkdtempSync(join(tmpdir(), 'helper-locks-'));
    mkdirSync(join(locks, 'codex-live'));
    const m = new CodexMarkers(locks, 'eng');
    const own = m.add();
    expect(m.othersAlive(own)).toBe(0);
    writeFileSync(join(m.folder, '999999999.1'), '');
    writeFileSync(join(m.folder, 'not-a-marker'), '');
    const other = spawn('sleep', ['5']);
    try {
      await new Promise((r) => setTimeout(r, 100));
      m.add(other.pid);
      expect(m.othersAlive(own)).toBe(1);
      expect(readdirSync(m.folder).sort()).toEqual([`${other.pid}.${procStartTime(other.pid!)}`, `${process.pid}.${procStartTime(process.pid)}`].sort());
      // a marker whose pid lives but with another start time (the pid was reused) is not alive
      writeFileSync(join(m.folder, `${other.pid}.1`), '');
      expect(m.othersAlive(own)).toBe(1);
    } finally {
      other.kill('SIGKILL');
    }
    m.remove(own);
    rmSync(locks, { recursive: true, force: true });
  });

  const flock = ['/usr/bin/flock', '/bin/flock'].find((p) => existsSync(p));
  it.skipIf(flock === undefined)('flock: a holder makes the next one wait, and a wait that runs out does nothing', async () => {
    const locks = mkdtempSync(join(tmpdir(), 'helper-flock-'));
    const held = spawn(flock!, [join(locks, 'codex-token.lock'), 'sleep', '1.2']);
    await new Promise((r) => setTimeout(r, 200));
    let ran = 0;
    expect(await withCodexLock(flock!, locks, () => (ran += 1), 0)).toBe(false);
    expect(ran).toBe(0);
    const t0 = Date.now();
    expect(await withCodexLock(flock!, locks, () => (ran += 1), 5)).toBe(true);
    expect(ran).toBe(1);
    expect(Date.now() - t0).toBeGreaterThan(700);
    held.kill();
    // a lock taken and given back is free again at once
    const t1 = Date.now();
    expect(await withCodexLock(flock!, locks, () => (ran += 1), 1)).toBe(true);
    expect(Date.now() - t1).toBeLessThan(1_000);
    rmSync(locks, { recursive: true, force: true });
  });
});
