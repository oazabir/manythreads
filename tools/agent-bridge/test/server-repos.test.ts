import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startServerRepos, type ServerRepos } from '../src/server-repos.ts';

// The server's repository sync (P26-15): the list comes from the site with the bridge key, is written as the sync step reads it, and the step is kept running as a child.

const KEY = `mtb_${'7'.repeat(64)}`;
let site: Server;
let base = '';
const answer = { status: 200, body: { repos: [] as unknown[] }, calls: 0 };
const dirs: string[] = [];
let sync: ServerRepos | undefined;
const logs: string[] = [];

beforeAll(async () => {
  site = createServer((req, res) => {
    answer.calls += 1;
    if (req.url !== '/api/bridge/repos' || req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(() => site.close());
afterEach(async () => {
  await sync?.close();
  sync = undefined;
  logs.length = 0;
  Object.assign(answer, { status: 200, body: { repos: [] }, calls: 0 });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const REPO = { team: 'eng', bot: 'builder', project: 'site', branch: 'main', origin: 'https://github.com/acme/site' };

function setup(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'server-repos-'));
  dirs.push(root);
  const tools = join(root, 'tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'repo-sync.sh'), script);
  const stateDir = join(root, 'state');
  mkdirSync(stateDir, { recursive: true });
  return { root, tools, stateDir };
}
const until = async (cond: () => boolean, ms = 4000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
};
// a stand-in for repo-sync.sh: notes how it was started and keeps running until it is stopped
const KEEPER = 'echo "$REPO_SYNC_LIST|$REPO_SYNC_WORK|$REPO_SYNC_SCRATCH|$REPO_SYNC_INTERVAL" >> "$REPO_SYNC_SCRATCH/started"\necho "$$" > "$REPO_SYNC_SCRATCH/pid"\nexec sleep 300\n';

describe('the list', () => {
  it('is asked of the site with the key, written as lines for the sync step before it starts, and written again only when it changed', async () => {
    answer.body = { repos: [REPO] };
    const { root, tools, stateDir } = setup(KEEPER);
    sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, syncSeconds: 10, intervalMs: 60_000, log: (l) => logs.push(l) });
    const started = join(stateDir, 'sync', 'started');
    await until(() => existsSync(started));
    expect(readFileSync(join(stateDir, 'repos.txt'), 'utf8')).toBe('eng builder site main https://github.com/acme/site\n');
    expect(readFileSync(started, 'utf8').trim()).toBe(`${join(stateDir, 'repos.txt')}|${join(root, 'work')}|${join(stateDir, 'sync')}|10`);
    answer.body = { repos: [REPO, { ...REPO, project: 'docs', branch: null, origin: 'https://github.com/acme/docs' }] };
    expect(await sync.poll()).toBe(true);
    expect(readFileSync(join(stateDir, 'repos.txt'), 'utf8')).toBe('eng builder site main https://github.com/acme/site\neng builder docs - https://github.com/acme/docs\n');
    expect(logs.filter((l) => l.includes('on the list'))).toEqual(['repo sync: 1 repository on the list', 'repo sync: 2 repositories on the list']);
    expect(logs.join('\n')).not.toContain(KEY);
  });

  it('a site that refuses the key, fails or sends a line that is not a plain address leaves the list as it was, and says so once', async () => {
    answer.body = { repos: [REPO] };
    const { root, tools, stateDir } = setup(KEEPER);
    sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, intervalMs: 60_000, log: (l) => logs.push(l) });
    await until(() => existsSync(join(stateDir, 'sync', 'started')));
    const good = readFileSync(join(stateDir, 'repos.txt'), 'utf8');
    answer.status = 500;
    expect(await sync.poll()).toBe(false);
    expect(await sync.poll()).toBe(false);
    answer.status = 200;
    answer.body = { repos: [{ ...REPO, origin: 'http://github.com/acme/site' }] };
    expect(await sync.poll()).toBe(false);
    expect(readFileSync(join(stateDir, 'repos.txt'), 'utf8')).toBe(good);
    expect(logs.filter((l) => l.includes('answered 500'))).toHaveLength(1);
    expect(logs.some((l) => l.includes('was refused'))).toBe(true);
    const wrong = startServerRepos({ siteUrl: base, key: () => `mtb_${'8'.repeat(64)}`, toolsDir: tools, root, stateDir: join(root, 'other'), intervalMs: 60_000, log: (l) => logs.push(l) });
    expect(await wrong.poll()).toBe(false);
    await wrong.close();
    expect(logs.some((l) => l.includes('does not accept this key'))).toBe(true);
  });

  it('with no answer from the site at the start the list is empty, and the sync step still runs', async () => {
    answer.status = 503;
    const { root, tools, stateDir } = setup(KEEPER);
    sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, intervalMs: 60_000, log: (l) => logs.push(l) });
    await until(() => existsSync(join(stateDir, 'sync', 'started')));
    expect(readFileSync(join(stateDir, 'repos.txt'), 'utf8')).toBe('');
  });
});

describe('trouble that must not end the bridge (P26 review M6)', () => {
  it('a list that cannot be written (the state folder is a file) is a logged failure, not an unhandled rejection, and the next poll tries again', async () => {
    const rejections: unknown[] = [];
    const onRejection = (e: unknown): void => void rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      answer.body = { repos: [REPO] };
      const { root, tools, stateDir } = setup(KEEPER);
      // the folder of the list is made unwritable by putting a file where the list must go
      mkdirSync(join(stateDir, 'repos.txt'));
      sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, intervalMs: 20, log: (l) => logs.push(l) });
      await until(() => logs.some((l) => l.includes('could not be written')));
      expect(await sync.poll()).toBe(false);
      expect(logs.filter((l) => l.includes('could not be written'))).toHaveLength(1);
      // the trouble goes away: the list is written
      rmSync(join(stateDir, 'repos.txt'), { recursive: true });
      await until(() => existsSync(join(stateDir, 'repos.txt')) && readFileSync(join(stateDir, 'repos.txt'), 'utf8') !== '');
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('two polls at once are one request, and a list longer than the limit is refused without being kept', async () => {
    const { root, tools, stateDir } = setup(KEEPER);
    sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, intervalMs: 60_000, log: (l) => logs.push(l) });
    await until(() => existsSync(join(stateDir, 'sync', 'started')));
    const before = answer.calls;
    const both = await Promise.all([sync.poll(), sync.poll(), sync.poll()]);
    expect(both).toEqual([true, true, true]);
    expect(answer.calls - before).toBe(1);
    // 3 MiB of list: more than the bridge reads
    answer.body = { repos: [], pad: 'x'.repeat(3 * 1024 * 1024) } as never;
    expect(await sync.poll()).toBe(false);
    expect(logs.some((l) => l.includes('was refused'))).toBe(true);
  });
});

describe('the sync step', () => {
  it('is started again when it ends, and ended with its children when the bridge stops', async () => {
    const { root, tools, stateDir } = setup('echo x >> "$REPO_SYNC_SCRATCH/runs"\nif [ "$(wc -l < "$REPO_SYNC_SCRATCH/runs")" -lt 2 ]; then exit 3; fi\necho "$$" > "$REPO_SYNC_SCRATCH/pid"\nexec sleep 300\n');
    sync = startServerRepos({ siteUrl: base, key: () => KEY, toolsDir: tools, root, stateDir, intervalMs: 60_000, restartMs: 50, log: (l) => logs.push(l) });
    const pidFile = join(stateDir, 'sync', 'pid');
    await until(() => existsSync(pidFile));
    expect(logs.some((l) => l.includes('ended (3)'))).toBe(true);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(() => process.kill(pid, 0)).not.toThrow();
    await sync.close();
    sync = undefined;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
  });
});
