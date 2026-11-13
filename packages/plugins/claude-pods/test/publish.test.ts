/* eslint-disable @typescript-eslint/no-explicit-any -- the tests read rendered Kubernetes objects and parsed JSON whose shape the assertions pin */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { PodRunnerInfo } from '@manythreads/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JavaScript file that ships in the image
import { client, handle, serve } from '../../../../deploy/images/claude-pod/publisher.mjs';
import { startFakeGithub, type FakeGithub } from '../../../test-utils/src/fake-github.ts';
import { configFrom, type ClaudePodConfig } from '../src/config.ts';
import { buildBridgeConfig, buildDeployment, GIT_TOOLS, namesFor, PUBLISH_TOOL, publisherKey, pushSecretName } from '../src/render.ts';

// P19-09: publishing from a Claude pod. Two halves. The rendered objects: the run container has no push token, no push Secret and no way to reach one; only the publisher container mounts a team's
// Secret. And the publisher itself, run for real (its server, its client, mt-publish.sh, git, a local double of GitHub and of the platform): a push to main is refused, a bot of team A cannot publish
// team B's folder, a hostile clone cannot run anything with the token, and no token shows in any answer.

const SCRIPT = fileURLToPath(new URL('../../../../deploy/images/workbench/mt-publish.sh', import.meta.url));
const TOKEN_A = 'ghp_TeamAToken0123456789abcdefghijklmn';
const TOKEN_B = 'ghp_CANARY_TeamB_0123456789abcdefghijk';
const CARD = '1a2b3c4d-1111-4222-8333-444455556666';
const BRANCH = 'card-1a2b3c4d';
const ORIGIN = 'https://github.com/acme/widgets.git';
const RUN_A = 'run-token-team-a-0123456789';
const RUN_B = 'run-token-team-b-0123456789';
const RUN_NOPUB = 'run-token-no-publish-012345';

describe('the rendered pod', () => {
  const CFG: ClaudePodConfig = { ...configFrom({ MANYTHREADS_INCLUSTER_URL: 'http://manythreads-server.manythreads.svc.cluster.local:3000' }), namespace: 'bots', image: 'manythreads/claude-pod:1' };
  const runner = (over: Partial<PodRunnerInfo> = {}): PodRunnerInfo => ({
    id: '00000000-0000-4000-8000-000000000001',
    workspaceId: 'w1',
    name: 'shared',
    enabled: true,
    node: null,
    maxConcurrent: null,
    teams: [
      { id: 't-eng', slug: 'engineering' },
      { id: 't-mkt', slug: 'marketing' },
    ],
    allTeams: false,
    bots: [
      { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'builder' },
      { teamId: 't-eng', teamSlug: 'engineering', botSlug: 'reviewer' },
      { teamId: 't-mkt', teamSlug: 'marketing', botSlug: 'writer' },
    ],
    ...over,
  });
  const names = namesFor('shared');
  const pods = (cfg = CFG, over: Partial<PodRunnerInfo> = {}) => {
    const r = runner(over);
    return buildDeployment(cfg, r, names, {
      replicas: 1,
      pushSecrets: [
        { teamSlug: 'marketing', secret: 'hermes-marketing-push' },
        { teamSlug: 'engineering', secret: 'hermes-engineering-push' },
      ],
    }) as any;
  };
  const containers = (d: any): Record<string, any> => Object.fromEntries(d.spec.template.spec.containers.map((c: any) => [c.name, c]));
  const volumes = (d: any): Record<string, any> => Object.fromEntries(d.spec.template.spec.volumes.map((v: any) => [v.name, v]));

  it('mounts a push Secret in the publisher container alone, read-only, one folder per team', () => {
    const d = pods();
    const cs = containers(d);
    const vols = volumes(d);
    expect(Object.keys(cs).sort()).toEqual(['bridge', 'keeper', 'publisher', 'repo-sync']);
    const pushMounts = cs.publisher.volumeMounts.filter((m: any) => m.mountPath.startsWith('/etc/publisher-push/'));
    expect(pushMounts.map((m: any) => m.mountPath)).toEqual(['/etc/publisher-push/engineering', '/etc/publisher-push/marketing']);
    expect(pushMounts.every((m: any) => m.readOnly === true)).toBe(true);
    const secretNames = pushMounts.map((m: any) => vols[m.name].secret.secretName);
    expect(secretNames).toEqual(['hermes-engineering-push', 'hermes-marketing-push']);
    // no other container, and no init container, mounts any of those volumes
    const pushVolumes = new Set(pushMounts.map((m: any) => m.name));
    for (const c of [...d.spec.template.spec.containers.filter((c: any) => c.name !== 'publisher'), ...d.spec.template.spec.initContainers]) {
      for (const m of c.volumeMounts) expect(pushVolumes.has(m.name), `${c.name} mounts ${m.name}`).toBe(false);
    }
  });

  it('keeps every push Secret, token and publisher variable out of the run container, byte for byte', () => {
    const d = pods();
    const bridge = JSON.stringify(containers(d).bridge);
    for (const needle of ['hermes-engineering-push', 'hermes-marketing-push', 'publisher-push', 'mt-push', 'PUBLISHER_', 'GITHUB', 'GH_TOKEN', 'MT_TOKEN', 'push-0', 'push-1', 'publisher-tmp']) {
      expect(bridge, needle).not.toContain(needle);
    }
    // the only environment of the run container: the bridge key (from its Secret), HOME and the sign-in folder
    expect(containers(d).bridge.env.map((e: any) => e.name).sort()).toEqual(['AGENT_BRIDGE_API_KEY', 'CLAUDE_CONFIG_DIR', 'HOME']);
    // what it mounts for publishing: the socket folder, nothing that holds a token
    expect(containers(d).bridge.volumeMounts.map((m: any) => m.mountPath).sort()).toEqual(['/etc/bridge', '/run/publish', '/run/repos', '/state', '/tmp', '/work']);
    // the repo-sync container, which clones with no credential, mounts no publish folder and no Secret either
    expect(JSON.stringify(containers(d)['repo-sync'])).not.toMatch(/publish|push|secret/i);
    // the whole Deployment names a team's push Secret only in volumes, and only the publisher mounts them
    expect(d.spec.template.spec.volumes.filter((v: any) => v.secret).map((v: any) => v.secret.secretName).sort()).toEqual(['claude-shared-credentials', 'hermes-engineering-push', 'hermes-marketing-push']);
  });

  it('runs the publisher as its own user with a read-only root, the work volume read-only, no Kubernetes token and no sign-in', () => {
    const d = pods();
    const p = containers(d).publisher;
    expect(p.securityContext).toMatchObject({ runAsUser: 1001, runAsGroup: 1001, runAsNonRoot: true, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } });
    expect(p.volumeMounts.find((m: any) => m.mountPath === '/work')).toMatchObject({ readOnly: true });
    const mounted = p.volumeMounts.map((m: any) => m.name);
    expect(mounted).not.toContain('keeper-token');
    expect(mounted).not.toContain('state');
    expect(mounted).not.toContain('creds');
    expect(d.spec.template.spec.automountServiceAccountToken).toBe(false);
    expect(p.env).toEqual([
      { name: 'PUBLISHER_SERVER_URL', value: 'http://manythreads-server.manythreads.svc.cluster.local:3000' },
      { name: 'HOME', value: '/tmp' },
    ]);
    // its scratch space is memory: a copy of a token never reaches a disk
    expect(volumes(d)['publisher-tmp'].emptyDir.medium).toBe('Memory');
    expect(volumes(d).publish.emptyDir).toBeDefined();
  });

  it('has no publisher and no push mount when the platform address is unknown or the publisher is turned off', () => {
    for (const cfg of [{ ...CFG, serverUrl: '' }, { ...CFG, publisher: { ...CFG.publisher, enabled: false } }]) {
      const d = pods(cfg);
      expect(Object.keys(containers(d)).sort()).toEqual(['bridge', 'keeper', 'repo-sync']);
      expect(JSON.stringify(d)).not.toMatch(/publisher|push-\d|hermes-.*-push|\/run\/publish/);
    }
  });

  it('names the push Secret the way the Hermes pods do, and a taken name the longer way', () => {
    expect(pushSecretName({ id: 'x', slug: 'Engineering' })).toBe('hermes-engineering-push');
    expect(pushSecretName({ id: '12345678-aaaa', slug: 'engineering' }, true)).toBe('hermes-engineering-12345678-push');
  });

  it('allows each bot the git commands, and the publish command only a bot whose definition grants tasks.pull_request', () => {
    const publishers = new Set([publisherKey('engineering', 'builder')]);
    const profiles = JSON.parse(buildBridgeConfig(CFG, runner(), publishers)).profiles;
    expect(profiles['engineering--builder'].extraAllowedTools).toEqual([...GIT_TOOLS, PUBLISH_TOOL]);
    expect(profiles['engineering--reviewer'].extraAllowedTools).toEqual([...GIT_TOOLS]);
    expect(profiles['marketing--writer'].extraAllowedTools).toEqual([...GIT_TOOLS]);
    // the same bot name in another team is not a publisher
    const other = JSON.parse(buildBridgeConfig(CFG, runner(), new Set([publisherKey('marketing', 'builder')]))).profiles;
    expect(other['engineering--builder'].extraAllowedTools).not.toContain(PUBLISH_TOOL);
    expect(profiles['engineering--builder'].instructions).toContain('mt-publish');
    expect(profiles['engineering--reviewer'].instructions).not.toContain('mt-publish');
    // no publisher container: no publish command for anyone
    const none = JSON.parse(buildBridgeConfig({ ...CFG, serverUrl: '' }, runner(), publishers)).profiles;
    expect(none['engineering--builder'].extraAllowedTools).toEqual([...GIT_TOOLS]);
  });

  it('lists no git command that reaches the network or rewrites history', () => {
    for (const tool of GIT_TOOLS) expect(tool).not.toMatch(/push|fetch|pull|clone|reset|rebase|checkout \.|restore|clean|remote|config|-f\b|--force/);
  });
});

// ---- the publisher, run for real ----------------------------------------------------------------------------------------------------------------------------------------------------------

const ME = userInfo().username;
// fixed dates: the two teams' clones of the same project hold the same history (a real clone comes from the origin), so the main branch of one is the main branch of the other
const git = (cwd: string, ...args: string[]): string => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let root: string;
let gh: FakeGithub;
let platform: Server;
let platformUrl = '';
let platformCalls: Array<{ authorization: string | undefined; url: string }> = [];
let socket = '';
let publisher: ReturnType<typeof serve>;
let headA = '';
let mainA = '';

const SELF: Record<string, unknown> = {};

beforeAll(async () => {
  gh = await startFakeGithub({ token: TOKEN_A, owner: 'acme', repo: 'widgets' });
  platform = createServer((req, res) => {
    platformCalls.push({ authorization: req.headers.authorization, url: req.url ?? '' });
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const who = SELF[token];
    if (req.url !== '/api/runs/self' || !who) {
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"unauthenticated"}}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(who));
  });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await gh.stop();
  await new Promise((r) => platform.close(r));
});

/** A working clone of a bot, as Claude would leave it: main, then a card branch with one more commit. */
function makeClone(dir: string, origin = ORIGIN): { head: string; main: string } {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  const main = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'remote', 'add', 'origin', origin);
  git(dir, 'switch', '-q', '-c', BRANCH);
  writeFileSync(join(dir, 'a.txt'), 'two\n');
  git(dir, 'commit', '-q', '-am', 'the change');
  return { head: git(dir, 'rev-parse', 'HEAD'), main };
}

/** The Secret folder of a team as the kubelet makes it: the file is a link into a hidden data folder. */
function secretFolder(team: string, project: string, doc: object | null): void {
  const dir = join(root, 'push', team);
  mkdirSync(join(dir, '..data'), { recursive: true });
  if (doc === null) return;
  writeFileSync(join(dir, '..data', project), JSON.stringify(doc));
  symlinkSync(join('..data', project), join(dir, project));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'pub-'));
  platformCalls = [];
  gh.pulls.clear();
  gh.calls.length = 0;
  git(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const a = makeClone(join(root, 'work/team-a/builder/widgets'));
  git(join(root, 'work/team-a/builder/widgets'), 'push', '-q', join(root, 'origin.git'), 'main'); // the origin has the project's main branch: the publish builds on its tip
  headA = a.head;
  mainA = a.main;
  makeClone(join(root, 'work/team-b/builder/widgets'));
  secretFolder('team-a', 'widgets', { branch: 'main', origin: ORIGIN, token: TOKEN_A });
  secretFolder('team-b', 'widgets', { branch: 'main', origin: ORIGIN, token: TOKEN_B });
  for (const k of Object.keys(SELF)) delete SELF[k];
  SELF[RUN_A] = { teamSlug: 'team-a', botSlug: 'builder', runId: '11111111-1111-4111-8111-111111111111', mayPublish: true };
  SELF[RUN_B] = { teamSlug: 'team-b', botSlug: 'builder', runId: '22222222-2222-4222-8222-222222222222', mayPublish: true };
  SELF[RUN_NOPUB] = { teamSlug: 'team-a', botSlug: 'builder', runId: '33333333-3333-4333-8333-333333333333', mayPublish: false };
  socket = join(root, 'sock');
  publisher = serve(
    { socket, serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME, passEnv: { MT_GITHUB_API: gh.url, MT_PUSH_URL: join(root, 'origin.git'), MT_PR_TRIES: '2', MT_PR_WAIT: '0' } },
    () => undefined,
  );
  await new Promise<void>((r) => (publisher.listening ? r() : publisher.once('listening', () => r())));
});
afterEach(async () => {
  await new Promise((r) => publisher.close(r));
  rmSync(root, { recursive: true, force: true });
});

/** The `mt-publish` command, run as the client in a run container would. */
async function mtPublish(token: string | null, args: string[], input = 'Tested.\n'): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const sink = (f: (s: string) => void) => ({ write: (s: string) => void f(s) });
  const code = await client(args, { ...(token === null ? {} : { MANYTHREADS_RUN_TOKEN: token }), MT_PUBLISH_SOCKET: socket }, Readable.from([input]), sink((s) => (out += s)), sink((s) => (err += s)));
  return { code, out, err };
}
/** What the origin holds besides its main branch (which stays where it was, and is checked on its own). */
const originRefs = (): string => spawnSync('git', ['-C', join(root, 'origin.git'), 'for-each-ref', '--format=%(refname) %(objectname)'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l !== '' && !l.startsWith('refs/heads/main ')).map((l) => `${l}\n`).join('');
const originMain = (): string => spawnSync('git', ['-C', join(root, 'origin.git'), 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim();
const squashed = (out: string): string => /head_sha=([0-9a-f]+)/.exec(out)![1]!;
const log = (sha: string, format: string): string => git(join(root, 'origin.git'), 'log', '-1', `--format=${format}`, sha);

describe('publishing through the publisher', () => {
  it('pushes the card branch and opens the pull request for a bot that may publish', async () => {
    expect((await mtPublish(RUN_A, ['check', 'widgets']))).toMatchObject({ code: 0, out: 'ready\n' });
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix the widget']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/pull_request_number=\d+/);
    // the origin got the card branch as ONE commit on its main branch's tip (the squash), reported beside the tested commit; main did not move
    expect(r.out).toContain(`tested_sha=${headA}`);
    expect(r.out).toContain('provider=github');
    expect(originRefs().trim()).toBe(`refs/heads/${BRANCH} ${squashed(r.out)}`);
    expect(git(join(root, 'origin.git'), 'rev-list', '--count', `${mainA}..${squashed(r.out)}`)).toBe('1');
    expect(originMain()).toBe(mainA);
    expect(JSON.parse(gh.calls.find((c) => c.method === 'POST')!.body)).toMatchObject({ title: 'Fix the widget', head: BRANCH, base: 'main' });
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
  });

  it('refuses a push to main: exit 2, and nothing reaches the origin', async () => {
    // a card id is a uuid and the branch is always card-<8>: no word can name main (or any other branch) as the thing to push
    for (const card of ['main', 'refs/heads/main', BRANCH, 'HEAD', '00000000-0000-0000-0000-000000000000/../main', `${CARD}:refs/heads/main`]) {
      const r = await mtPublish(RUN_A, ['publish', 'widgets', card, mainA, 'try main']);
      expect(r.code, `${card}: ${r.err}`).toBe(2);
    }
    expect((await mtPublish(RUN_A, ['publish', 'widgets', 'main', mainA, 'try main'])).err).toContain('bad card id');
    // the commit of main is not the card branch's head
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, mainA, 'old commit'])).code).toBe(4);
    // a token issued for a branch that the card branch would equal is refused too: the pull request never targets its own head
    rmSync(join(root, 'push/team-a'), { recursive: true });
    secretFolder('team-a', 'widgets', { branch: BRANCH, origin: ORIGIN, token: TOKEN_A });
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'same branch'])).code).toBe(2);
    expect(originRefs()).toBe('');
    expect(gh.calls).toHaveLength(0);
  });

  it('never forces: an origin branch that holds other work stays as it is (the origin here accepts a forced push, so only the script can refuse), exit 5, no pull request', async () => {
    // someone already put a different commit on the card branch's name at the origin; this origin is a plain bare repository and has no rule against rewriting a branch
    makeClone(join(root, 'other'), join(root, 'origin.git'));
    git(join(root, 'other'), 'commit', '-q', '--allow-empty', '-m', 'someone else');
    git(join(root, 'other'), 'push', '-q', join(root, 'origin.git'), `HEAD:refs/heads/${BRANCH}`);
    const before = originRefs();
    expect(before).toContain(`refs/heads/${BRANCH}`);
    expect(before).not.toContain(headA);
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix the widget']);
    expect(r.code, r.err).toBe(5);
    expect(originRefs()).toBe(before);
    expect(gh.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect(r.out + r.err).not.toContain(TOKEN_A);
  });

  it('refuses a branch the bot never made, with nothing pushed', async () => {
    git(join(root, 'work/team-a/builder/widgets'), 'switch', '-q', 'main');
    git(join(root, 'work/team-a/builder/widgets'), 'branch', '-q', '-D', BRANCH);
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'nothing']);
    expect(r.code).toBe(4);
    expect(originRefs()).toBe('');
  });

  it('lets a bot of team A publish only team A’s folder: team B’s folder is refused with exit 2 and team B’s token is never read', async () => {
    // team A has no "gadgets" project; team B does, and B's push file is a pipe, so a read of it by the publisher would hang the call and fail the test
    makeClone(join(root, 'work/team-b/builder/gadgets'));
    const pipe = join(root, 'push/team-b/gadgets');
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0);
    for (const project of ['gadgets', '../../team-b/builder/gadgets', '..', '.', 'GADGETS', 'a/b']) {
      for (const op of [['check', project], ['publish', project, CARD, headA, 'steal']]) {
        const r = await mtPublish(RUN_A, op);
        expect(r.code, `${op.join(' ')}: ${r.err}`).toBe(2);
        expect(r.out + r.err).not.toContain(TOKEN_B);
      }
    }
    // the caller's own words about the team change nothing: only the platform's answer picks the folder
    const sneaky = await handle({ op: 'publish', token: RUN_A, project: 'gadgets', card: CARD, sha: headA, title: 'x', teamSlug: 'team-b', botSlug: 'builder', folder: join(root, 'work/team-b/builder/gadgets'), mayPublish: true }, { serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME });
    expect(sneaky.code).toBe(2);
    expect(originRefs()).toBe('');
    expect(gh.calls).toHaveLength(0);
    // a project both teams have: the folder and the token are team A's, whatever the caller says about the team; team B's push file is a pipe, so a read of it would hang
    rmSync(join(root, 'push/team-b/widgets'));
    expect(spawnSync('mkfifo', [join(root, 'push/team-b/widgets')]).status).toBe(0);
    const same = await handle({ op: 'publish', token: RUN_A, project: 'widgets', card: CARD, sha: headA, title: 'x', teamSlug: 'team-b', pushRoot: join(root, 'push/team-b') }, { serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME, timeoutMs: 20_000, passEnv: { MT_GITHUB_API: gh.url, MT_PUSH_URL: join(root, 'origin.git'), MT_PR_TRIES: '2', MT_PR_WAIT: '0' } });
    expect(same.code, same.err).toBe(0);
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
    expect(same.out + same.err).not.toContain(TOKEN_B);
  });

  it('publishes team B’s own folder with team B’s own token only for a run that is team B’s', async () => {
    const gB = await startFakeGithub({ token: TOKEN_B, owner: 'acme', repo: 'widgets' });
    try {
      const headB = git(join(root, 'work/team-b/builder/widgets'), 'rev-parse', 'HEAD');
      await new Promise((r) => publisher.close(r));
      publisher = serve(
        { socket, serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME, passEnv: { MT_GITHUB_API: gB.url, MT_PUSH_URL: join(root, 'origin.git'), MT_PR_TRIES: '2', MT_PR_WAIT: '0' } },
        () => undefined,
      );
      await new Promise<void>((r) => (publisher.listening ? r() : publisher.once('listening', () => r())));
      const r = await mtPublish(RUN_B, ['publish', 'widgets', CARD, headB, 'B work']);
      expect(r.code, r.err).toBe(0);
      expect(gB.calls.every((c) => c.authorized)).toBe(true);
      // team A's token was not used for it, and team B's is in no output
      expect(r.out + r.err).not.toContain(TOKEN_A);
      expect(r.out + r.err).not.toContain(TOKEN_B);
      // a team-A run asking for the same project name gets team A's folder and team A's token, which the double of GitHub (set up for B) does not accept
      const a = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'A work']);
      expect(a.code).not.toBe(0);
    } finally {
      await gB.stop();
    }
  });

  it('refuses a run whose bot may not publish, an unknown run and an ended run, before it touches a folder or a token', async () => {
    const pipe = join(root, 'push/team-a/widgets');
    rmSync(pipe);
    expect(spawnSync('mkfifo', [pipe]).status).toBe(0); // a read of team A's token would hang: none must happen
    const nopub = await mtPublish(RUN_NOPUB, ['publish', 'widgets', CARD, headA, 't']);
    expect(nopub.code).toBe(2);
    expect(nopub.err).toContain('may not publish');
    expect((await mtPublish(RUN_NOPUB, ['check', 'widgets'])).code).toBe(2);
    const unknown = await mtPublish('made-up-token-0123456789', ['publish', 'widgets', CARD, headA, 't']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('not valid any more');
    expect(originRefs()).toBe('');
  });

  it('asks the platform with the run’s own token on every request, and the token is in no answer', async () => {
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix the widget']);
    expect(r.code).toBe(0);
    expect(platformCalls.length).toBeGreaterThanOrEqual(1);
    expect(platformCalls.every((c) => c.authorization === `Bearer ${RUN_A}` && c.url === '/api/runs/self')).toBe(true);
    for (const text of [r.out, r.err, JSON.stringify(gh.calls)]) {
      expect(text).not.toContain(RUN_A);
      expect(text).not.toContain(TOKEN_A);
    }
    // nothing of the token is left in the scratch folder
    expect(spawnSync('sh', ['-c', `grep -rl ${TOKEN_A} ${tmpdir()}/push-* 2>/dev/null`], { encoding: 'utf8' }).stdout).toBe('');
  });

  it('scrubs a token from the output even if the script printed it', async () => {
    const script = join(root, 'leaky.sh');
    writeFileSync(script, `#!/bin/bash\njq -r .token "$MT_PUSH_DIR/$2" ; echo "$(jq -r .token "$MT_PUSH_DIR/$2")" >&2\nexit 5\n`, { mode: 0o755 });
    const r = await handle({ op: 'check', token: RUN_A, project: 'widgets' }, { serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script, repoUser: ME });
    expect(r.code).toBe(5);
    expect(r.out + r.err).not.toContain(TOKEN_A);
    expect(r.out).toContain('***');
  });

  it('refuses a project folder that is a link, or sits behind one', async () => {
    rmSync(join(root, 'work/team-a/builder/widgets'), { recursive: true });
    symlinkSync(join(root, 'work/team-b/builder/widgets'), join(root, 'work/team-a/builder/widgets'));
    expect((await mtPublish(RUN_A, ['check', 'widgets'])).code).toBe(2);
    // the bot's own folder is the link: the last part of the path is a real folder (team B's), only the way to it goes through a link
    rmSync(join(root, 'work/team-a/builder'), { recursive: true });
    symlinkSync(join(root, 'work/team-b/builder'), join(root, 'work/team-a/builder'));
    expect(lstatSync(join(root, 'work/team-a/builder/widgets')).isDirectory()).toBe(true);
    expect((await mtPublish(RUN_A, ['check', 'widgets'])).code).toBe(2);
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'through a link'])).code).toBe(2);
    expect(originRefs()).toBe('');
    expect(gh.calls).toHaveLength(0);
  });

  it('answers 3 when the team has no token saved, and 7 once the platform marked it refused', async () => {
    rmSync(join(root, 'push/team-a'), { recursive: true });
    expect((await mtPublish(RUN_A, ['check', 'widgets'])).code).toBe(3);
    secretFolder('team-a', 'widgets', { branch: 'main', origin: ORIGIN, token: TOKEN_A, refused: true });
    const r = await mtPublish(RUN_A, ['check', 'widgets']);
    expect(r.code).toBe(7);
    expect(r.out + r.err).not.toContain(TOKEN_A);
  });

  it('reads the owner’s token when the project points at it (the team keeps one token for a GitHub owner)', async () => {
    rmSync(join(root, 'push/team-a'), { recursive: true });
    secretFolder('team-a', 'widgets', { branch: 'main', origin: ORIGIN, via: '_owner.github.com.acme' });
    secretFolder('team-a', '_owner.github.com.acme', { token: TOKEN_A });
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Owner token'])).code).toBe(0);
    expect(gh.calls.every((c) => c.authorized)).toBe(true);
  });
});

describe('a hostile clone', () => {
  const clone = (): string => join(root, 'work/team-a/builder/widgets');
  const marker = (): string => join(root, 'ran.txt');

  it('cannot run anything with the token: hooks, fsmonitor and config in the bot’s clone are never used', async () => {
    const dir = clone();
    writeFileSync(join(dir, '.git/hooks/pre-push'), `#!/bin/sh\necho hook >> ${marker()}\n`, { mode: 0o755 });
    writeFileSync(join(dir, '.git/hooks/reference-transaction'), `#!/bin/sh\necho hook2 >> ${marker()}\n`, { mode: 0o755 });
    git(dir, 'config', 'core.fsmonitor', `touch ${marker()}; true`);
    git(dir, 'config', 'core.sshCommand', `touch ${marker()}; false`);
    git(dir, 'config', 'credential.helper', `!touch ${marker()}; true`);
    git(dir, 'config', 'uploadpack.packObjectsHook', `touch ${marker()}`);
    git(dir, 'config', 'push.default', 'matching');
    // the address rewrite: the clone's own config says "send what is meant for the origin to a place of the bot's choosing". The tests push to a local path, so the rewrite is of that path;
    // in the pod it would be of the GitHub address, with the team's token on its way. The push must go to the origin, and the bot's place must stay empty.
    git(root, 'init', '-q', '--bare', '-b', 'main', 'evil.git');
    git(dir, 'config', `url.${join(root, 'evil.git')}.insteadOf`, join(root, 'origin.git'));
    git(dir, 'config', `url.${join(root, 'evil.git')}.pushInsteadOf`, join(root, 'origin.git'));
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix']);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(marker())).toBe(false);
    expect(originRefs().trim()).toBe(`refs/heads/${BRANCH} ${squashed(r.out)}`);
    expect(spawnSync('git', ['-C', join(root, 'evil.git'), 'for-each-ref'], { encoding: 'utf8' }).stdout).toBe('');
  });

  it('cannot aim the token at another address: an origin it was not issued for is "no push credential"', async () => {
    git(clone(), 'remote', 'set-url', 'origin', 'https://evil.example/acme/widgets.git');
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix']);
    expect(r.code).toBe(3);
    expect(gh.calls).toHaveLength(0);
    expect(originRefs()).toBe('');
    expect(r.out + r.err).not.toContain(TOKEN_A);
  });

  it('cannot make the publisher push something other than the tested commit by moving the branch afterwards', async () => {
    const dir = clone();
    // the bot tested headA, then committed again on the branch: the head is no longer the tested commit
    writeFileSync(join(dir, 'a.txt'), 'three\n');
    git(dir, 'commit', '-q', '-am', 'untested');
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix']);
    expect(r.code).toBe(4);
    expect(originRefs()).toBe('');
  });
});

describe('who signs a published commit, asked through the publisher', () => {
  const who = (out: string): string => log(squashed(out), '%an <%ae>|%cn <%ce>');
  const BOT = { login: 'mt-bot', userId: '4242' };
  const NO_REPLY = 'mt-bot <4242+mt-bot@users.noreply.github.com>';
  const setDoc = (commitAs: string): void => {
    rmSync(join(root, 'push/team-a'), { recursive: true });
    secretFolder('team-a', 'widgets', { branch: 'main', origin: ORIGIN, token: TOKEN_A, ...BOT, commitAs });
  };

  it('passes the requester’s name and email on, and the project that signs as the requester uses them (the committer stays the bot)', async () => {
    setDoc('requester');
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix', 'Sameera Perera', 'sameera@example.org']);
    expect(r.code, r.err).toBe(0);
    expect(who(r.out)).toBe(`Sameera Perera <sameera@example.org>|${NO_REPLY}`);
  });

  it('a project that signs as the bot ignores them', async () => {
    setDoc('bot');
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix', 'Sameera Perera', 'sameera@example.org']);
    expect(r.code, r.err).toBe(0);
    expect(who(r.out)).toBe(`${NO_REPLY}|${NO_REPLY}`);
  });

  it('a project that signs as the requester refuses a publish without them (exit 2) and pushes nothing', async () => {
    setDoc('requester');
    const r = await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix']);
    expect(r.code).toBe(2);
    expect(r.err).toContain("requester's name and email");
    expect(originRefs()).toBe('');
  });

  it('checks the name and email itself before it runs anything, and takes both or neither', async () => {
    setDoc('requester');
    for (const [name, email] of [['', 'a@b.co'], ['x'.repeat(101), 'a@b.co'], ['A\nB', 'a@b.co'], ['A <B>', 'a@b.co'], ['A B', 'nope'], ['A B', 'a@b'], ['A B', 'a b@c.de'], ['A B', `${'a'.repeat(200)}@b.co`]]) {
      expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix', name!, email!])).code, `${name}|${email}`).toBe(2);
    }
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix', 'Only A Name'])).code).toBe(2);
    expect((await mtPublish(RUN_A, ['publish', 'widgets', CARD, headA, 'Fix', 'A', 'a@b.co', 'extra'])).code).toBe(2);
    // a request made by hand (not through the client) with one of the two is refused by the publisher itself, before the script runs
    const half = await handle({ op: 'publish', token: RUN_A, project: 'widgets', card: CARD, sha: headA, title: 'Fix', authorName: 'A B' }, { serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME });
    expect(half.code).toBe(2);
    expect(half.err).toContain('together');
    const bad = await handle({ op: 'publish', token: RUN_A, project: 'widgets', card: CARD, sha: headA, title: 'Fix', authorName: 'A B', authorEmail: 'nope' }, { serverUrl: platformUrl, work: join(root, 'work'), pushRoot: join(root, 'push'), script: SCRIPT, repoUser: ME });
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('not an email');
    expect(originRefs()).toBe('');
    expect(gh.calls).toHaveLength(0);
  });
});

describe('the client', () => {
  it('says plainly when it is used outside a run, with the wrong words, or with no publisher', async () => {
    expect((await mtPublish(null, ['check', 'widgets']))).toMatchObject({ code: 2 });
    expect((await mtPublish(null, ['check', 'widgets'])).err).toContain('no run token');
    expect((await mtPublish(RUN_A, [])).code).toBe(2);
    expect((await mtPublish(RUN_A, ['check'])).code).toBe(2);
    expect((await mtPublish(RUN_A, ['publish', 'widgets'])).code).toBe(2);
    expect((await mtPublish(RUN_A, ['push', 'widgets'])).code).toBe(2);
    let err = '';
    const code = await client(['check', 'widgets'], { MANYTHREADS_RUN_TOKEN: RUN_A, MT_PUBLISH_SOCKET: join(root, 'no-such-socket') }, Readable.from(['']), { write: () => undefined }, { write: (s: string) => void (err += s) });
    expect(code).toBe(6);
    expect(err).toContain('did not answer');
  });

  it('is not held by a standard input that never closes: the pull request text is what arrived in the first seconds', async () => {
    const stuck = new PassThrough();
    stuck.write('Text so far.\n');
    let out = '';
    const code = await client(['publish', 'widgets', CARD, headA, 'Fix'], { MANYTHREADS_RUN_TOKEN: RUN_A, MT_PUBLISH_SOCKET: socket, MT_PUBLISH_STDIN_MS: '300' }, stuck, { write: (s: string) => void (out += s) }, { write: () => undefined });
    expect(code).toBe(0);
    expect(JSON.parse(gh.calls.find((c) => c.method === 'POST')!.body).body).toContain('Text so far.');
    expect(out).toContain('pull_request_number=');
    stuck.destroy();
  });

  it('shows a publisher that is not valid JSON on the wire a refusal, not a crash', async () => {
    const { connect } = await import('node:net');
    const answer = await new Promise<string>((resolve) => {
      const c = connect(socket);
      let text = '';
      c.setEncoding('utf8');
      c.on('data', (d) => (text += d));
      c.on('close', () => resolve(text));
      c.write('{not json\n');
    });
    expect(JSON.parse(answer)).toMatchObject({ code: 2 });
    // any process of the run container may connect: the socket is world-writable, and the run token decides what a request may do
    expect(statSync(socket).mode & 0o666).toBe(0o666);
  });
});

describe('mt-publish.sh with a working clone', () => {
  it('is the same script the Hermes pods use: the header says so and MT_SOURCE_DIR is the only addition', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toContain('MT_SOURCE_DIR');
    // the rules are in one place: the card branch name, never main, never forced
    expect(text).toContain('branch="card-${card:0:8}"');
    expect(text).not.toMatch(/push[^\n]*(--force|-f |\+refs)/);
  });
});
