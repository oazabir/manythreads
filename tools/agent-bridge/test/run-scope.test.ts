import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scopeMemoryWatch, type CgroupFiles, type MemoryWatch } from '../src/memory-watch.ts';
import { TeamRun, type ServerWithTeams } from '../src/server-team.ts';
import { newRunTag, parseHelperConfig, RUN_MEMORY_MAX_BYTES, scopeArgv, scopeFor, type HelperConfig } from '../src/team-helper.ts';
import { buildHeader, isRunTag, parseHeader, RUNS_SLICE, runScopeCgroupDir, runScopeUnit } from '../src/team-user.ts';

// P31-04 step 2, a scope per run on a server: `systemd-run --scope` with the run's own MemoryMax in mtruns.slice, so the kernel stops the one command that needs too much and the
// bridge, the other teams' runs and the live site's database go on. Nothing here starts systemd-run: the words are built and checked, the files are fakes.

const GIB = 1024 ** 3;
const ROOT = '/var/lib/manythreads-bridge';
const TAG = 'a1b2c3d4e5f60718';
const exists = (paths: string[]) => (p: string): boolean => paths.includes(p);
const table = (over: Partial<HelperConfig> = {}): HelperConfig => ({ dataRoot: ROOT, agents: { claude: { command: '/opt/acp/claude-agent-acp', args: [] } }, runScope: { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 4 * GIB, bindsTo: 'manythreads-bridge.service' }, ...over });

describe('the run\'s tag and its scope\'s name', () => {
  it('a tag is 8 to 32 lower case letters and digits; a new one is 16 hex digits', () => {
    expect(isRunTag(TAG)).toBe(true);
    for (const bad of ['short', 'A1B2C3D4E5', 'a1b2c3d4-e5f6', 'x'.repeat(33), 7, undefined]) expect(isRunTag(bad)).toBe(false);
    expect(newRunTag()).toMatch(/^[0-9a-f]{16}$/);
    expect(newRunTag()).not.toBe(newRunTag());
  });

  it('the unit is mt-run-<team user>-<tag>.scope in mtruns.slice, and the bridge reads it there', () => {
    expect(runScopeUnit('eng', TAG)).toBe(`mt-run-mt-team-eng-${TAG}.scope`);
    expect(runScopeCgroupDir('eng', TAG)).toBe(`/sys/fs/cgroup/${RUNS_SLICE}/mt-run-mt-team-eng-${TAG}.scope`);
    expect(() => runScopeUnit('eng', 'BAD TAG')).toThrow();
    expect(() => runScopeUnit('../x', TAG)).toThrow();
  });

  it('the header carries the tag; the helper refuses one that is not a tag and keeps an absent one absent', () => {
    const ctx = { root: ROOT, team: 'eng', kind: 'claude' as const };
    const cwd = `${ROOT}/work/eng/builder`;
    const line = buildHeader({ cwd, env: {}, kind: 'claude', runTag: TAG });
    const ok = parseHeader(line, ctx);
    expect(ok.ok && ok.header.runTag).toBe(TAG);
    const none = parseHeader(buildHeader({ cwd, env: {}, kind: 'claude' }), ctx);
    expect(none.ok && 'runTag' in none.header).toBe(false);
    for (const bad of ['x', 'has space1', 'UPPERCASE1', 12345678]) {
      const r = parseHeader(JSON.stringify({ v: 1, cwd, env: {}, files: [], removeAtEnd: [], runTag: bad }), ctx);
      expect(r).toEqual({ ok: false, error: 'runTag must be 8 to 32 lower case letters and digits' });
    }
  });

  it('every team run the bridge starts sends a tag of its own', () => {
    const server = { root: ROOT, teamUsers: { helper: '/opt/manythreads-bridge/helper/mt-team-helper', sudo: '/usr/bin/sudo' } } as unknown as ServerWithTeams;
    const a = new TeamRun(server, 'eng', 'claude');
    const b = new TeamRun(server, 'eng', 'claude');
    expect(isRunTag(a.runTag)).toBe(true);
    expect(a.runTag).not.toBe(b.runTag);
  });
});

describe('the words that start a run in its scope (scopeArgv)', () => {
  const inner = ['/usr/bin/setpriv', '--reuid', '1001', '--', '/bin/sh', '-c', 'exec "$@"'];

  it('systemd-run --scope with the run\'s limit, no swap, OOMPolicy=continue, bound to the bridge, then the program unchanged', () => {
    const unit = runScopeUnit('eng', TAG);
    expect(scopeArgv(table().runScope!, unit, inner)).toEqual([
      '/usr/bin/systemd-run', '--scope', '--quiet', '--collect', '--slice=mtruns.slice', `--unit=${unit}`,
      '-p', `MemoryMax=${4 * GIB}`, '-p', 'MemorySwapMax=0', '-p', 'OOMPolicy=continue',
      '-p', 'BindsTo=manythreads-bridge.service', '-p', 'After=manythreads-bridge.service',
      '--', ...inner,
    ]);
  });

  it('no MemoryHigh (it slows a run and never stops it); not bound when the table names no unit', () => {
    const words = scopeArgv({ systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 2 * GIB }, runScopeUnit('eng', TAG), inner);
    expect(words.join(' ')).not.toMatch(/MemoryHigh|BindsTo/);
    expect(words).toContain(`MemoryMax=${2 * GIB}`);
  });

  it('refuses a unit that is not a run scope and a limit above the Helm maximum', () => {
    expect(() => scopeArgv(table().runScope!, 'sshd.service', inner)).toThrow(/run scope/);
    expect(() => scopeArgv(table().runScope!, 'mt-run-x;rm.scope', inner)).toThrow(/run scope/);
    expect(() => scopeArgv({ systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: RUN_MEMORY_MAX_BYTES + 1 }, runScopeUnit('eng', TAG), inner)).toThrow(/range/);
  });
});

describe('whether a run gets a scope (scopeFor): falls back cleanly', () => {
  const both = exists(['/usr/bin/systemd-run', '/run/systemd/system']);

  it('a bot\'s run on a machine with systemd-run and systemd: a scope named after the header\'s tag', () => {
    expect(scopeFor(table(), 'claude', 'eng', TAG, both)).toEqual({ scope: table().runScope, unit: `mt-run-mt-team-eng-${TAG}.scope` });
    expect(scopeFor(table(), 'codex', 'eng', undefined, both)?.unit).toMatch(/^mt-run-mt-team-eng-[0-9a-f]{16}\.scope$/);
  });

  it('none for the sync and the sign-in kinds, none without the table\'s word, systemd-run or a running systemd', () => {
    for (const kind of ['sync', 'claude-login', 'codex-key', 'clean-kube'] as const) expect(scopeFor(table(), kind, 'eng', TAG, both)).toBeNull();
    expect(scopeFor(table({ runScope: undefined }), 'claude', 'eng', TAG, both)).toBeNull();
    expect(scopeFor(table(), 'claude', 'eng', TAG, exists(['/run/systemd/system']))).toBeNull();
    expect(scopeFor(table(), 'claude', 'eng', TAG, exists(['/usr/bin/systemd-run']))).toBeNull();
  });
});

describe('the table\'s runScope', () => {
  const base = { dataRoot: ROOT, agents: {} };
  it('takes an absolute systemd-run, a limit from 256 MiB to 4 GiB and a service to bind to', () => {
    expect(parseHelperConfig(JSON.stringify({ ...base, runScope: { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 3 * GIB, bindsTo: 'manythreads-bridge.service' } })).runScope).toEqual({ systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 3 * GIB, bindsTo: 'manythreads-bridge.service' });
    expect(parseHelperConfig(JSON.stringify(base)).runScope).toBeUndefined();
  });
  it.each([
    ['a relative systemd-run', { systemdRun: 'systemd-run', memoryMaxBytes: GIB }],
    ['a limit above the Helm maximum', { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 5 * GIB }],
    ['a limit too small to run anything', { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: 1024 }],
    ['a limit that is not a number', { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: '4G' }],
    ['a unit that is not a service', { systemdRun: '/usr/bin/systemd-run', memoryMaxBytes: GIB, bindsTo: 'x; rm -rf /' }],
  ])('refuses %s', (_w, runScope) => {
    expect(() => parseHelperConfig(JSON.stringify({ ...base, runScope }))).toThrow(/runScope/);
  });
});

describe('the memory watch of a run in its scope', () => {
  const dir = runScopeCgroupDir('eng', TAG);
  const fallback: MemoryWatch = { oomKills: () => 7, limitBytes: () => null };

  it('reads the scope\'s oom_kill and MemoryMax while the scope is there', () => {
    const files: CgroupFiles = { read: (p) => {
      if (p === `${dir}/memory.events`) return 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n';
      if (p === `${dir}/memory.max`) return `${4 * GIB}\n`;
      throw new Error('ENOENT');
    } };
    const w = scopeMemoryWatch(dir, fallback, files)!;
    expect(w.oomKills()).toBe(1);
    expect(w.limitBytes()).toBe(4 * GIB);
  });

  it('answers from the bridge\'s own group where the helper made no scope', () => {
    const w = scopeMemoryWatch(dir, fallback, { read: () => { throw new Error('ENOENT'); } })!;
    expect(w.oomKills()).toBe(7);
    expect(w.limitBytes()).toBeNull();
    const none = scopeMemoryWatch(dir, null, { read: () => { throw new Error('ENOENT'); } })!;
    expect(none.oomKills()).toBeNull();
  });
});

describe('the installer\'s sizes and limits (bridge.sh)', () => {
  const script = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'install', 'bridge.sh'), 'utf8');
  const fn = /\nsize_bytes\(\) \{\n[\s\S]*?\n\}\n/.exec(script)?.[0] ?? '';
  const size = (v: string): { status: number | null; out: string } => {
    const r = spawnSync('bash', ['-c', `${fn}\nsize_bytes "$1"`, 'sh', v], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout.trim() };
  };

  it('reads 3G, 2048M, 512MiB, 1048576 and refuses anything else', () => {
    expect(fn).not.toBe('');
    expect(size('3G').out).toBe(String(3 * GIB));
    expect(size('2048M').out).toBe(String(2 * GIB));
    expect(size('512MiB').out).toBe(String(512 * 1024 ** 2));
    expect(size('4g').out).toBe(String(4 * GIB));
    expect(size('1048576').out).toBe('1048576');
    for (const bad of ['', 'G', '3T', '1.5G', '-1G', '3 G', '$(id)']) expect(size(bad).status).not.toBe(0);
  });

  it('writes mtruns.slice and the table\'s runScope only with systemd 253 or later, and removes the slice at uninstall', () => {
    expect(script).toMatch(/\[ "\$sd_version" -ge 253 \]/);
    expect(script).toMatch(/\[Slice\]\nMemoryAccounting=yes\nMemoryMax=\$slice_max\nMemorySwapMax=0\n/);
    expect(script).toContain('runScope: { systemdRun: e.CFG_SCOPE_RUN, memoryMaxBytes: Number(e.CFG_SCOPE_BYTES), bindsTo: e.CFG_SCOPE_UNIT }');
    expect(script).toMatch(/rm -f [^\n]*\/etc\/systemd\/system\/mtruns\.slice/);
    // the limits can only be lowered
    expect(script).toContain('--run-memory can only lower the limit of a run (at most 4G)');
    expect(script).toContain('--runs-memory can only lower the share of all runs');
  });
});
