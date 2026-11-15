import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript file that ships in the image and in the server bundle
import { client, serve } from '../../../../deploy/images/agent-pod/publisher.mjs';
import { startFakeGithub, type FakeGithub } from '../../../test-utils/src/fake-github.ts';

// P26-15: the publisher of an enrolled server (docs/plans/agents-anywhere.md section 5.6). It is the pod's publisher with one difference: the push document is asked of the site over HTTPS
// with the run's own token (GET /api/runs/self/push-credential) instead of being copied out of a Secret folder. The test runs the real publisher, client, mt-publish.sh and git against a
// local double of GitHub and of the site.

const SCRIPT = fileURLToPath(new URL('../../../../deploy/images/workbench/mt-publish.sh', import.meta.url));
const TOKEN = 'ghp_ServerToken0123456789abcdefghijklm'; // secret-scan:ignore a made-up fixture
const CARD = '1a2b3c4d-1111-4222-8333-444455556666';
const BRANCH = 'card-1a2b3c4d';
const ORIGIN = 'https://github.com/acme/widgets.git';
const RUN = 'run-token-server-0123456789';
const RUN_NOPUB = 'run-token-server-nopub-01234';
const ME = userInfo().username;

const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let gh: FakeGithub;
let site: Server;
let siteUrl = '';
let siteCalls: Array<{ url: string; authorization: string | undefined }> = [];
let credentialStatus = 200;
let publisher: ReturnType<typeof serve>;
let socket = '';
let head = '';

beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN, owner: 'acme', repo: 'widgets' });
  site = createServer((req, res) => {
    siteCalls.push({ url: req.url ?? '', authorization: req.headers.authorization });
    const run = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const json = (status: number, body: unknown): void => void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (run !== RUN && run !== RUN_NOPUB) return json(401, { error: { code: 'unauthenticated' } });
    if (req.url === '/api/runs/self') return json(200, { teamSlug: 'team-a', botSlug: 'builder', runId: '11111111-1111-4111-8111-111111111111', mayPublish: run === RUN });
    if (req.url === '/api/runs/self/push-credential?project=widgets') {
      if (credentialStatus !== 200) return json(credentialStatus, { error: { code: 'x' } });
      return json(200, { project: 'widgets', origin: ORIGIN, branch: 'main', token: TOKEN, provider: 'github', login: 'bot', userId: '7', commitAs: 'bot' });
    }
    return json(404, {});
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await gh.stop();
  await new Promise((r) => site.close(r));
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pubsrv-'));
  siteCalls = [];
  credentialStatus = 200;
  gh.pulls.clear();
  gh.calls.length = 0;
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const dir = join(root, 'work/team-a/builder/widgets');
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  git(dir, 'remote', 'add', 'origin', ORIGIN);
  git(dir, 'push', '-q', join(root, 'origin.git'), 'main');
  git(dir, 'switch', '-q', '-c', BRANCH);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-q', '-am', 'the change');
  head = git(dir, 'rev-parse', 'HEAD');
  socket = join(root, 'run', 'sock');
  publisher = serve(
    {
      socket,
      socketMode: 0o660,
      serverUrl: siteUrl,
      work: join(root, 'work'),
      pushRoot: join(root, 'no-push-root'),
      credentialFromSite: true,
      script: SCRIPT,
      repoUser: ME,
      passEnv: { MT_GITHUB_API: gh.url, MT_PUSH_URL: join(root, 'origin.git'), MT_PR_TRIES: '2', MT_PR_WAIT: '0' },
    },
    () => undefined,
  );
  await new Promise<void>((r) => (publisher.listening ? r() : publisher.once('listening', () => r())));
  // a Unix socket is bound at once but the 'listening' callback (which sets the mode) runs on the next turn
  await new Promise((r) => setImmediate(r));
});
afterEach(async () => {
  await new Promise((r) => publisher.close(r));
  rmSync(root, { recursive: true, force: true });
});

async function mtPublish(token: string | null, args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const sink = (f: (s: string) => void) => ({ write: (s: string) => void f(s) });
  const code = await client(args, { ...(token === null ? {} : { MANYTHREADS_RUN_TOKEN: token }), MT_PUBLISH_SOCKET: socket }, Readable.from(['Tested.\n']), sink((s) => (out += s)), sink((s) => (err += s)));
  return { code, out, err };
}
const originRefs = (): string => spawnSync('git', ['-C', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '' && l !== 'refs/heads/main').join('\n');

describe('the publisher of an enrolled server', () => {
  it('asks the site for the push document with the run token, publishes with it, and shows the token nowhere', async () => {
    expect(await mtPublish(RUN, ['check', 'widgets'])).toMatchObject({ code: 0, out: 'ready\n' });
    const r = await mtPublish(RUN, ['publish', 'widgets', CARD, head, 'P26-15: fix']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('provider=github');
    expect(originRefs()).toBe(`refs/heads/${BRANCH}`);
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
    // every call to the site carried the run's own token and nothing else; the credential was asked once per publish call
    expect(siteCalls.every((c) => c.authorization === `Bearer ${RUN}`)).toBe(true);
    expect(siteCalls.filter((c) => c.url.includes('push-credential'))).toHaveLength(2);
    expect(r.out + r.err).not.toContain(TOKEN);
  });

  it('listens on a socket only its group may open (0660)', () => {
    expect((statSync(socket).mode & 0o777).toString(8)).toBe('660');
  });

  it('refuses a bot that may not publish before asking for any credential', async () => {
    const r = await mtPublish(RUN_NOPUB, ['publish', 'widgets', CARD, head, 'no']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('tasks.pull_request');
    expect(siteCalls.some((c) => c.url.includes('push-credential'))).toBe(false);
    expect(originRefs()).toBe('');
  });

  it('answers 3 when the site keeps no credential for the project, and 6 when the site does not answer', async () => {
    credentialStatus = 404;
    expect((await mtPublish(RUN, ['check', 'widgets'])).code).toBe(3);
    credentialStatus = 500;
    const r = await mtPublish(RUN, ['check', 'widgets']);
    expect(r.code).toBe(6);
    expect(originRefs()).toBe('');
  });

  it('refuses when the site turns the run down at the credential (403 and 401), with the site\'s words and not its answer', async () => {
    credentialStatus = 403;
    expect((await mtPublish(RUN, ['check', 'widgets'])).code).toBe(2);
    credentialStatus = 401;
    expect((await mtPublish(RUN, ['check', 'widgets'])).code).toBe(2);
  });
});
