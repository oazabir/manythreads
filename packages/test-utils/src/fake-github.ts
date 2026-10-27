import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A local double of the part of GitHub's REST API that publishing uses: list, open and read pull requests. It is to GitHub what tools/fake-llm is to
// LiteLLM: tests and the workbench script tests talk to it over real HTTP. It accepts only the one token it was started with (a wrong or missing
// one is 401), never records a token, and keeps every call so a test can check what was asked.

export interface FakePull {
  number: number;
  title: string;
  body: string;
  head: string;
  /** The commit the head branch is at; null = unknown (what a pull request made by the script has, until a test says). */
  headSha: string | null;
  base: string;
  /** `owner/repo` the head branch lives in; differs from the base's for a pull request from a fork. */
  headRepo: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
}

export interface FakeGithubCall {
  method: string;
  path: string;
  /** The request body as sent (a pull request's title and text): never a credential. */
  body: string;
  authorized: boolean;
}

export interface FakeGithub {
  /** `http://127.0.0.1:<port>`: use as the API base. */
  url: string;
  pulls: Map<number, FakePull>;
  calls: FakeGithubCall[];
  /** The next `count` requests answer `status` with these headers (a rate limit, an outage), before any other handling. */
  failNext(status: number, headers?: Record<string, string>, count?: number): void;
  merge(number: number, sha: string): void;
  close(number: number): void;
  stop(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeGithub(options: { token: string; owner?: string; repo?: string }): Promise<FakeGithub> {
  const pulls = new Map<number, FakePull>();
  const calls: FakeGithubCall[] = [];
  let failing: { status: number; headers: Record<string, string>; left: number } | null = null;
  let next = 1;
  let base = '';
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const url = new URL(req.url ?? '/', 'http://x');
      const authorized = req.headers.authorization === `Bearer ${options.token}`;
      calls.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body, authorized });
      const send = (status: number, doc: unknown, headers: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(doc));
      };
      if (failing && failing.left > 0) {
        failing.left--;
        return send(failing.status, { message: 'forced failure' }, failing.headers);
      }
      if (!authorized) return send(401, { message: 'Bad credentials' });
      const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?$/.exec(url.pathname);
      if (!m || (options.owner && m[1] !== options.owner) || (options.repo && m[2] !== options.repo)) return send(404, { message: 'Not Found' });
      const [, owner, repo, num] = m;
      const view = (p: FakePull): unknown => ({
        number: p.number,
        html_url: `${base}/${owner}/${repo}/pull/${p.number}`,
        state: p.state,
        merged: p.merged,
        merged_at: p.merged ? '2026-10-27T10:00:00Z' : null,
        merge_commit_sha: p.mergeSha,
        title: p.title,
        head: { ref: p.head, sha: p.headSha, repo: { full_name: p.headRepo ?? `${owner}/${repo}` } },
        base: { ref: p.base, repo: { full_name: `${owner}/${repo}` } },
      });
      if (req.method === 'GET' && num) {
        const p = pulls.get(Number(num));
        return p ? send(200, view(p)) : send(404, { message: 'Not Found' });
      }
      if (req.method === 'GET') {
        const head = url.searchParams.get('head') ?? '';
        const branch = head.includes(':') ? head.split(':')[1] : head;
        const wantOpen = (url.searchParams.get('state') ?? 'open') === 'open';
        const base = url.searchParams.get('base');
        return send(200, [...pulls.values()].filter((p) => p.head === branch && (!base || p.base === base) && (!wantOpen || p.state === 'open')).map(view));
      }
      if (req.method === 'POST' && !num) {
        let doc: { title?: string; head?: string; base?: string; body?: string; head_sha?: string; head_repo?: string };
        try {
          doc = JSON.parse(body) as typeof doc;
        } catch {
          return send(400, { message: 'Problems parsing JSON' });
        }
        if (!doc.title || !doc.head || !doc.base) return send(422, { message: 'Validation Failed' });
        // `head_sha` and `head_repo` are hooks of this double (GitHub ignores unknown fields): a test says where the branch is
        const p: FakePull = { number: next++, title: doc.title, body: doc.body ?? '', head: doc.head, headSha: doc.head_sha ?? null, headRepo: doc.head_repo ?? null, base: doc.base, state: 'open', merged: false, mergeSha: null };
        pulls.set(p.number, p);
        return send(201, view(p));
      }
      return send(405, { message: 'Method Not Allowed' });
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    pulls,
    calls,
    failNext: (status, headers = {}, count = 1) => {
      failing = { status, headers, left: count };
    },
    merge: (number, sha) => {
      const p = pulls.get(number);
      if (p) Object.assign(p, { state: 'closed', merged: true, mergeSha: sha });
    },
    close: (number) => {
      const p = pulls.get(number);
      if (p) p.state = 'closed';
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
