import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_NAME, evaluatePull, publishReport, type GithubTarget } from '../src/github-pr-evals.ts';

// P8-05: the eval check on a pull request. A local double of the part of GitHub's API it uses (list a pull request's files, read a file at a commit, write a check
// run or a commit status) serves a real template bot from disk, so the judge that runs is the one `pnpm test:evals` uses. No database, no model.

const TEMPLATES = fileURLToPath(new URL('../../../../templates/', import.meta.url));
const SHA = 'a'.repeat(40);
const TOKEN = 'ghs_TOKEN_SENTINEL_91ac';

let server: Server;
let target: GithubTarget;
/** The state of the double: what the pull request changes and the files at the head commit. */
const world = { changed: [] as Array<{ filename: string; status: string }>, files: new Map<string, string>(), writes: [] as Array<{ path: string; body: Record<string, unknown> }>, unauthorized: 0, reads: [] as string[] };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const send = (status: number, body: string, type = 'application/json'): void => void res.writeHead(status, { 'content-type': type }).end(body);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        world.unauthorized++;
        return send(401, '{"message":"Bad credentials"}');
      }
      const files = /^\/repos\/acme\/team-repo\/pulls\/(\d+)\/files$/.exec(url.pathname);
      if (files && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return send(200, JSON.stringify(world.changed.slice((page - 1) * 100, page * 100)));
      }
      const content = /^\/repos\/acme\/team-repo\/contents\/(.+)$/.exec(url.pathname);
      if (content && req.method === 'GET') {
        const path = decodeURIComponent(content[1]!);
        world.reads.push(`${path}@${url.searchParams.get('ref')}`);
        const text = world.files.get(path);
        return text === undefined ? send(404, '{"message":"Not Found"}') : send(200, text, 'text/plain');
      }
      if ((url.pathname === '/repos/acme/team-repo/check-runs' || url.pathname.startsWith(`/repos/acme/team-repo/statuses/`)) && req.method === 'POST') {
        world.writes.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
        return send(201, '{}');
      }
      return send(404, '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  target = { apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: TOKEN, owner: 'acme', repo: 'team-repo' };
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
});

async function loadTemplateBot(slug: string, team = 'marketing'): Promise<void> {
  const dir = `${TEMPLATES}${team}/bots/${slug}/`;
  world.files.set(`bots/${slug}/BOT.md`, await readFile(`${dir}BOT.md`, 'utf8'));
  world.files.set(`bots/${slug}/evals/${slug}.yaml`, await readFile(`${dir}evals/${slug}.yaml`, 'utf8'));
}
const reset = (): void => {
  world.changed = [];
  world.files = new Map();
  world.writes = [];
  world.reads = [];
};

describe('evaluatePull', () => {
  it('a pull request that touches no bot writes nothing', async () => {
    reset();
    world.changed = [{ filename: 'README.md', status: 'modified' }, { filename: 'bots/a/b/BOT.md', status: 'modified' }, { filename: 'bots/x/notes.md', status: 'added' }];
    const report = await evaluatePull(target, { number: 7, headSha: SHA });
    expect(report.touched).toBe(false);
    expect(world.reads).toEqual([]);
  });

  it('a bot that keeps what its cases require passes, read at the head commit', async () => {
    reset();
    await loadTemplateBot('content-drafter');
    world.changed = [{ filename: 'bots/content-drafter/BOT.md', status: 'modified' }, { filename: 'docs/x.md', status: 'added' }];
    const report = await evaluatePull(target, { number: 7, headSha: SHA });
    expect(report).toMatchObject({ touched: true, conclusion: 'success' });
    expect(report.bots[0]).toMatchObject({ slug: 'content-drafter', state: 'passed' });
    expect(report.summary).toContain('content-drafter:');
    expect(report.summary).toContain('no model');
    expect(world.reads.every((r) => r.endsWith(`@${SHA}`))).toBe(true);
  });

  it('a BOT.md that drops a capability a case requires fails, and says which case', async () => {
    reset();
    await loadTemplateBot('content-drafter');
    world.files.set('bots/content-drafter/BOT.md', world.files.get('bots/content-drafter/BOT.md')!.replace('    - pages.write\n', ''));
    world.changed = [{ filename: 'bots/content-drafter/BOT.md', status: 'modified' }];
    const report = await evaluatePull(target, { number: 7, headSha: SHA });
    expect(report.conclusion).toBe('failure');
    expect(report.bots[0]).toMatchObject({ state: 'failed' });
    expect(report.bots[0]!.failures.length).toBeGreaterThan(0);
    expect(report.summary).toContain('below the minimum');
  });

  it('a BOT.md that does not load fails with the reason; a missing set file is named', async () => {
    reset();
    world.files.set('bots/broken/BOT.md', '---\nname: [\n---\nhello');
    world.changed = [{ filename: 'bots/broken/BOT.md', status: 'added' }];
    const broken = await evaluatePull(target, { number: 8, headSha: SHA });
    expect(broken.conclusion).toBe('failure');
    expect(broken.bots[0]).toMatchObject({ slug: 'broken', state: 'problem' });
    reset();
    await loadTemplateBot('content-drafter');
    world.files.delete('bots/content-drafter/evals/content-drafter.yaml');
    world.changed = [{ filename: 'bots/content-drafter/BOT.md', status: 'modified' }];
    const missing = await evaluatePull(target, { number: 8, headSha: SHA });
    expect(missing.conclusion).toBe('failure');
    expect(missing.summary).toContain('evals/content-drafter.yaml');
  });

  it('removing a bot is not a failure; a change to a scenario file alone checks the bot', async () => {
    reset();
    world.changed = [{ filename: 'bots/old-bot/BOT.md', status: 'removed' }];
    const removed = await evaluatePull(target, { number: 9, headSha: SHA });
    expect(removed).toMatchObject({ touched: true, conclusion: 'neutral' });
    expect(removed.summary).toContain('old-bot: removed');
    reset();
    await loadTemplateBot('content-drafter');
    world.changed = [{ filename: 'bots/content-drafter/evals/content-drafter.yaml', status: 'modified' }];
    expect((await evaluatePull(target, { number: 9, headSha: SHA })).bots[0]).toMatchObject({ slug: 'content-drafter', state: 'passed' });
  });

  it('pages through a long list of changed files', async () => {
    reset();
    await loadTemplateBot('content-drafter');
    world.changed = [...Array.from({ length: 130 }, (_, i) => ({ filename: `docs/${i}.md`, status: 'added' })), { filename: 'bots/content-drafter/BOT.md', status: 'modified' }];
    expect((await evaluatePull(target, { number: 9, headSha: SHA })).bots).toHaveLength(1);
  });

  it('a token GitHub turns down is a plain failure that holds no token', async () => {
    const error = await evaluatePull({ ...target, token: 'wrong-token-VALUE' }, { number: 7, headSha: SHA }).catch((e: unknown) => e as Error);
    expect(error).toMatchObject({ code: 'refused' });
    expect((error as Error).message).not.toContain('wrong-token-VALUE');
  });

  it('refuses a repository name or a commit that is not plain, before asking GitHub', async () => {
    await expect(evaluatePull({ ...target, repo: '../../x' }, { number: 7, headSha: SHA })).rejects.toMatchObject({ code: 'bad_config' });
    await expect(evaluatePull(target, { number: 0, headSha: SHA })).rejects.toMatchObject({ code: 'bad_config' });
    reset();
    await loadTemplateBot('content-drafter');
    world.changed = [{ filename: 'bots/content-drafter/BOT.md', status: 'modified' }];
    await expect(evaluatePull(target, { number: 7, headSha: 'not-a-sha' })).rejects.toMatchObject({ code: 'bad_config' });
    expect(world.reads).toEqual([]); // not one file was asked for
  });
});

describe('publishReport', () => {
  const report = { touched: true, conclusion: 'failure' as const, title: 'A bot in this pull request does not pass its checks', summary: 'details', bots: [] };

  it('writes a check run when the token is an app’s', async () => {
    reset();
    await publishReport(target, SHA, report, 'check');
    expect(world.writes).toHaveLength(1);
    expect(world.writes[0]!.path).toBe('/repos/acme/team-repo/check-runs');
    expect(world.writes[0]!.body).toMatchObject({ name: CHECK_NAME, head_sha: SHA, status: 'completed', conclusion: 'failure', output: { title: report.title } });
    expect(JSON.stringify(world.writes)).not.toContain(TOKEN);
  });

  it('writes a commit status when it is not', async () => {
    reset();
    await publishReport(target, SHA, report, 'status');
    expect(world.writes[0]!.path).toBe(`/repos/acme/team-repo/statuses/${SHA}`);
    expect(world.writes[0]!.body).toMatchObject({ state: 'failure', context: CHECK_NAME });
    await publishReport(target, SHA, { ...report, conclusion: 'neutral' }, 'status');
    expect(world.writes[1]!.body).toMatchObject({ state: 'success' });
  });

  it('says plainly when GitHub will not take it', async () => {
    await expect(publishReport({ ...target, token: 'nope' }, SHA, report, 'check')).rejects.toMatchObject({ code: 'refused' });
  });
});
