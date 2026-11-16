import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeGithub, type FakeGithub, type FakeGithubCall } from '../../../packages/test-utils/src/fake-github.ts';

/*
 * A small fake git host (P27-19): the parts of GitHub the setup journey and the engineering chain use, over real HTTP, with no account and no network.
 *   - the REST API (`apiUrl`): `GET /user`, `GET /repos/<owner>/<repo>` (with `permissions.push`), and the pull requests the publisher lists and opens — the
 *     same double the unit tests use (packages/test-utils/src/fake-github.ts), so the Projects token check and `mt-publish` see what they see in tests;
 *   - the git side (`gitUrl`): bare repositories served by `git http-backend`, so `git clone` and `git push` work for real against
 *     `<gitUrl>/<owner>/<repo>.git` with the token as the password (any user name), the way a pod pushes to GitHub.
 * It accepts only the one token it was started with (401 otherwise), keeps every call for a test to read, and never records a token.
 * Library: `startFakeGitHost()` → `{ apiUrl, gitUrl, url, remoteUrl, calls, gitCalls, branchHead, stop }`. CLI: `tsx src/cli.ts` (see cli.ts).
 */

export interface FakeGitHostOptions {
  /** The one token the host accepts. */
  token: string;
  /** The account the token belongs to (`GET /user`); also the owner of the repositories. Default `demo-owner`. */
  owner?: string;
  /** Repositories to create, each with one commit on `main` (default one called `starter`). */
  repos?: string[];
  /** A repository the token may read but not push to (REST says `push: false`; git refuses the push). */
  readOnlyRepos?: string[];
  /** Fixed port for the REST API and for git (0 = any, the default). */
  apiPort?: number;
}

export interface GitHostCall {
  method: string;
  path: string;
  authorized: boolean;
}

export interface FakeGitHost {
  /** The REST API's base (`http://127.0.0.1:<port>`): what `MANYTHREADS_TEST_GITHUB_API`, `MT_GITHUB_API` and a project's API base point at. */
  apiUrl: string;
  /** Same as `apiUrl` (the address a spec puts first). */
  url: string;
  /** The git server's base: a repository is `<gitUrl>/<owner>/<repo>.git`. */
  gitUrl: string;
  /** The origin of a repository as a project keeps it. */
  remoteUrl(repo: string): string;
  /** Every REST call, in order (the request body as sent: a pull request's title and text, never the token). */
  calls: FakeGithubCall[];
  /** Every git request, in order (`GET /<owner>/<repo>.git/info/refs?service=git-receive-pack`, ...). */
  gitCalls: GitHostCall[];
  /** The REST double, for `pulls`, `merge`, `close` and `failNext`. */
  github: FakeGithub;
  /** The commit a branch of a repository is at (null: no such branch). */
  branchHead(repo: string, branch: string): string | null;
  stop(): Promise<void>;
}

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@example.invalid', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@example.invalid' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A bare repository with one commit (a README) on `main`. */
function makeBare(root: string, owner: string, repo: string, pushable: boolean): string {
  const bare = join(root, owner, `${repo}.git`);
  mkdirSync(bare, { recursive: true });
  git(bare, 'init', '--bare', '-b', 'main', '.');
  git(bare, 'config', 'http.receivepack', pushable ? 'true' : 'false');
  const work = mkdtempSync(join(tmpdir(), 'fake-git-seed-'));
  try {
    git(work, 'init', '-b', 'main', '.');
    writeFileSync(join(work, 'README.md'), `# ${repo}\n\nA repository on the fake git host.\n`);
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'First commit');
    git(work, 'push', bare, 'main');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return bare;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** The token a request presents: Basic (the password; any user name) or Bearer. */
function presented(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return '';
}

export async function startFakeGitHost(options: FakeGitHostOptions): Promise<FakeGitHost> {
  const owner = options.owner ?? 'demo-owner';
  const repos = options.repos ?? ['starter'];
  const readOnly = new Set(options.readOnlyRepos ?? []);
  const root = mkdtempSync(join(tmpdir(), 'fake-git-host-'));
  for (const repo of repos) makeBare(root, owner, repo, !readOnly.has(repo));
  const github = await startFakeGithub({ token: options.token, owner, login: owner, readOnlyRepos: [...readOnly] });
  const gitCalls: GitHostCall[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const authorized = presented(req) === options.token;
      gitCalls.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, authorized });
      if (!authorized) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fake git host"', 'content-type': 'text/plain' });
        return void res.end('Authentication required');
      }
      const known = repos.some((r) => url.pathname.startsWith(`/${owner}/${r}.git/`));
      if (!known) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return void res.end('Repository not found');
      }
      const input = await body(req);
      const cgi = spawn('/usr/lib/git-core/git-http-backend', [], {
        env: {
          PATH: process.env['PATH'] ?? '',
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method ?? 'GET',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: req.headers['content-type'] ?? '',
          CONTENT_LENGTH: String(input.length),
          REMOTE_USER: owner,
          REMOTE_ADDR: '127.0.0.1',
          ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
          ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
          GIT_COMMITTER_NAME: 'fake',
          GIT_COMMITTER_EMAIL: 'fake@example.invalid',
        },
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      cgi.stdin.end(input);
      const out: Buffer[] = [];
      for await (const c of cgi.stdout) out.push(c as Buffer);
      const raw = Buffer.concat(out);
      const split = raw.indexOf('\r\n\r\n');
      const head = raw.subarray(0, split < 0 ? 0 : split).toString('utf8');
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head.split('\r\n')) {
        const at = line.indexOf(':');
        if (at < 0) continue;
        const k = line.slice(0, at).toLowerCase();
        const v = line.slice(at + 1).trim();
        if (k === 'status') status = Number.parseInt(v, 10) || 200;
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.end(raw.subarray(split < 0 ? 0 : split + 4));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(options.apiPort ?? 0, '127.0.0.1', resolve));
  const gitUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    apiUrl: github.url,
    url: github.url,
    gitUrl,
    remoteUrl: (repo) => `${gitUrl}/${owner}/${repo}.git`,
    calls: github.calls,
    gitCalls,
    github,
    branchHead: (repo, branch) => {
      const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: join(root, owner, `${repo}.git`), encoding: 'utf8' });
      return r.status === 0 ? r.stdout.trim() : null;
    },
    stop: async () => {
      await github.stop();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      rmSync(root, { recursive: true, force: true });
    },
  };
}
