import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunnerToServer, type RunnerJobFrame } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createJobRunner } from '../src/job.ts';
import type { RunnerConfig } from '../src/config.ts';

// One job on a machine, against a stand-in for Hermes (a script that behaves like `hermes chat --oneshot --format stream-json`): the profile it is
// given, the directory it runs in, the lines that come back, what a stop does, and what is left behind afterwards (nothing).

const scratch = mkdtempSync(join(tmpdir(), 'runner-job-'));
const spool = join(scratch, 'spool.jsonl');
const bin = join(scratch, 'fake-hermes');
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const STAND_IN = `#!/usr/bin/env node
const { appendFileSync, readFileSync, statSync } = require('node:fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  const home = process.env.HERMES_HOME || '';
  const config = readFileSync(home + '/config.yaml', 'utf8');
  appendFileSync(process.env.HERMES_FAKE_SPOOL, JSON.stringify({ modes: { dir: statSync(home).mode & 0o777, config: statSync(home + '/config.yaml').mode & 0o777, marker: statSync(home + '/.manythreads-profile').mode & 0o777 }, argv: process.argv.slice(2), cwd: process.cwd(), home, config, soul: readFileSync(home + '/SOUL.md', 'utf8'), prompt, envNames: Object.keys(process.env).sort() }) + '\\n');
  if (prompt.includes('HANG')) { setInterval(() => {}, 1000); process.on('SIGTERM', () => process.exit(143)); process.stdout.write(JSON.stringify({ type: 'text', text: 'working' }) + '\\n'); return; }
  if (prompt.includes('BIG')) process.stdout.write(JSON.stringify({ type: 'text', text: 'x'.repeat(100000) }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', exit_code: 0, text: 'done: ' + prompt }) + '\\n');
});
`;

const profileFiles = (extra = ''): Record<string, string> => ({
  'SOUL.md': '# Coder\n',
  'config.yaml': `model:\n  provider: "manythreads"\n  default: "code"\nmcp_servers:\n  manythreads:\n    url: "https://t.example/api/mcp/runs/r"\n${extra}`,
});

const config = (name: string): RunnerConfig => ({
  server: 'http://x', tokenFile: '/t', name: null, hermesBin: bin, hermesHome: join(scratch, name, 'hermes'), workspaceRoot: join(scratch, name, 'workspaces'),
  maxJobs: 2, terminal: 'docker', sandboxImage: 'manythreads/runner-sandbox:1', extraCapabilities: [],
});

const jobFrame = (n: number, prompt: string, files = profileFiles()): RunnerJobFrame => {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return { type: 'job', jobId: id, runId: id, profile: { home: `coder-${id}`, files }, prompt, runBudgetSeconds: 30, maxTurns: 5, killGraceSeconds: 1 };
};

function harness(name: string, over: Partial<RunnerConfig> = {}) {
  const frames: RunnerToServer[] = [];
  const logs: string[] = [];
  const removed: string[] = [];
  const cfg = { ...config(name), ...over };
  const runner = createJobRunner({
    config: cfg,
    send: (f) => frames.push(f),
    log: (l) => logs.push(l),
    removeContainers: async (runId) => { removed.push(runId); },
    env: { PATH: process.env['PATH'], HERMES_FAKE_SPOOL: spool, MANYTHREADS_RUNNER_TOKEN_FILE: '/secret', SECRET_RUNNER_TOKEN: 'mtr_secret', HOME: process.env['HOME'] },
    uid: 1000,
  });
  const waitExit = async (jobId: string): Promise<Extract<RunnerToServer, { type: 'exit' }>> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const exit = frames.find((f): f is Extract<RunnerToServer, { type: 'exit' }> => f.type === 'exit' && f.jobId === jobId);
      if (exit) return exit;
      if (Date.now() > deadline) throw new Error(`no exit frame; frames: ${JSON.stringify(frames).slice(0, 500)} logs: ${logs.join('|')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { runner, frames, logs, removed, cfg, waitExit };
}

const spoolLines = (): Record<string, unknown>[] => (existsSync(spool) ? readFileSync(spool, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

beforeAll(() => {
  writeFileSync(bin, STAND_IN, { mode: 0o755 });
  chmodSync(bin, 0o755);
});

describe('a job on the runner', () => {
  it('writes the profile under <hermes home>/profiles, runs in the team workspace, relays the lines and removes everything', async () => {
    const h = harness('a');
    const frame = jobFrame(1, 'hello; $(touch /tmp/pwned) `id`');
    h.runner.start(frame, 'engineering');
    const exit = await h.waitExit(frame.jobId);
    expect(exit).toMatchObject({ code: 0, signal: null });

    const line = spoolLines().find((l) => String(l['home']).endsWith(frame.profile.home))!;
    expect(line['home']).toBe(join(h.cfg.hermesHome, 'profiles', frame.profile.home));
    expect(line['cwd']).toBe(join(h.cfg.workspaceRoot, 'engineering'));
    expect(line['argv']).toEqual(['chat', '--query-file', '-', '--oneshot', '--format', 'stream-json', '--run-budget', '30', '--max-turns', '5']);
    // the prompt arrived on stdin, byte for byte, and in no argument
    expect(line['prompt']).toBe('hello; $(touch /tmp/pwned) `id`');
    expect(JSON.stringify(line['argv'])).not.toContain('hello');
    expect(line['soul']).toBe('# Coder\n');
    // the server's config is there untouched, and the runner's policy follows it
    const config = String(line['config']);
    expect(config).toContain('url: "https://t.example/api/mcp/runs/r"');
    expect(config).toMatch(/runner policy[^\n]*\nterminal:\n {2}backend: "docker"\n {2}cwd: "\."/);
    expect(config).toContain('docker_mount_cwd_to_workspace: true');
    expect(config).toContain(`manythreads-runner-run=${frame.runId}`);
    // the agent does not inherit the runner's secrets
    const names = line['envNames'] as string[];
    expect(names).toContain('HERMES_HOME');
    expect(names).not.toContain('SECRET_RUNNER_TOKEN');
    expect(names).not.toContain('MANYTHREADS_RUNNER_TOKEN_FILE');

    const lines = h.frames.filter((f) => f.type === 'line');
    expect(lines).toHaveLength(1);
    expect(JSON.parse((lines[0] as { line: string }).line)).toMatchObject({ type: 'result', text: 'done: hello; $(touch /tmp/pwned) `id`' });
    // nothing of the run is left: no profile, and the sandbox containers were asked for
    expect(existsSync(line['home'] as string)).toBe(false);
    expect(h.removed).toEqual([frame.runId]);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });

  it('writes the profile owner-only, marker first', async () => {
    const h = harness('modes');
    const frame = jobFrame(20, 'x');
    h.runner.start(frame, 'engineering');
    await h.waitExit(frame.jobId);
    const line = spoolLines().find((l) => String(l['home']).endsWith(frame.profile.home))!;
    expect(line['modes']).toEqual({ dir: 0o700, config: 0o600, marker: 0o600 });
  });

  it('one workspace per team: two jobs of a team run in the same directory, another team in its own', async () => {
    const h = harness('b');
    const a = jobFrame(2, 'one');
    const b = jobFrame(3, 'two');
    const c = jobFrame(4, 'three');
    h.runner.start(a, 'engineering');
    await h.waitExit(a.jobId);
    h.runner.start(b, 'engineering');
    await h.waitExit(b.jobId);
    h.runner.start(c, 'ops');
    await h.waitExit(c.jobId);
    const cwdOf = (f: RunnerJobFrame) => spoolLines().find((l) => String(l['home']).endsWith(f.profile.home))!['cwd'];
    expect(cwdOf(a)).toBe(cwdOf(b));
    expect(cwdOf(c)).not.toBe(cwdOf(a));
    expect(readdirSync(h.cfg.workspaceRoot).sort()).toEqual(['engineering', 'ops']);
  });

  it('splits a line longer than a frame into pieces that join back', async () => {
    const h = harness('c');
    const frame = jobFrame(5, 'BIG');
    h.runner.start(frame, 'engineering');
    await h.waitExit(frame.jobId);
    const pieces = h.frames.filter((f): f is Extract<RunnerToServer, { type: 'line' }> => f.type === 'line');
    // the long line is the first line: its pieces carry `more` up to the last; the result line after it is one piece
    const last = pieces.findIndex((p) => p.more !== true);
    expect(last).toBeGreaterThan(7);
    const long = pieces.slice(0, last + 1).map((p) => p.line).join('');
    expect(long).toBe(JSON.stringify({ type: 'text', text: 'x'.repeat(100000) }));
    expect(pieces).toHaveLength(last + 2);
  });

  it('a stop frame kills the process and the job ends with the signal', async () => {
    const h = harness('d');
    const frame = jobFrame(6, 'HANG');
    h.runner.start(frame, 'engineering');
    const deadline = Date.now() + 10_000;
    while (!h.frames.some((f) => f.type === 'line') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(h.runner.running).toBe(1);
    h.runner.stop(frame.jobId);
    const exit = await h.waitExit(frame.jobId);
    expect(exit.code === 143 || exit.signal === 'SIGTERM').toBe(true);
    expect(h.runner.running).toBe(0);
    expect(existsSync(join(h.cfg.hermesHome, 'profiles', frame.profile.home))).toBe(false);
  });

  it('a job over the budget is stopped by the runner itself', async () => {
    const h = harness('e');
    const frame = { ...jobFrame(7, 'HANG'), runBudgetSeconds: 1, killGraceSeconds: 1 };
    h.runner.start(frame, 'engineering');
    const exit = await h.waitExit(frame.jobId);
    expect(exit.code === 143 || exit.signal !== null).toBe(true);
    expect(h.logs.join('\n')).toContain('exceeded');
  });

  it('refuses a profile that says anything about the host, a bad team slug, and a job past its limit — each as an exit frame', async () => {
    const h = harness('f', { maxJobs: 1 });
    const files = profileFiles();
    const bad = jobFrame(8, 'x', { ...files, 'config.yaml': `${files['config.yaml']}terminal:\n  backend: local\n` });
    h.runner.start(bad, 'engineering');
    expect((await h.waitExit(bad.jobId)).stderrTail).toMatch(/refused: .*"terminal"/);

    const slug = jobFrame(9, 'x');
    h.runner.start(slug, '../etc');
    expect((await h.waitExit(slug.jobId)).stderrTail).toMatch(/not a team slug/);

    const hang = jobFrame(10, 'HANG');
    const over = jobFrame(11, 'x');
    h.runner.start(hang, 'engineering');
    h.runner.start(over, 'engineering');
    expect((await h.waitExit(over.jobId)).stderrTail).toMatch(/already running 1 job/);
    await h.runner.stopAll();
    await h.waitExit(hang.jobId);
    expect(spoolLines().some((l) => String(l['home']).endsWith(bad.profile.home))).toBe(false); // nothing was started for the refused one
  });

  it("refuses a profile name that is not <bot slug>-<this run's id>, and never touches an existing profile", async () => {
    const h = harness('home');
    const profiles = join(h.cfg.hermesHome, 'profiles');
    mkdirSync(join(profiles, 'default'), { recursive: true });
    writeFileSync(join(profiles, 'default', 'keep.txt'), 'mine');
    const id = '00000000-0000-4000-8000-0000000000a1';
    const other = '00000000-0000-4000-8000-0000000000a2';
    const base = jobFrame(30, 'x');
    for (const [n, home] of [[31, 'default'], [32, `coder-${other}`], [33, `-${id}`], [34, '..']] as const) {
      const frame = { ...base, jobId: id.slice(0, -2) + String(n), runId: id.slice(0, -2) + String(n), profile: { ...base.profile, home } };
      h.runner.start(frame, 'engineering');
      expect((await h.waitExit(frame.jobId)).stderrTail, home).toMatch(/refused: .*profile name/);
    }
    expect(readFileSync(join(profiles, 'default', 'keep.txt'), 'utf8')).toBe('mine');

    // a directory of the right shape that already exists is not overwritten, nor deleted when the refused job ends
    const taken = jobFrame(35, 'x');
    mkdirSync(join(profiles, taken.profile.home), { recursive: true });
    writeFileSync(join(profiles, taken.profile.home, 'keep.txt'), 'theirs');
    h.runner.start(taken, 'engineering');
    expect((await h.waitExit(taken.jobId)).stderrTail).toMatch(/already exists/);
    expect(readFileSync(join(profiles, taken.profile.home, 'keep.txt'), 'utf8')).toBe('theirs');
  });

  it('a binary that cannot start is reported as a failed job, not a crash', async () => {
    const h = harness('g', { hermesBin: join(scratch, 'does-not-exist') });
    const frame = jobFrame(12, 'x');
    h.runner.start(frame, 'engineering');
    const exit = await h.waitExit(frame.jobId);
    expect(exit.code).toBeNull();
    expect(existsSync(join(h.cfg.hermesHome, 'profiles', frame.profile.home))).toBe(false);
  });
});
