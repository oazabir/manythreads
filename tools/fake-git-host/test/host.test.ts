import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startFakeGitHost, type FakeGitHost } from '../src/index.ts';

// P27-19: the fake git host, with the real `git` for the git side and plain fetch for the REST side.

const TOKEN = ['ghp', 'FakeHostTokenValue0123456789'].join('_'); // built, so it is not shaped like a real token in the file
let host: FakeGitHost | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await host?.stop();
  host = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'fake-git-test-'));
  dirs.push(d);
  return d;
};
/** Async on purpose: the host runs in this process, so a blocking spawn would stop it from answering. */
const git = (cwd: string, ...args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn('git', ['-c', 'credential.helper=', '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const withToken = (url: string, token = TOKEN): string => url.replace('://', `://x-access-token:${token}@`);
const api = (path: string, token = TOKEN) => fetch(`${host!.apiUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });

describe('the REST side', () => {
  it('says who the token belongs to and whether it can push, and turns a bad token down with 401', async () => {
    host = await startFakeGitHost({ token: TOKEN, owner: 'acme', repos: ['widgets', 'docs'], readOnlyRepos: ['docs'] });
    expect(await (await api('/user')).json()).toMatchObject({ login: 'acme' });
    expect(await (await api('/repos/acme/widgets')).json()).toMatchObject({ permissions: { push: true } });
    expect(await (await api('/repos/acme/docs')).json()).toMatchObject({ permissions: { push: false } });
    expect((await api('/user', 'wrong')).status).toBe(401);
    expect(host.calls.map((c) => c.path)).toEqual(['/user', '/repos/acme/widgets', '/repos/acme/docs', '/user']);
    expect(host.calls.at(-1)!.authorized).toBe(false);
    expect(JSON.stringify(host.calls)).not.toContain(TOKEN);
  });

  it('lists and opens pull requests like GitHub', async () => {
    host = await startFakeGitHost({ token: TOKEN, owner: 'acme', repos: ['widgets'] });
    const open = await fetch(`${host.apiUrl}/repos/acme/widgets/pulls`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ title: 'T', head: 'card-1', base: 'main' }) });
    expect(open.status).toBe(201);
    const list = (await (await api('/repos/acme/widgets/pulls?head=acme:card-1&state=open')).json()) as Array<{ number: number }>;
    expect(list).toHaveLength(1);
  });
});

describe('the git side', () => {
  it('clones with the token as the password, pushes a branch, and says where the branch is', async () => {
    host = await startFakeGitHost({ token: TOKEN, owner: 'acme', repos: ['widgets'] });
    const work = join(tmp(), 'w');
    const clone = await git(tmpdir(), 'clone', withToken(host.remoteUrl('widgets')), work);
    expect(clone.status, clone.stderr).toBe(0);
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toContain('widgets');
    writeFileSync(join(work, 'a.txt'), 'a\n');
    expect((await git(work, 'add', '.')).status).toBe(0);
    expect((await git(work, 'commit', '-m', 'change')).status).toBe(0);
    const push = await git(work, 'push', 'origin', 'HEAD:refs/heads/card-1');
    expect(push.status, push.stderr).toBe(0);
    const head = (await git(work, 'rev-parse', 'HEAD')).stdout.trim();
    expect(host.branchHead('widgets', 'card-1')).toBe(head);
    expect(host.branchHead('widgets', 'nope')).toBeNull();
    expect(host.gitCalls.some((c) => c.path.includes('git-receive-pack') && c.authorized)).toBe(true);
  });

  it('refuses a wrong token, an unknown repository, and a push to a read-only repository', async () => {
    host = await startFakeGitHost({ token: TOKEN, owner: 'acme', repos: ['widgets', 'docs'], readOnlyRepos: ['docs'] });
    expect((await git(tmp(), 'clone', withToken(host.remoteUrl('widgets'), 'wrong'), 'x')).status).not.toBe(0);
    expect((await git(tmp(), 'clone', withToken(`${host.gitUrl}/acme/nothing.git`), 'x')).status).not.toBe(0);
    const work = join(tmp(), 'd');
    expect((await git(tmpdir(), 'clone', withToken(host.remoteUrl('docs')), work)).status).toBe(0);
    writeFileSync(join(work, 'b.txt'), 'b\n');
    await git(work, 'add', '.');
    await git(work, 'commit', '-m', 'x');
    expect((await git(work, 'push', 'origin', 'HEAD:refs/heads/card-2')).status).not.toBe(0);
    expect(host.branchHead('docs', 'card-2')).toBeNull();
  });
});
