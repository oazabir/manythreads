import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGithub, type FakeGithub } from '../../../test-utils/src/fake-github.ts';

// The workbench's publish scripts against real git and a local double of GitHub: mt-publish.sh (push the tested branch, open the pull request),
// mt-push-sync.sh (hand the token to the `repo` user alone) and mt-askpass.sh (how git gets the token without it being in a command line).
// The scripts' paths and the "repo" account are overridable for exactly this (MT_REPOS_DIR, MT_PUSH_DIR, MT_REPO_USER, MT_GITHUB_API, MT_PUSH_URL);
// a bot cannot set them: sudo clears its environment and allows only fixed command shapes.

const SCRIPTS = fileURLToPath(new URL('../../../../deploy/images/workbench', import.meta.url));
const PUBLISH = join(SCRIPTS, 'mt-publish.sh');
const TOKEN = 'ghp_TestTokenValue0123456789abcdefghij';
const CARD = '1a2b3c4d-1111-4222-8333-444455556666';
const BRANCH = 'card-1a2b3c4d';
const ME = userInfo().username;
const ORIGIN = 'https://github.com/acme/widgets.git';
/** What the pod's Secret holds for a project: the token and the address it was issued for. */
const secretDoc = (token = TOKEN, origin = ORIGIN, branch = 'main') => JSON.stringify({ branch, origin, token });

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let gh: FakeGithub;
let headSha = '';
let mainSha = '';

// asynchronous: the double of GitHub runs in this process, so a blocking spawn would starve it
function run(script: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', [script, ...args], {
      env: {
        PATH: process.env['PATH']!,
        HOME: root,
        MT_REPOS_DIR: join(root, 'repos'),
        MT_PUSH_DIR: join(root, 'push'),
        MT_REPO_USER: ME,
        MT_GITHUB_API: gh.url,
        MT_PUSH_URL: join(root, 'origin.git'),
        ...opts.env,
      },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    // the script may exit (a refusal) before it reads its standard input: that is not an error of the test
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
}

beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', repo: 'widgets' });
});
afterAll(async () => {
  await gh.stop();
});

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  gh.pulls.clear();
  gh.calls.length = 0;
  root = mkdtempSync(join(tmpdir(), 'mt-publish-'));
  mkdirSync(join(root, 'repos'));
  mkdirSync(join(root, 'push'), { mode: 0o700 });
  // the "origin" the push goes to, and the repository of record whose origin address is the GitHub one
  git(root, 'init', '--bare', '-b', 'main', 'origin.git');
  const work = join(root, 'work');
  git(root, 'init', '-b', 'main', work);
  writeFileSync(join(work, 'a.txt'), 'one\n');
  git(work, 'add', '.');
  git(work, 'commit', '-m', 'first');
  mainSha = git(work, 'rev-parse', 'HEAD');
  git(work, 'checkout', '-b', BRANCH);
  writeFileSync(join(work, 'a.txt'), 'two\n');
  git(work, 'commit', '-am', 'the change');
  headSha = git(work, 'rev-parse', 'HEAD');
  git(root, 'init', '--bare', '-b', 'main', 'repos/widgets.git');
  git(work, 'push', join(root, 'repos/widgets.git'), 'main', BRANCH);
  git(join(root, 'repos/widgets.git'), 'remote', 'add', 'origin', ORIGIN);
  git(join(root, 'origin.git'), 'config', 'receive.denyNonFastForwards', 'true');
  writeFileSync(join(root, 'push/widgets'), secretDoc());
  chmodSync(join(root, 'push/widgets'), 0o400);
});

describe('mt-publish.sh check', () => {
  it('says ready when the project has an origin and a token', async () => {
    expect(await run(PUBLISH, ['check', 'widgets'])).toMatchObject({ code: 0, out: 'ready\n' });
  });
  it('says there is no credential without a token, and for a repository that does not exist', async () => {
    rmSync(join(root, 'push/widgets'));
    expect(await run(PUBLISH, ['check', 'widgets'])).toMatchObject({ code: 3 });
    expect((await run(PUBLISH, ['check', 'nothing'])).code).toBe(2);
  });
  it('refuses a name that is not a plain project name', async () => {
    for (const bad of ['../x', 'a/b', 'A', '', '-x']) expect((await run(PUBLISH, ['check', bad])).code).toBe(2);
  });
});

describe('mt-publish.sh publish', () => {
  const publish = (sha = headSha, title = 'Fix the widget', input = 'The change, tested.\n') => run(PUBLISH, ['publish', 'widgets', CARD, sha, title], { input });

  it('pushes the card branch to the origin and opens the pull request', async () => {
    const r = await publish();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/pull_request_number=\d+/);
    expect(r.out).toContain('pull_request_url=');
    expect(r.out).toContain(`head_sha=${headSha}`);
    expect(git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`)).toBe(headSha);
    // main on the origin was never pushed
    expect(spawnSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', '--verify', '-q', 'refs/heads/main']).status).not.toBe(0);
    const made = gh.calls.find((c) => c.method === 'POST')!;
    const doc = JSON.parse(made.body) as { title: string; head: string; base: string; body: string };
    expect(doc).toMatchObject({ title: 'Fix the widget', head: BRANCH, base: 'main' });
    expect(doc.body).toContain('The change, tested.');
    expect(doc.body).toContain(CARD);
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
  });

  it('never prints the token, and never sends it in a request body', async () => {
    const r = await publish();
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(gh.calls.map((c) => c.body).join('')).not.toContain(TOKEN);
  });

  it('refuses when the branch head is not the tested commit, and pushes and asks GitHub nothing', async () => {
    const r = await publish(mainSha);
    expect(r.code).toBe(4);
    expect(r.err).toContain('not at the tested commit');
    expect(gh.calls).toHaveLength(0);
    expect(spawnSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status).not.toBe(0);
  });

  it('refuses a commit that does not exist in the repository, and a branch that was never pushed', async () => {
    expect((await publish('f'.repeat(40))).code).toBe(4);
    expect((await run(PUBLISH, ['publish', 'widgets', '99999999-1111-4222-8333-444455556666', headSha, 't'])).code).toBe(4);
    expect(gh.calls).toHaveLength(0);
  });

  it('is safe to run again: the second run finds the open pull request and opens no second one', async () => {
    const first = await publish();
    expect(first.code).toBe(0);
    gh.pulls.get(Number(/pull_request_number=(\d+)/.exec(first.out)![1]))!.headSha = headSha; // GitHub reports the branch head
    const again = await publish();
    expect(again.code).toBe(0);
    expect(again.out).toBe(first.out);
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(gh.pulls.size).toBe(1);
  });

  it('refuses a card id, commit or title that is not well formed', async () => {
    expect((await run(PUBLISH, ['publish', 'widgets', 'card-1a2b3c4d', headSha, 't'])).code).toBe(2);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, 'HEAD', 't'])).code).toBe(2);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'two\nlines'])).code).toBe(2);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, ''])).code).toBe(2);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'x'.repeat(201)])).code).toBe(2);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha])).code).toBe(2);
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses without a token', async () => {
    rmSync(join(root, 'push/widgets'));
    expect((await publish()).code).toBe(3);
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses a token that was issued for another address than the repository’s origin now is (the project moved)', async () => {
    writeFileSync(join(root, 'push/widgets.new'), secretDoc(TOKEN, 'https://github.com/acme/other.git'));
    rmSync(join(root, 'push/widgets'));
    spawnSync('mv', [join(root, 'push/widgets.new'), join(root, 'push/widgets')]);
    chmodSync(join(root, 'push/widgets'), 0o400);
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
    expect((await publish()).code).toBe(3);
    expect(gh.calls).toHaveLength(0);
  });

  it('aims the pull request at the branch the token was issued for, not at the repository’s HEAD, and asks about open ones of that base only', async () => {
    rmSync(join(root, 'push/widgets'));
    writeFileSync(join(root, 'push/widgets'), secretDoc(TOKEN, ORIGIN, 'release/1.0'));
    chmodSync(join(root, 'push/widgets'), 0o400);
    expect((await publish()).code).toBe(0);
    expect(JSON.parse(gh.calls.find((c) => c.method === 'POST')!.body)).toMatchObject({ base: 'release/1.0' });
    expect(gh.calls.find((c) => c.method === 'GET')!.path).toContain('base=release/1.0');
  });

  it('refuses a token document that names no branch', async () => {
    rmSync(join(root, 'push/widgets'));
    writeFileSync(join(root, 'push/widgets'), JSON.stringify({ origin: ORIGIN, token: TOKEN }));
    chmodSync(join(root, 'push/widgets'), 0o400);
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
    expect((await publish()).code).toBe(3);
  });

  it('refuses when the open pull request of the branch is not at the tested commit', async () => {
    const first = await publish();
    const n = Number(/pull_request_number=(\d+)/.exec(first.out)![1]);
    gh.pulls.get(n)!.headSha = mainSha; // GitHub says the pull request is somewhere else
    const again = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 't'], { input: 'x', env: { MT_PR_TRIES: '2', MT_PR_WAIT: '0' } });
    expect(again.code).toBe(4);
    expect(again.err).toContain('not at the tested commit');
  });

  it('waits for GitHub to move the open pull request to the pushed commit', async () => {
    const first = await publish();
    const n = Number(/pull_request_number=(\d+)/.exec(first.out)![1]);
    gh.pulls.get(n)!.headSha = mainSha; // GitHub has not caught up yet
    setTimeout(() => (gh.pulls.get(n)!.headSha = headSha), 700);
    const again = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 't'], { input: 'x', env: { MT_PR_TRIES: '20', MT_PR_WAIT: '0.2' } });
    expect(again.code).toBe(0);
    expect(again.out).toContain(`pull_request_number=${n}`);
  });

  it('refuses a token file that is a symlink, or that another user owns', async () => {
    rmSync(join(root, 'push/widgets'));
    writeFileSync(join(root, 'elsewhere'), secretDoc());
    spawnSync('ln', ['-s', join(root, 'elsewhere'), join(root, 'push/widgets')]);
    expect((await publish()).code).toBe(3);
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 't'], { env: { MT_REPO_USER: 'nobody' } })).code).toBe(2);
  });

  it('refuses when the origin is not a plain https GitHub address', async () => {
    for (const odd of ['https://user@github.com/acme/widgets.git', 'https://github.com/acme/widgets/extra/deep.git']) {
      git(join(root, 'repos/widgets.git'), 'remote', 'set-url', 'origin', odd);
      rmSync(join(root, 'push/widgets'));
      writeFileSync(join(root, 'push/widgets'), secretDoc(TOKEN, odd)); // the token even matches: the address itself is the problem
      chmodSync(join(root, 'push/widgets'), 0o400);
      expect((await publish()).code, odd).toBe(2);
    }
    expect(gh.calls).toHaveLength(0);
  });

  it('does not force: an origin branch that holds other work refuses the push, and no pull request is opened', async () => {
    // someone already put a different commit on the branch name at the origin
    const other = join(root, 'other');
    git(root, 'clone', '-q', join(root, 'repos/widgets.git'), other);
    git(other, 'checkout', '-q', '-b', BRANCH, 'main');
    writeFileSync(join(other, 'b.txt'), 'x\n');
    git(other, 'add', '.');
    git(other, 'commit', '-m', 'unrelated');
    git(other, 'push', '-q', join(root, 'origin.git'), BRANCH);
    const before = git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`);
    const r = await publish();
    expect(r.code).toBe(5);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`)).toBe(before);
    expect(gh.calls).toHaveLength(0);
  });

  it('reports a refusal by GitHub without the token, with a distinct exit code', async () => {
    gh.failNext(500, {}, 5);
    const r = await publish();
    expect(r.code).toBe(6);
    expect(r.out + r.err).not.toContain(TOKEN);
  });
});

describe('mt-push-sync.sh', () => {
  const SYNC = join(SCRIPTS, 'mt-push-sync.sh');
  let src: string;
  const sync = (): ReturnType<typeof run> => run(SYNC, [], { env: { MT_PUSH_SRC: src } });
  beforeEach(() => {
    src = join(root, 'src');
    mkdirSync(src);
  });

  it('copies each token for the repo user alone: mode 0400, in a directory only root writes', async () => {
    writeFileSync(join(src, 'widgets'), secretDoc());
    writeFileSync(join(src, 'gadgets'), secretDoc('other-token-0123456789'));
    rmSync(join(root, 'push'), { recursive: true });
    expect((await sync()).code).toBe(0);
    expect(readFileSync(join(root, 'push/widgets'), 'utf8')).toBe(secretDoc());
    expect(statSync(join(root, 'push/widgets')).mode & 0o777).toBe(0o400);
    // only root writes the directory (a fresh memory volume is world-writable: the sync makes it root's)
    expect(statSync(join(root, 'push')).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(root, 'push')).sort()).toEqual(['gadgets', 'widgets']);
  });

  it('drops a token whose key left the Secret, picks up a changed one, and ignores names that are not project names', async () => {
    writeFileSync(join(src, 'widgets'), 'first-token-0123456789ab');
    writeFileSync(join(src, 'Bad Name'), 'x');
    writeFileSync(join(src, '..data'), 'x');
    expect((await sync()).code).toBe(0);
    expect(readdirSync(join(root, 'push'))).toEqual(['widgets']);
    writeFileSync(join(src, 'widgets'), 'second-token-0123456789a');
    await sync();
    expect(readFileSync(join(root, 'push/widgets'), 'utf8')).toBe('second-token-0123456789a');
    rmSync(join(src, 'widgets'));
    await sync();
    expect(existsSync(join(root, 'push/widgets'))).toBe(false);
  });

  it('removes everything when the Secret mount is gone', async () => {
    rmSync(src, { recursive: true });
    expect((await sync()).code).toBe(0);
    expect(readdirSync(join(root, 'push'))).toEqual([]);
  });
});

describe('mt-askpass.sh', () => {
  const ASK = join(SCRIPTS, 'mt-askpass.sh');
  it('answers git for the user name and the password from the token file, and nothing else', async () => {
    const env = { PATH: process.env['PATH']!, MT_TOKEN_FILE: join(root, 'push/widgets') };
    expect(spawnSync('bash', [ASK, "Username for 'https://github.com': "], { env, encoding: 'utf8' }).stdout).toBe('x-access-token\n');
    expect(spawnSync('bash', [ASK, "Password for 'https://x-access-token@github.com': "], { env, encoding: 'utf8' }).stdout).toBe(TOKEN);
    const other = spawnSync('bash', [ASK, 'Passphrase: '], { env, encoding: 'utf8' });
    expect(other.status).toBe(1);
    expect(other.stdout).toBe('');
  });
});
