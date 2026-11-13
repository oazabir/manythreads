import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** The `head_sha=` line of a publish: the squashed commit the request is at. */
const sha = (out: string): string => /head_sha=([0-9a-f]+)/.exec(out)![1]!;
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A local double of the part of GitLab's REST API that publishing uses: list and open merge requests. The token is the one in the PRIVATE-TOKEN header. */
interface FakeMr {
  iid: number;
  source_branch: string;
  target_branch: string;
  title: string;
  description: string;
  sha: string;
  state: 'opened' | 'closed';
}
interface FakeGitlab {
  url: string;
  mrs: Map<number, FakeMr>;
  calls: { method: string; path: string; body: string; authorized: boolean }[];
  /** What the double asks to learn the head of a branch (the tests answer with the origin's real branch). */
  shaOf: (branch: string) => string;
  reset(): void;
  stop(): Promise<void>;
}
async function startFakeGitlab(token: string, shaOf: (branch: string) => string): Promise<FakeGitlab> {
  const mrs = new Map<number, FakeMr>();
  const calls: FakeGitlab['calls'] = [];
  let next = 1;
  let base = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', 'http://x');
      const authorized = req.headers['private-token'] === token;
      calls.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body, authorized });
      const send = (status: number, doc: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(doc));
      };
      if (!authorized) return send(401, { message: '401 Unauthorized' });
      const m = /^\/projects\/([^/]+)\/merge_requests$/.exec(url.pathname);
      if (!m) return send(404, { message: '404 Not Found' });
      const view = (r: FakeMr): unknown => ({ iid: r.iid, web_url: `${base}/${decodeURIComponent(m[1]!)}/-/merge_requests/${r.iid}`, sha: r.sha, state: r.state, title: r.title });
      if (req.method === 'GET') {
        const want = url.searchParams;
        return send(200, [...mrs.values()].filter((r) => r.source_branch === want.get('source_branch') && r.target_branch === want.get('target_branch') && r.state === want.get('state')).map(view));
      }
      if (req.method === 'POST') {
        const doc = JSON.parse(body) as Omit<FakeMr, 'iid' | 'sha' | 'state'>;
        const r: FakeMr = { ...doc, iid: next++, sha: shaOf(doc.source_branch), state: 'opened' };
        mrs.set(r.iid, r);
        return send(201, view(r));
      }
      return send(405, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    mrs,
    calls,
    shaOf,
    reset: () => {
      mrs.clear();
      calls.length = 0;
      next = 1;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let root: string;
let gh: FakeGithub;
let gl: FakeGitlab;
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
        MT_GITLAB_API: gl.url,
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
  gl = await startFakeGitlab(TOKEN, (branch) => git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${branch}`));
});
afterAll(async () => {
  await gh.stop();
  await gl.stop();
});

beforeEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  gh.pulls.clear();
  gh.calls.length = 0;
  gl.reset();
  gh.failNext(500, {}, 0);
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
  git(work, 'push', join(root, 'origin.git'), 'main'); // the origin has the project's main branch: the publish builds on its tip
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
  it('says the token was refused (exit 7) once the platform marked it, and says ready again when the mark is gone', async () => {
    writeFileSync(join(root, 'push/widgets'), JSON.stringify({ branch: 'main', origin: ORIGIN, token: TOKEN, refused: true }), { mode: 0o400 });
    const r = await run(PUBLISH, ['check', 'widgets']);
    expect(r.code).toBe(7);
    expect(r.out).toContain('token refused');
    expect(r.out + r.err).not.toContain(TOKEN);
    writeFileSync(join(root, 'push/widgets'), secretDoc(), { mode: 0o600 });
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(0);
  });
});

describe('a project on the team’s token for its owner', () => {
  const OWNER_FILE = '_owner.github.com.acme';
  /** The project's own file holds the address and branch and names the owner file that holds the token. */
  const linked = (refused = false) => {
    writeFileSync(join(root, 'push/widgets'), JSON.stringify({ branch: 'main', origin: ORIGIN, via: OWNER_FILE }), { mode: 0o400 });
    writeFileSync(join(root, 'push', OWNER_FILE), JSON.stringify({ token: TOKEN, ...(refused ? { refused: true } : {}) }), { mode: 0o400 });
  };

  it('is ready, and publishes with the owner’s token', async () => {
    linked();
    expect((await run(PUBLISH, ['check', 'widgets'])).out).toBe('ready\n');
    const r = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'tested\n' });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/pull_request_number=\d+/);
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
    expect(r.out + r.err).not.toContain(TOKEN);
  });
  it('has no credential when the owner’s file is missing, and refuses when the owner’s token was marked refused', async () => {
    linked();
    rmSync(join(root, 'push', OWNER_FILE));
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
    linked(true);
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(7);
    const r = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'tested\n' });
    expect(r.code).toBe(7);
    expect(gh.calls).toHaveLength(0);
  });
  it('refuses a pointer that names anything but an owner file', async () => {
    writeFileSync(join(root, 'push/widgets'), JSON.stringify({ branch: 'main', origin: ORIGIN, via: '../widgets' }), { mode: 0o400 });
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
    writeFileSync(join(root, 'push/widgets'), JSON.stringify({ branch: 'main', origin: ORIGIN, via: 'gadgets' }), { mode: 0o400 });
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
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
    // the commit the request is at is a new one (the squash), the tested one is reported beside it
    const pushed = git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`);
    expect(pushed).not.toBe(headSha);
    expect(r.out).toContain(`head_sha=${pushed}`);
    expect(r.out).toContain(`tested_sha=${headSha}`);
    expect(r.out).toContain('provider=github');
    // main on the origin was never pushed to
    expect(git(join(root, 'origin.git'), 'rev-parse', 'refs/heads/main')).toBe(mainSha);
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
    gh.pulls.get(Number(/pull_request_number=(\d+)/.exec(first.out)![1]))!.headSha = sha(first.out); // GitHub reports the branch head
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
    git(join(root, 'work'), 'push', join(root, 'origin.git'), 'main:refs/heads/release/1.0'); // the origin has that branch too
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
    const again = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'The change, tested.\n', env: { MT_PR_TRIES: '2', MT_PR_WAIT: '0' } });
    expect(again.code).toBe(4);
    expect(again.err).toContain('not at the published commit');
  });

  it('waits for GitHub to move the open pull request to the pushed commit', async () => {
    const first = await publish();
    const n = Number(/pull_request_number=(\d+)/.exec(first.out)![1]);
    gh.pulls.get(n)!.headSha = mainSha; // GitHub has not caught up yet
    setTimeout(() => (gh.pulls.get(n)!.headSha = sha(first.out)), 700);
    const again = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'The change, tested.\n', env: { MT_PR_TRIES: '20', MT_PR_WAIT: '0.2' } });
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

  it('exits 7 when GitHub answers 401 for the stored token (revoked or expired), and never prints the token', async () => {
    const stale = 'ghp_StaleTokenValue0123456789abcdefghij';
    writeFileSync(join(root, 'push/widgets'), secretDoc(stale), { mode: 0o600 });
    const r = await publish();
    expect(r.code).toBe(7);
    expect(r.err).toContain('no longer accepts');
    expect(r.out + r.err).not.toContain(stale);
    expect(gh.calls.every((c) => !c.authorized)).toBe(true);
    // a rate limit or an outage is not a refused token
    writeFileSync(join(root, 'push/widgets'), secretDoc(), { mode: 0o600 });
    gh.failNext(403, {}, 1);
    expect((await publish()).code).toBe(6);
  });

  it('reports a refusal by GitHub without the token, with a distinct exit code', async () => {
    gh.failNext(500, {}, 5);
    const r = await publish();
    expect(r.code).toBe(6);
    expect(r.out + r.err).not.toContain(TOKEN);
  });
});

/** Rewrites the project's document (and the repository of record's origin address) to say who the bot is. */
function setDoc(doc: Record<string, unknown>, origin = ORIGIN): void {
  git(join(root, 'repos/widgets.git'), 'remote', 'set-url', 'origin', origin);
  rmSync(join(root, 'push/widgets'), { force: true });
  writeFileSync(join(root, 'push/widgets'), JSON.stringify({ branch: 'main', origin, token: TOKEN, ...doc }), { mode: 0o400 });
}
/** Puts a commit on the origin's main branch, from a clone of its own. */
function moveMain(file: string, text: string): string {
  const w = join(root, 'mainwork');
  git(root, 'clone', '-q', join(root, 'origin.git'), w);
  writeFileSync(join(w, file), text);
  git(w, 'add', '.');
  git(w, 'commit', '-m', 'someone else on main');
  git(w, 'push', '-q', 'origin', 'main');
  return git(w, 'rev-parse', 'HEAD');
}
const BOT = { login: 'mt-bot', userId: '4242', commitAs: 'bot' };
const logOf = (sha: string, format: string): string => git(join(root, 'origin.git'), 'log', '-1', `--format=${format}`, sha);

describe('one squashed commit per card', () => {
  const publish = (...extra: string[]) => run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget', ...extra], { input: 'The change, tested.\n' });

  it('makes one commit on the tip of the origin’s main branch, with the tested tree, the title, the text and the card line', async () => {
    const r = await publish();
    expect(r.code, r.err).toBe(0);
    const made = sha(r.out);
    const origin = join(root, 'origin.git');
    expect(git(origin, 'rev-list', '--count', `${mainSha}..${made}`)).toBe('1');
    expect(git(origin, 'rev-parse', `${made}^`)).toBe(mainSha);
    expect(git(origin, 'rev-parse', `${made}^{tree}`)).toBe(git(join(root, 'work'), 'rev-parse', `${headSha}^{tree}`));
    expect(git(origin, 'log', '-1', '--format=%B', made)).toBe('Fix the widget\n\nThe change, tested.\n\nCard: ' + CARD);
    expect(r.out).toBe(`project=widgets\nprovider=github\npull_request_number=${/pull_request_number=(\d+)/.exec(r.out)![1]}\npull_request_url=${/pull_request_url=(\S+)/.exec(r.out)![1]}\nhead_sha=${made}\ntested_sha=${headSha}\n`);
  });

  it('cuts the text on standard input at 8000 bytes', async () => {
    const r = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'x'.repeat(9000) });
    expect(r.code, r.err).toBe(0);
    const body = git(join(root, 'origin.git'), 'log', '-1', '--format=%b', sha(r.out));
    expect(body.split('\n')[0]).toBe('x'.repeat(8000));
  });

  it('dates the commit with the tested head’s committer date, so the same card makes the same commit; the second push changes nothing and the open request is found', async () => {
    const first = await publish();
    const date = git(join(root, 'work'), 'show', '-s', '--format=%cI', headSha);
    expect(logOf(sha(first.out), '%aI')).toBe(date);
    expect(logOf(sha(first.out), '%cI')).toBe(date);
    await new Promise((r) => setTimeout(r, 1100)); // a clock that moved on would show
    [...gh.pulls.values()][0]!.headSha = sha(first.out);
    const again = await publish();
    expect(again.out).toBe(first.out);
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('builds on a main branch that moved without a conflict: the commit holds both changes', async () => {
    const tip = moveMain('b.txt', 'other work\n');
    const r = await publish();
    expect(r.code, r.err).toBe(0);
    const origin = join(root, 'origin.git');
    expect(git(origin, 'rev-parse', `${sha(r.out)}^`)).toBe(tip);
    expect(git(origin, 'rev-list', '--count', `${tip}..${sha(r.out)}`)).toBe('1');
    expect(git(origin, 'show', `${sha(r.out)}:a.txt`)).toBe('two');
    expect(git(origin, 'show', `${sha(r.out)}:b.txt`)).toBe('other work');
    expect(r.out).toContain(`tested_sha=${headSha}`);
  });

  it('exits 4 when the main branch moved in a way that conflicts, and pushes and asks the provider nothing', async () => {
    moveMain('a.txt', 'three\n');
    const r = await publish();
    expect(r.code).toBe(4);
    expect(r.err).toMatch(/main branch main moved.*rebuilt/);
    expect(gh.calls).toHaveLength(0);
    expect(spawnSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', '--verify', '-q', `refs/heads/${BRANCH}`]).status).not.toBe(0);
  });

  it('exits 4 "nothing to publish" when the main branch already holds the work', async () => {
    git(join(root, 'work'), 'push', '-q', join(root, 'origin.git'), `${BRANCH}:refs/heads/main`);
    const r = await publish();
    expect(r.code).toBe(4);
    expect(r.err).toContain('nothing to publish');
    expect(gh.calls).toHaveLength(0);
  });

  it('exits 6 when the main branch cannot be read from the origin, without pushing', async () => {
    git(join(root, 'origin.git'), 'update-ref', '-d', 'refs/heads/main');
    const r = await publish();
    expect(r.code).toBe(6);
    expect(r.err).toContain('main branch main could not be read');
    expect(gh.calls).toHaveLength(0);
  });

  it('leaves no ref behind in the repository of record', async () => {
    await publish();
    expect(git(join(root, 'repos/widgets.git'), 'for-each-ref', '--format=%(refname)').split('\n').sort()).toEqual(['refs/heads/card-1a2b3c4d', 'refs/heads/main']);
  });
});

describe('who signs the commit', () => {
  const publish = (...extra: string[]) => run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget', ...extra], { input: 'The change, tested.\n' });
  const people = (r: { out: string }): string => logOf(sha(r.out), '%an <%ae>|%cn <%ce>');

  it('a document with no identity (written before GitLab support) publishes to GitHub as manythreads-bot', async () => {
    const r = await publish();
    expect(r.out).toContain('provider=github');
    expect(people(r)).toBe('manythreads-bot <noreply@manythreads.invalid>|manythreads-bot <noreply@manythreads.invalid>');
  });

  it('commit as the bot: author and committer are the bot account (GitHub no-reply address), and author arguments are ignored', async () => {
    setDoc(BOT);
    const bot = 'mt-bot <4242+mt-bot@users.noreply.github.com>';
    expect(people(await publish())).toBe(`${bot}|${bot}`);
    gh.pulls.clear();
    const ignored = await publish('Eve Mallory', 'eve@example.org');
    expect(ignored.code, ignored.err).toBe(0);
    expect(people(ignored)).toBe(`${bot}|${bot}`);
  });

  it('commit as the requester: the author is the requester, the committer is still the bot', async () => {
    setDoc({ ...BOT, commitAs: 'requester' });
    const r = await publish('Sameera Perera', 'sameera@example.org');
    expect(r.code, r.err).toBe(0);
    expect(people(r)).toBe('Sameera Perera <sameera@example.org>|mt-bot <4242+mt-bot@users.noreply.github.com>');
  });

  it('commit as the requester without the name and email is refused, and so is a name or email that is not one', async () => {
    setDoc({ ...BOT, commitAs: 'requester' });
    const none = await publish();
    expect(none.code).toBe(2);
    expect(none.err).toContain("signs commits with the requester's name and email: pass them");
    for (const [name, email] of [['', 'a@b.co'], ['x'.repeat(101), 'a@b.co'], ['A <B>', 'a@b.co'], ['A\nB', 'a@b.co'], ['A B', 'not-an-email'], ['A B', 'a@b'], ['A B', 'a b@c.de'], ['A B', 'a@b.co>'], ['A B', `${'a'.repeat(200)}@b.co`]]) {
      expect((await publish(name!, email!)).code, `${name}|${email}`).toBe(2);
    }
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 't', 'OnlyAName'])).code).toBe(2); // the two come together or not at all
    expect((await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 't', 'A', 'a@b.co', 'extra'])).code).toBe(2);
    expect(gh.calls).toHaveLength(0);
  });

  it('GitHub Enterprise: the bot’s address is <login>@noreply.<host>', async () => {
    setDoc(BOT, 'https://ghe.example.org/acme/widgets');
    const r = await publish();
    expect(r.code, r.err).toBe(0);
    expect(people(r)).toBe('mt-bot <mt-bot@noreply.ghe.example.org>|mt-bot <mt-bot@noreply.ghe.example.org>');
  });

  it('a name never reaches git as an option or a header: odd but allowed characters are kept as they are', async () => {
    setDoc({ ...BOT, commitAs: 'requester' });
    const r = await publish('-Zoë "Q" O’Neil; $(id)', 'z+tag@sub.example.org');
    expect(r.code, r.err).toBe(0);
    expect(people(r)).toBe('-Zoë "Q" O’Neil; $(id) <z+tag@sub.example.org>|mt-bot <4242+mt-bot@users.noreply.github.com>');
  });
});

describe('a GitLab project', () => {
  const GITLAB = 'https://gitlab.example.org/group/sub/widgets.git';
  const GL_DOC = { provider: 'gitlab', ...BOT };
  beforeEach(() => setDoc(GL_DOC, GITLAB));
  const publish = (...extra: string[]) => run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget', ...extra], { input: 'The change, tested.\n' });

  it('says ready, and names GitLab when the token was refused', async () => {
    expect(await run(PUBLISH, ['check', 'widgets'])).toMatchObject({ code: 0, out: 'ready\n' });
    setDoc({ ...GL_DOC, refused: true }, GITLAB);
    const r = await run(PUBLISH, ['check', 'widgets']);
    expect(r.code).toBe(7);
    expect(r.out).toContain('GitLab no longer accepts');
  });

  it('pushes the squashed commit and opens a merge request of a project in nested groups, with the token in a header only', async () => {
    const r = await publish();
    expect(r.code, r.err).toBe(0);
    const made = git(join(root, 'origin.git'), 'rev-parse', `refs/heads/${BRANCH}`);
    expect(r.out).toBe(`project=widgets\nprovider=gitlab\npull_request_number=1\npull_request_url=${gl.url}/group/sub/widgets/-/merge_requests/1\nhead_sha=${made}\ntested_sha=${headSha}\n`);
    expect(git(join(root, 'origin.git'), 'rev-list', '--count', `${mainSha}..${made}`)).toBe('1');
    const list = gl.calls.find((c) => c.method === 'GET')!;
    expect(list.path).toBe(`/projects/group%2Fsub%2Fwidgets/merge_requests?source_branch=${BRANCH}&target_branch=main&state=opened`);
    const post = gl.calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/projects/group%2Fsub%2Fwidgets/merge_requests');
    const doc = JSON.parse(post.body) as Record<string, unknown>;
    expect(doc).toMatchObject({ source_branch: BRANCH, target_branch: 'main', title: 'Fix the widget', remove_source_branch: true, squash: false });
    expect(String(doc['description'])).toContain('The change, tested.');
    expect(String(doc['description'])).toContain(CARD);
    expect(gl.calls.every((c) => c.authorized)).toBe(true);
    expect(gh.calls).toHaveLength(0);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(gl.calls.map((c) => c.body + c.path).join('')).not.toContain(TOKEN);
    expect(people(made)).toBe('mt-bot <4242-mt-bot@users.noreply.gitlab.example.org>|mt-bot <4242-mt-bot@users.noreply.gitlab.example.org>');
  });
  const people = (made: string): string => logOf(made, '%an <%ae>|%cn <%ce>');

  it('finds the merge request that is already open instead of opening a second, and the second push changes nothing', async () => {
    const first = await publish();
    expect(first.code, first.err).toBe(0);
    const again = await publish();
    expect(again.code, again.err).toBe(0);
    expect(again.out).toBe(first.out);
    expect(gl.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(gl.mrs.size).toBe(1);
  });

  it('refuses when the open merge request is not at the published commit', async () => {
    const first = await publish();
    gl.mrs.get(1)!.sha = mainSha;
    expect(first.code).toBe(0);
    const again = await run(PUBLISH, ['publish', 'widgets', CARD, headSha, 'Fix the widget'], { input: 'The change, tested.\n', env: { MT_PR_TRIES: '2', MT_PR_WAIT: '0' } });
    expect(again.code).toBe(4);
    expect(again.err).toContain('not at the published commit');
  });

  it('exits 7 when GitLab answers 401, naming GitLab and never printing the token', async () => {
    const stale = 'glpat-StaleTokenValue0123456789';
    setDoc({ ...GL_DOC, token: stale }, GITLAB);
    const r = await publish();
    expect(r.code).toBe(7);
    expect(r.err).toContain('GitLab no longer accepts');
    expect(r.out + r.err).not.toContain(stale);
    expect(gl.calls.every((c) => !c.authorized)).toBe(true);
  });

  it('signs as the requester when the document says so', async () => {
    setDoc({ ...GL_DOC, commitAs: 'requester' }, GITLAB);
    const r = await publish('Sameera Perera', 'sameera@example.org');
    expect(r.code, r.err).toBe(0);
    expect(people(sha(r.out))).toBe('Sameera Perera <sameera@example.org>|mt-bot <4242-mt-bot@users.noreply.gitlab.example.org>');
  });

  it('accepts 2 to 20 segments, and refuses others, an odd segment, or a nested path on GitHub', async () => {
    const seg = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`).join('/');
    for (const ok of ['https://gitlab.com/a/b', `https://gitlab.example.org/${seg(19)}/r`]) {
      setDoc(GL_DOC, ok);
      expect((await run(PUBLISH, ['check', 'widgets'])).out, ok).toBe('ready\n');
    }
    for (const bad of ['https://gitlab.com/onlyone', `https://gitlab.example.org/${seg(20)}/r`, 'https://gitlab.com/a/-b', 'https://gitlab.com/a/b c', 'https://gitlab.com/a/../b', 'https://user@gitlab.com/a/b']) {
      setDoc(GL_DOC, bad);
      expect((await run(PUBLISH, ['check', 'widgets'])).code, bad).toBe(3);
      expect((await publish()).code, bad).toBe(2); // the token matches, the address is the problem
    }
    // the same nested address under GitHub is not an owner and a repository
    setDoc({ ...BOT, provider: 'github' }, 'https://github.com/a/b/c');
    expect((await run(PUBLISH, ['check', 'widgets'])).code).toBe(3);
    expect((await publish()).code).toBe(2);
    expect(gl.calls).toHaveLength(0);
  });

  it('asks git for the user name oauth2 (and x-access-token for GitHub)', () => {
    const env = { PATH: process.env['PATH']!, MT_TOKEN_FILE: join(root, 'push/widgets') };
    const ask = (extra: Record<string, string>) => spawnSync('bash', [join(SCRIPTS, 'mt-askpass.sh'), "Username for 'https://gitlab.example.org': "], { env: { ...env, ...extra }, encoding: 'utf8' }).stdout;
    expect(ask({ MT_GIT_USER: 'oauth2' })).toBe('oauth2\n');
    expect(ask({})).toBe('x-access-token\n');
    expect(spawnSync('bash', [join(SCRIPTS, 'mt-askpass.sh'), 'Password for x: '], { env: { ...env, MT_GIT_USER: 'oauth2' }, encoding: 'utf8' }).stdout).toBe(TOKEN);
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

  it('carries an owner’s token file too, under its own name, and still ignores other names', async () => {
    writeFileSync(join(src, 'widgets'), JSON.stringify({ branch: 'main', origin: ORIGIN, via: '_owner.github.com.acme' }));
    writeFileSync(join(src, '_owner.github.com.acme'), JSON.stringify({ token: TOKEN }));
    writeFileSync(join(src, '_other.github.com.acme'), 'x');
    writeFileSync(join(src, '_owner..x'), 'x');
    expect((await sync()).code).toBe(0);
    expect(readdirSync(join(root, 'push')).sort()).toEqual(['_owner.github.com.acme', 'widgets']);
    expect(statSync(join(root, 'push/_owner.github.com.acme')).mode & 0o777).toBe(0o400);
    rmSync(join(src, '_owner.github.com.acme'));
    await sync();
    expect(existsSync(join(root, 'push/_owner.github.com.acme'))).toBe(false);
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
