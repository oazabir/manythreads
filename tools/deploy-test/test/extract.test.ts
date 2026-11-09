import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractBlocks, scriptOf } from '../src/extract.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PAGE = 'docs/deploy/k3s.md';
const page = readFileSync(join(root, PAGE), 'utf8');

describe('extractBlocks', () => {
  const sample = ['# T', '```sh k3s-test', 'echo one', '```', 'text', '```sh', 'echo shown only', '```', '```sh k3s-install', 'curl x | sh', '```', '```sh k3s-test', 'echo two', '```'].join('\n');

  it('takes only the blocks with the tag, in order, with the line of their fence', () => {
    expect(extractBlocks(sample, 'sh', 'k3s-test')).toEqual([
      { line: 2, code: 'echo one' },
      { line: 12, code: 'echo two' },
    ]);
  });

  it('does not take a block of another tag or none', () => {
    expect(extractBlocks(sample, 'sh', 'k3s-install')).toEqual([{ line: 9, code: 'curl x | sh' }]);
  });

  it('refuses a block that is never closed', () => {
    expect(() => extractBlocks('```sh k3s-test\necho', 'sh', 'k3s-test')).toThrow(/never closed/);
  });

  it('scriptOf names each step and quotes its first line, so nothing in it runs by being named', () => {
    const script = scriptOf([{ line: 5, code: 'export TAG=$(touch /tmp/never-made-by-test)' }], 'p.md');
    expect(script).toContain("echo '=== p.md:5 (step 1 of 1): export TAG=$(touch /tmp/never-made-by-test)'");
  });
});

describe(`${PAGE} as the fresh-k3s test reads it`, () => {
  const blocks = extractBlocks(page, 'sh', 'k3s-test');

  it('has steps, and each one is valid shell', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(7);
    const dir = mkdtempSync(join(tmpdir(), 'k3s-page-'));
    for (const block of blocks) {
      const file = join(dir, `${block.line}.sh`);
      writeFileSync(file, block.code);
      const check = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
      expect(check.status, `the block on line ${block.line}: ${check.stderr}`).toBe(0);
    }
  });

  it('keeps the k3s install out of the steps (the test starts k3s in a container instead)', () => {
    expect(blocks.some((b) => /get\.k3s\.io/.test(b.code))).toBe(false);
    expect(extractBlocks(page, 'sh', 'k3s-install').length).toBe(1);
  });

  it('builds the three images, installs the operator and the chart, checks readiness and signs in, in that order', () => {
    const joined = blocks.map((b) => b.code).join('\n');
    const at = (needle: string): number => joined.indexOf(needle);
    const order = ['docker build -f deploy/docker/server.Dockerfile', 'cloudnative-pg', 'helm upgrade --install manythreads', 'rollout status deploy/manythreads-server', '/readyz', '/api/bootstrap/', '/api/auth/password/sign-in'].map(at);
    expect(order.every((i) => i >= 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('never uses sudo, never touches a cluster by name and never stores a secret of the project', () => {
    const joined = blocks.map((b) => b.code).join('\n');
    expect(joined).not.toMatch(/\bsudo\b/);
    expect(joined).not.toMatch(/--context|KUBECONFIG=/);
    expect(joined).not.toMatch(/\.credentials\.json|auth\.json/);
  });

  it('the script prints the same steps as the page, through --print-steps', () => {
    const out = spawnSync('bash', [join(root, 'tools/deploy-test/k3s-fresh.sh'), '--print-steps'], { encoding: 'utf8', cwd: root });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toBe(scriptOf(blocks, PAGE));
  });
});
