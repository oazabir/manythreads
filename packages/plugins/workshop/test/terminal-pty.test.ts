import { chmod, chown, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pickIds, readTerminalConfig } from '../src/terminal/config.ts';
import { PTY_HELPER } from '../src/terminal/pty-helper.ts';
import { pythonPty, type PtyProcess } from '../src/terminal/pty.ts';
import { makeScratch, sweepStale } from '../src/terminal/scratch.ts';

// P7-09, the real thing: a real shell in the real jail. It needs Linux, Python 3 and the root user (the jail uses namespaces); where those are missing the tests that need them are skipped
// and the probe test says so. What it proves: the shell is NOT root, starts in its own folder, sees none of the server's files or environment, has no network, cannot reach the server's
// processes, can be resized, and dies (with everything it started) when the terminal is killed.

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const hasPython = spawnSync('python3', ['-c', 'import pty, ctypes']).status === 0;
let jailWorks = false;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Runs the commands in a fresh jail and returns everything printed (escape codes removed) once the shell exits. */
async function session(commands: string[], opts: { seed?: Record<string, string>; timeoutMs?: number } = {}): Promise<{ text: string; fatal: string | null; code: number | null }> {
  const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
  const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
  for (const [name, content] of Object.entries(opts.seed ?? {})) await writeFile(join(scratch.workDir, name), content);
  let pty: PtyProcess | undefined;
  try {
    pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 65534, gid: 65534, cols: 100, rows: 30 });
    let text = '';
    pty.onData((t) => (text += t));
    const exit = new Promise<{ fatal: string | null; code: number | null }>((resolve) => pty!.onExit((i) => resolve(i)));
    // wait for the first prompt, then type each command and wait for it to be echoed back finished
    await wait(500);
    for (const c of commands) {
      pty.write(`${c}\n`);
      await wait(250);
    }
    pty.write('exit\n');
    const result = await Promise.race([exit, wait(opts.timeoutMs ?? 15_000).then(() => ({ fatal: 'timeout', code: null }))]);
    // eslint-disable-next-line no-control-regex
    return { text: text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, ''), ...result };
  } finally {
    await pty?.kill();
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  if (!isRoot || !hasPython) return;
  const probe = await session([]).catch(() => ({ fatal: 'failed', text: '', code: null }));
  jailWorks = probe.fatal === null;
});

describe('the terminal\'s real shell', () => {
  it('says why when the jail cannot be built on this machine (the tests below are skipped then)', () => {
    if (!jailWorks) console.warn('terminal-pty: no jail here (needs Linux, python3, the root user and namespaces); real-shell tests skipped');
    expect(typeof jailWorks).toBe('boolean');
  });

  it.runIf(isRoot && hasPython)('runs as an unprivileged user in its own work folder', async () => {
    if (!jailWorks) return;
    const r = await session(['id -u', 'pwd', 'cat README.txt | head -1', 'echo $USER']);
    expect(r.text).toMatch(/\n65534\n/);
    expect(r.text).toContain('/work');
    expect(r.text).toContain('This is a throwaway test sandbox');
    expect(r.text).not.toMatch(/\n0\n/);
  });

  it.runIf(isRoot && hasPython)('cannot see the server\'s files, home folder or environment', async () => {
    if (!jailWorks) return;
    const secretFile = join(tmpdir(), `mt-secret-${randomUUID()}.txt`);
    await writeFile(secretFile, 'TOP-SECRET-VALUE');
    process.env['MT_TERMINAL_TEST_SECRET'] = 'ENV-SECRET-VALUE';
    try {
      const r = await session([`cat ${secretFile} 2>&1`, 'ls /root 2>&1', 'ls /home 2>&1', 'env', 'cat /proc/1/environ 2>&1 | head -c 200', 'ls /etc | head -20', 'cat /etc/shadow 2>&1']);
      expect(r.text).not.toContain('TOP-SECRET-VALUE');
      expect(r.text).not.toContain('ENV-SECRET-VALUE');
      expect(r.text).toMatch(/No such file or directory|cannot access/);
      expect(r.text).not.toContain('MANYTHREADS_');
      expect(r.text).not.toMatch(/root:[^\n]*:\d+:\d+:\d+:/);
    } finally {
      delete process.env['MT_TERMINAL_TEST_SECRET'];
      await rm(secretFile, { force: true });
    }
  });

  it.runIf(isRoot && hasPython)('has no network at all', async () => {
    if (!jailWorks) return;
    const r = await session(['cat /proc/net/dev', 'cat /proc/net/route', 'timeout 2 bash -c "echo > /dev/tcp/127.0.0.1/5432" 2>&1; echo exit=$?', 'timeout 2 bash -c "echo > /dev/tcp/1.1.1.1/53" 2>&1; echo exit=$?']);
    // only a loopback that is down: no other interface, no route
    const interfaces = [...r.text.matchAll(/^\s*([a-z0-9]+):\s+\d+/gm)].map((m) => m[1]);
    expect(interfaces.filter((i) => i !== 'lo')).toEqual([]);
    expect(r.text.match(/exit=(\d+)/g)).toEqual(['exit=1', 'exit=1']);
  });

  it.runIf(isRoot && hasPython)('sees only its own processes and cannot signal the server', async () => {
    if (!jailWorks) return;
    const r = await session(['echo SELF=$$', `kill -9 ${String(process.pid)} 2>&1; echo kill=$?`, 'ls /proc | grep -c "^[0-9]"', 'ps -eo user,args 2>&1 | head -5']);
    expect(r.text).toMatch(/kill=1/);
    expect(r.text).toMatch(/kill: .*No such process/);
    // the shell is a handful of processes, never the machine's
    const count = Number(/^(\d+)\s*$/m.exec(r.text.split('grep -c')[1] ?? '')?.[1] ?? '999');
    expect(count).toBeLessThan(10);
    // the sandbox's own first process (a root-owned helper whose command line is a program) is not listed to the shell
    expect(r.text).not.toContain('import os, sys, pty');
    expect(r.text).not.toMatch(/\nroot /);
  });

  it.runIf(isRoot && hasPython)('cannot become root or change what it is allowed to do', async () => {
    if (!jailWorks) return;
    const r = await session(['su - 2>&1 | head -2', 'sudo id 2>&1 | head -1', 'mount -t tmpfs none /mnt 2>&1 | head -1', 'chown root /work/README.txt 2>&1 | head -1', 'unshare -n true 2>&1 | head -1', 'grep -E "^(Cap|NoNewPrivs)" /proc/self/status']);
    expect(r.text).toMatch(/CapEff:\s+0000000000000000/);
    expect(r.text).toMatch(/NoNewPrivs:\s+1/);
    expect(r.text).not.toMatch(/uid=0/);
  });

  it.runIf(isRoot && hasPython)('the machine\'s root is gone: only the jail\'s own mounts are left, and the root is a memory file system', async () => {
    if (!jailWorks) return;
    const r = await session(['echo ROOTFS=$(awk \'$5=="/" {print $9}\' /proc/self/mountinfo)', 'echo LISTING $(ls /)', 'ls /root /home /var /srv /opt 2>&1 | head -3', 'ls -la /proc/self/root 2>&1 | head -1']);
    expect(r.text).toContain('ROOTFS=tmpfs');
    // the root holds exactly what the jail put there
    const listing = /LISTING ([^\n]*)/.exec(r.text.split('\n').filter((l) => l.startsWith('LISTING')).join('\n'))?.[1] ?? '';
    const names = listing.split(/\s+/).filter(Boolean);
    expect(names).toEqual(expect.arrayContaining(['bin', 'dev', 'etc', 'proc', 'tmp', 'usr', 'work']));
    for (const forbidden of ['boot', 'home', 'root', 'var', 'srv', 'opt', 'mnt', 'media', 'sys', 'run', 'snap', 'lost+found']) expect(names, forbidden).not.toContain(forbidden);
    expect(r.text).toMatch(/No such file or directory/);
  });

  it.runIf(isRoot && hasPython)('cannot make a user namespace (the first step of the classic way out of a chroot)', async () => {
    if (!jailWorks) return;
    const probe = "import ctypes; l=ctypes.CDLL(None,use_errno=True); print('CLONE_NEWUSER', l.unshare(0x10000000), ctypes.get_errno()); print('SYS_CLONE_NEWUSER', l.syscall(56, 0x10000000, 0, 0, 0, 0), ctypes.get_errno()); print('SETNS', l.setns(-1, 0), ctypes.get_errno()); print('PTRACE', l.ptrace(0, 0, 0, 0), ctypes.get_errno())";
    const r = await session([
      'unshare -Ur id -u 2>&1; echo unshare_rc=$?',
      'unshare -r true 2>&1; echo unshare_r_rc=$?',
      'unshare -m true 2>&1; echo unshare_m_rc=$?',
      'unshare -U true 2>&1; echo unshare_U_rc=$?',
      `python3 -c "${probe}" 2>&1`,
    ]);
    expect(r.text).toContain('unshare_rc=1');
    expect(r.text).not.toMatch(/unshare_(r_|m_|U_)?rc=0/);
    expect(r.text).toMatch(/Operation not permitted/);
    // EPERM is 1 in all of these
    expect(r.text).toContain('CLONE_NEWUSER -1 1');
    expect(r.text).toContain('SYS_CLONE_NEWUSER -1 1');
    expect(r.text).toContain('SETNS -1 1');
    expect(r.text).toContain('PTRACE -1 1');
  });

  it.runIf(isRoot && hasPython)('the classic chroot breakout (chroot into a sub-folder, then climb out) does not work', async () => {
    if (!jailWorks) return;
    const attempt = [
      'import os',
      "os.mkdir('/work/sub')",
      "try:\n    os.chroot('/work/sub')\n    print('CHROOT_OK')\nexcept OSError as e:\n    print('CHROOT_DENIED', e.errno)",
      "for _ in range(40):\n    os.chdir('..')",
      "os.chroot('.')",
      "print('ESCAPED', sorted(os.listdir('/')))",
    ].join('\n');
    const encoded = Buffer.from(attempt, 'utf8').toString('base64');
    const r = await session([`echo ${encoded} | base64 -d > /work/breakout.py; python3 /work/breakout.py 2>&1 | grep -E 'CHROOT|ESCAPED|Error'`]);
    expect(r.text).toContain('CHROOT_DENIED 1');
    expect(r.text).not.toContain('CHROOT_OK');
    expect(r.text).not.toMatch(/ESCAPED \[/);
    expect(r.text).toMatch(/PermissionError|Operation not permitted/);
  });

  it.runIf(isRoot && hasPython)('has no capability left anywhere and runs under the system-call filter', async () => {
    if (!jailWorks) return;
    const r = await session(['grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs|Seccomp):" /proc/self/status']);
    for (const name of ['CapPrm', 'CapEff', 'CapBnd', 'CapAmb']) expect(r.text).toMatch(new RegExp(`${name}:\\s+0000000000000000`));
    expect(r.text).toMatch(/NoNewPrivs:\s+1/);
    expect(r.text).toMatch(/Seccomp:\s+2/);
  });

  it.runIf(isRoot && hasPython)('has its own, limited memory and process allowance', async () => {
    if (!jailWorks) return;
    const r = await session(['ulimit -v', 'ulimit -u', 'ulimit -n']);
    expect(r.text).toMatch(/\n1048576\n/); // 1 GiB of address space, in KiB
    expect(r.text).toMatch(/\n128\n/);
    expect(r.text).toMatch(/\n256\n/);
  });

  it.runIf(isRoot && hasPython)('what /usr and /bin hold is readable but nothing under them can be written (also the mounts below them)', async () => {
    if (!jailWorks) return;
    const r = await session(['touch /usr/x 2>&1 | head -1', 'touch /usr/local/x 2>&1 | head -1', 'touch /bin/x 2>&1 | head -1', 'touch /etc/x 2>&1 | head -1', 'touch /tmp/ok && echo tmp_ok', 'touch /work/ok && echo work_ok', 'grep -E " /(usr|bin|lib)" /proc/self/mountinfo | grep -vc " ro,"']);
    expect(r.text.match(/Read-only file system|Permission denied/g)?.length).toBeGreaterThanOrEqual(4);
    expect(r.text).toContain('tmp_ok');
    expect(r.text).toContain('work_ok');
    // no /usr, /bin or /lib mount in the jail is writable
    expect(r.text).toMatch(/grep -vc[^\n]*\n0\n/);
  });

  it.runIf(isRoot && hasPython)('a line the shell prints that looks like the starter\'s failure message is only text', async () => {
    if (!jailWorks) return;
    const r = await session(['echo "fatal: pretend the sandbox broke"; echo "fatal: pretend the sandbox broke" >&2']);
    expect(r.fatal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.text).toContain('fatal: pretend the sandbox broke');
  });

  it.runIf(isRoot && hasPython)('a shell that ignores the hang-up signal still dies when the terminal is killed', async () => {
    if (!jailWorks) return;
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 60777, gid: 60777, cols: 100, rows: 30 });
    pty.write("trap '' HUP TERM INT; exec sleep 31415\n");
    await wait(900);
    expect(spawnSync('pgrep', ['-f', 'sleep 31415']).stdout.toString().trim()).not.toBe('');
    await pty.kill();
    await wait(300);
    expect(spawnSync('pgrep', ['-f', 'sleep 31415']).stdout.toString().trim()).toBe('');
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(isRoot && hasPython)('a shell whose output is held back (paused) is still ended promptly', async () => {
    if (!jailWorks) return;
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 60778, gid: 60778, cols: 100, rows: 30 });
    pty.write('yes 27182 | head -c 500000000\n');
    await wait(700);
    pty.pause();
    await wait(300);
    const from = Date.now();
    await pty.kill();
    expect(Date.now() - from).toBeLessThan(3000);
    expect(spawnSync('pgrep', ['-f', 'yes 27182']).stdout.toString().trim()).toBe('');
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(isRoot && hasPython)('a helper that is killed outright takes the whole sandbox with it', async () => {
    if (!jailWorks) return;
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 60779, gid: 60779, cols: 100, rows: 30 });
    pty.write('exec sleep 16180\n');
    await wait(900);
    // the helper is the python program that holds this scratch folder in its command line
    const helperPid = spawnSync('pgrep', ['-f', `python3 -I -c.*${scratch.workDir}`]).stdout.toString().trim().split('\n')[0];
    expect(helperPid).toMatch(/^\d+$/);
    process.kill(Number(helperPid), 'SIGKILL');
    await wait(700);
    expect(spawnSync('pgrep', ['-f', 'sleep 16180']).stdout.toString().trim()).toBe('');
    await pty.kill();
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(isRoot && hasPython)('what it writes goes away with it', async () => {
    if (!jailWorks) return;
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 65534, gid: 65534, cols: 100, rows: 30 });
    pty.write('echo hello > made.txt; sleep 300 &\n');
    await wait(600);
    await pty.kill();
    await scratch.remove();
    // the folder is gone and nothing of the sandbox is left running
    await expect(stat(scratch.dir)).rejects.toThrow();
    expect(await readdir(root)).toEqual(['.manythreads-terminal']);
    const left = spawnSync('pgrep', ['-f', 'sleep 300']).stdout.toString().trim();
    expect(left).toBe('');
    await rm(root, { recursive: true, force: true });
  });

  it.runIf(isRoot && hasPython)('follows a resize', async () => {
    if (!jailWorks) return;
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 65534, gid: 65534, cols: 100, rows: 30 });
    let text = '';
    pty.onData((t) => (text += t));
    await wait(400);
    pty.resize(77, 22);
    await wait(200);
    pty.write('stty size\n');
    await wait(400);
    await pty.kill();
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
    expect(text).toContain('22 77');
  });

  it.runIf(isRoot && hasPython)('reports a sandbox it cannot build instead of running a shell without one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() });
    // a user id of root is refused: the shell must never be root
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'jail', uid: 0, gid: 0, cols: 100, rows: 30 });
    const info = await new Promise<{ fatal: string | null; code: number | null }>((resolve) => pty.onExit(resolve));
    await scratch.remove();
    await rm(root, { recursive: true, force: true });
    if (jailWorks) expect(info.fatal).not.toBeNull();
  });
});

describe('the folder of a terminal', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });

  it('is made fresh, holds only a note, and is removed with everything in it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    roots.push(root);
    const id = randomUUID();
    const scratch = await makeScratch(root, id, { botSlug: 'helper', startedAt: new Date('2026-11-02T08:00:00Z') });
    expect(await readdir(scratch.workDir)).toEqual(['README.txt']);
    await writeFile(join(scratch.workDir, 'extra.txt'), 'x');
    await scratch.remove();
    await scratch.remove();
    await expect(stat(scratch.dir)).rejects.toThrow();
    expect(scratch.dir).toMatch(new RegExp(`${id}-[A-Za-z0-9]{6}$`));
  });

  it('refuses a name that is not a session id (no path can be smuggled in)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    roots.push(root);
    for (const bad of ['../escape', 'abc', '/etc', '..', 'x'.repeat(36)]) await expect(makeScratch(root, bad, { botSlug: 'a', startedAt: new Date() })).rejects.toThrow();
  });

  it('only sweeps folders it made: a root without its marker is left alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    roots.push(root);
    const id = randomUUID();
    const made = await makeScratch(root, id, { botSlug: 'a', startedAt: new Date() });
    expect(await sweepStale(root, new Set([id]))).toBe(0);
    await expect(stat(made.dir)).resolves.toBeTruthy();
    expect(await sweepStale(root, new Set())).toBe(1);
    await expect(stat(made.dir)).rejects.toThrow();

    const foreign = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    roots.push(foreign);
    const lookalike = join(foreign, `${randomUUID()}-abc123`);
    await writeFile(join(foreign, 'keep.txt'), 'k');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(lookalike);
    expect(await sweepStale(foreign, new Set())).toBe(0);
    await expect(stat(lookalike)).resolves.toBeTruthy();
  });
});


describe('the terminal root is proved to be ours', () => {
  const roots: string[] = [];
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });
  const fresh = async (): Promise<string> => {
    const r = await mkdtemp(join(tmpdir(), 'mt-term-root-'));
    roots.push(r);
    return r;
  };

  it('refuses a root that is a link to somewhere else', async () => {
    const base = await fresh();
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere);
    const link = join(base, 'link');
    await symlink(elsewhere, link);
    await expect(makeScratch(link, randomUUID(), { botSlug: 'a', startedAt: new Date() })).rejects.toThrow(/plain folder|link/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it('refuses a root that other users can write to (a look-alike could be planted there)', async () => {
    const base = await fresh();
    const open = join(base, 'open');
    await mkdir(open);
    await chmod(open, 0o777);
    await expect(makeScratch(open, randomUUID(), { botSlug: 'a', startedAt: new Date() })).rejects.toThrow(/written by other users/);
  });

  it.runIf(isRoot)('refuses a root that belongs to another user', async () => {
    const base = await fresh();
    const theirs = join(base, 'theirs');
    await mkdir(theirs);
    await chown(theirs, 65534, 65534);
    await expect(makeScratch(theirs, randomUUID(), { botSlug: 'a', startedAt: new Date() })).rejects.toThrow(/another user/);
  });

  it('makes the root private (0700), or walkable (0711) only for plain mode, and names each folder with a random part', async () => {
    const base = await fresh();
    const root = join(base, 'mine');
    const a = await makeScratch(root, randomUUID(), { botSlug: 'a', startedAt: new Date() });
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const id = randomUUID();
    const b = await makeScratch(root, id, { botSlug: 'a', startedAt: new Date() }, { traversable: true });
    expect((await stat(root)).mode & 0o777).toBe(0o711);
    const c = await makeScratch(root, id, { botSlug: 'a', startedAt: new Date() });
    expect(b.dir).not.toBe(c.dir);
    expect(a.dir.startsWith(root)).toBe(true);
  });

  it('the default root is not the old predictable name', () => {
    const c = readTerminalConfig({});
    expect(c.root).not.toBe(join(tmpdir(), 'manythreads-terminal'));
    expect(c.root).toMatch(/manythreads-terminal-\d+$/);
  });
});

describe('every terminal gets a user number of its own', () => {
  it('picks one in the dedicated range that no other running terminal has', () => {
    const c = readTerminalConfig({});
    expect(c.ownUser).toBe(true);
    const taken = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const { uid, gid } = pickIds(c, taken);
      expect(uid).toBeGreaterThanOrEqual(60_000);
      expect(uid).toBeLessThan(65_000);
      expect(gid).toBe(uid);
      expect(taken.has(uid)).toBe(false);
      taken.add(uid);
    }
  });

  it('uses the fixed user when the operator names one', () => {
    const c = readTerminalConfig({ MANYTHREADS_TERMINAL_UID: '4242', MANYTHREADS_TERMINAL_GID: '4243' });
    expect(c.ownUser).toBe(false);
    expect(pickIds(c, new Set([4242]))).toEqual({ uid: 4242, gid: 4243 });
  });
});

// The helper itself, started by hand so the tests can choose who runs it and which mode it gets.
function runHelper(mode: string, workDir: string, opts: { uid?: number } = {}): { status: number | null; fatal: string; terminal: string } {
  const r = spawnSync('python3', ['-I', '-c', PTY_HELPER, mode, workDir, '60123', '60123', '80', '24'], {
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    input: 'exit\n',
    timeout: 20_000,
    ...(opts.uid !== undefined ? { uid: opts.uid, gid: opts.uid } : {}),
  });
  const channel = r.output?.[4];
  return { status: r.status, fatal: channel ? channel.toString('utf8') : '', terminal: (r.stdout ?? Buffer.from('')).toString('utf8') };
}

describe('the helper refuses to run a shell as the server itself', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
  const work = async (): Promise<string> => {
    const base = await mkdtemp(join(tmpdir(), 'mt-term-helper-'));
    dirs.push(base);
    await chmod(base, 0o755);
    const w = join(base, 'work');
    await mkdir(w);
    await chmod(w, 0o755);
    return w;
  };

  it.runIf(isRoot && hasPython)('plain mode as a user who is not root says so and starts nothing (it would run the shell as the server, which can read the server\'s secrets)', async () => {
    const r = runHelper('plain', await work(), { uid: 65534 });
    expect(r.fatal).toContain('fatal: plain mode needs the root user');
    expect(r.status).toBe(70);
    expect(r.terminal).not.toMatch(/sandbox|\$ /);
  });

  it.runIf(isRoot && hasPython)('the jail as a user who is not root says so too', async () => {
    const r = runHelper('jail', await work(), { uid: 65534 });
    expect(r.fatal).toContain('fatal: the jail needs the root user');
    expect(r.status).toBe(70);
  });

  it.runIf(isRoot && hasPython)('any mode other than exactly "jail" or "plain" is refused', async () => {
    for (const mode of ['', 'none', 'JAIL', 'jail ', 'plain\n', 'both']) {
      const r = runHelper(mode, await work());
      expect(r.fatal, JSON.stringify(mode)).toContain('fatal: unknown mode');
      expect(r.status).toBe(70);
    }
  });

  it.runIf(isRoot && hasPython)('plain mode as root runs the shell as the unprivileged user, never as root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mt-term-test-'));
    dirs.push(root);
    const scratch = await makeScratch(root, randomUUID(), { botSlug: 'test', startedAt: new Date() }, { traversable: true });
    const pty = pythonPty.start({ workDir: scratch.workDir, mode: 'plain', uid: 60124, gid: 60124, cols: 100, rows: 30 });
    let text = '';
    pty.onData((t) => (text += t));
    const exit = new Promise<{ fatal: string | null; code: number | null }>((resolve) => pty.onExit(resolve));
    await wait(600);
    pty.write('id -u; id -g; echo CAPS $(grep CapEff /proc/self/status); unshare -Ur true 2>&1; echo unshare_rc=$?; exit\n');
    const info = await Promise.race([exit, wait(10_000).then(() => ({ fatal: 'timeout', code: null }))]);
    await pty.kill();
    await scratch.remove();
    expect(info.fatal).toBeNull();
    expect(text).toMatch(/\n60124\r?\n/);
    expect(text).toMatch(/CAPS CapEff:\s+0000000000000000/);
    // the same system-call filter as in the jail: no user namespaces here either
    expect(text).not.toContain('unshare_rc=0');
    expect(info.code).toBe(0);
  });
});
