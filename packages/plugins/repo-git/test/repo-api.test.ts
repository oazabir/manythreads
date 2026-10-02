import { randomUUID } from 'node:crypto';
import { CommitRepoResponse, GetRepoBlobResponse, GetRepoTreeResponse, RepoConflictResponse } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createGitLayer } from '../src/git/index.ts';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from './world.ts';

const { omar, nadia, priya, sameera, lena } = personas;
const git = createGitLayer();

// Dozens of git processes per test: under a full parallel run the default 5 s is too tight.
vi.setConfig({ testTimeout: 60_000 });

let w: RepoWorld;
beforeAll(async () => {
  w = await createRepoWorld();
}, 180_000);
afterAll(async () => {
  await w?.close();
});

const eng = TEAM_IDS.Engineering;
const put = (path: string, content: string, extra: Record<string, unknown> = {}) => ({ op: 'put', path, content, ...extra });
const tree = (who: typeof omar | null, slug: string, query = '') => w.call(who, 'GET', `/api/teams/${slug}/repo/tree${query}`);
const blob = (who: typeof omar | null, slug: string, path: string, ref = 'main') =>
  w.call(who, 'GET', `/api/teams/${slug}/repo/blob?path=${encodeURIComponent(path)}&ref=${ref}`);
const head = async (teamId: string): Promise<string | null> => git.resolve(w.gitDir(teamId), 'main');
const history = async (teamId: string) => (await git.log(w.gitDir(teamId), { limit: 500 })).commits;
const waitFor = async <T>(fn: () => Promise<T | undefined | null | false>, ms = 15_000): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('the repo of a new team has the section 5.1 layout (criterion 1)', () => {
  it('Engineering: TEAM.md from its template, one folder each, memory/journal and memory/facts, one first commit', async () => {
    const res = await tree(omar, 'engineering');
    expect(res.status).toBe(200);
    const root = GetRepoTreeResponse.parse(res.body);
    expect(root.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'dir:bots',
      'dir:knowledge',
      'dir:memory',
      'dir:pages',
      'dir:routines',
      'dir:skills',
      'file:TEAM.md',
    ]);
    const memory = GetRepoTreeResponse.parse((await tree(omar, 'engineering', '?path=memory')).body);
    expect(memory.entries.map((e) => e.name)).toEqual(['facts', 'journal']);
    for (const dir of ['bots', 'skills', 'routines', 'knowledge', 'pages', 'memory/journal', 'memory/facts']) {
      const listing = GetRepoTreeResponse.parse((await tree(omar, 'engineering', `?path=${dir}`)).body);
      expect(listing.entries.map((e) => e.name), dir).toEqual(['.gitkeep']);
    }
    const teamMd = GetRepoBlobResponse.parse((await blob(omar, 'engineering', 'TEAM.md')).body);
    expect(teamMd.content).toMatch(/^---\nname: Engineering\n/);
    expect(teamMd.encoding).toBe('utf8');

    const commits = await history(eng);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('Create the team repository');
    expect(root.commitSha).toBe(commits[0]?.sha);
    // the index mirrors git
    await w.system(async (tx) => {
      const repo = (await tx.query<{ head_sha: string }>('SELECT head_sha FROM app.repos WHERE team_id = $1', [eng])).rows[0];
      expect(repo?.head_sha).toBe(commits[0]?.sha);
      const entries = (await tx.query<{ path: string }>('SELECT path FROM app.repo_entries WHERE team_id = $1 ORDER BY path', [eng])).rows.map((r) => r.path);
      expect(entries).toContain('TEAM.md');
      expect(entries).toContain('memory/facts/.gitkeep');
      expect(entries).toHaveLength(8);
      expect((await tx.query('SELECT 1 FROM app.repo_commits WHERE team_id = $1', [eng])).rows).toHaveLength(1);
    });
  });

  it('is created once however many ask at once', async () => {
    const slug = 'marketing';
    await Promise.all(Array.from({ length: 6 }, (_, i) => tree(i % 2 ? omar : personas.tariq, slug)));
    expect(await history(TEAM_IDS.Marketing)).toHaveLength(1);
  });

  it('team creation makes the repo through the job: the pending TEAM.md is committed and stamped applied', async () => {
    const created = await w.call<{ team: { id: string } }>(omar, 'POST', '/api/teams/from-template', { templateId: 'research', slug: 'lab' });
    expect(created.status).toBe(201);
    const teamId = created.body.team.id;
    const template = await w.system(async (tx) => (await tx.query<{ files: Record<string, string> }>('SELECT files FROM app.team_pending_files WHERE team_id = $1', [teamId])).rows[0]!.files);
    await waitFor(async () => (await head(teamId)) !== null);
    const teamMd = await git.blob(w.gitDir(teamId), 'TEAM.md', 'main', 100_000);
    expect(teamMd.content.toString()).toBe(template['TEAM.md']);
    await waitFor(async () =>
      w.system(async (tx) => (await tx.query<{ applied_at: Date | null }>('SELECT applied_at FROM app.team_pending_files WHERE team_id = $1', [teamId])).rows[0]?.applied_at),
    );
    expect(await history(teamId)).toHaveLength(1);
    // the committed event is in the log, once
    const events = await w.system(async (tx) => (await tx.query('SELECT 1 FROM app.events WHERE type = $1 AND team_id = $2', ['repo.repo.committed', teamId])).rows);
    expect(events).toHaveLength(1);
  });

  it('a team without a template gets a minimal TEAM.md with its name', async () => {
    const created = await w.call<{ team: { id: string } }>(omar, 'POST', '/api/teams', { name: 'Skunk Works', slug: 'skunk' });
    expect(created.status).toBe(201);
    const blank = GetRepoBlobResponse.parse((await blob(omar, 'skunk', 'TEAM.md')).body);
    expect(blank.content).toContain('name: "Skunk Works"');
    expect(blank.content).toContain('# Skunk Works');
  });
});

describe('who may write (criteria 3 and 9)', () => {
  it('a member saves a page: one commit, the person is the author', async () => {
    const before = (await history(eng)).length;
    const res = await w.commit(nadia, 'engineering', [put('pages/runbook.md', '# Runbook\n')], 'Add the runbook');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = CommitRepoResponse.parse(res.body);
    expect(out.noop).toBe(false);
    expect(out.authorId).toBe(nadia.actorId);
    expect(out.paths).toMatchObject([{ path: 'pages/runbook.md', op: 'put' }]);
    const commits = await history(eng);
    expect(commits).toHaveLength(before + 1);
    expect(commits[0]).toMatchObject({ sha: out.sha, subject: 'Add the runbook', author: { name: 'Nadia', email: `${nadia.actorId}@actors.manythreads.invalid` } });
  });

  it('Priya (a member, not a lead) gets 403 "change by pull request" on bots/, TEAM.md, skills/ and routines/, and nothing is committed', async () => {
    const before = await head(eng);
    for (const path of ['bots/coder/BOT.md', 'TEAM.md', 'skills/x/SKILL.md', 'routines/nightly.yaml']) {
      const res = await w.commit(priya, 'engineering', [put(path, 'x\n')], 'sneaky');
      expect(res.status, path).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/pull request/i);
    }
    expect(await head(eng)).toBe(before);
    // she can write a page
    expect((await w.commit(priya, 'engineering', [put('pages/priya.md', 'hello\n')], 'Priya page')).status).toBe(201);
    // a guarded path in a mixed commit refuses the whole commit
    const mixed = await w.commit(priya, 'engineering', [put('pages/ok.md', 'ok\n'), put('TEAM.md', 'x\n')], 'mixed');
    expect(mixed.status).toBe(403);
    expect((await blob(priya, 'engineering', 'pages/ok.md')).status).toBe(404);
  });

  it('Omar (a lead and admin) commits bots/ and TEAM.md directly, as Omar', async () => {
    const res = await w.commit(omar, 'engineering', [put('bots/coder/BOT.md', '---\nname: Coder\n---\n'), put('TEAM.md', '---\nname: Engineering\n---\n\nNew purpose.\n')], 'Configure Coder');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = CommitRepoResponse.parse(res.body);
    expect(out.authorId).toBe(omar.actorId);
    const [c] = await history(eng);
    expect(c?.author).toEqual({ name: 'Omar', email: `${omar.actorId}@actors.manythreads.invalid` });
  });

  it('outsiders, guests and anonymous callers are refused', async () => {
    const before = await head(eng);
    expect((await w.commit(sameera, 'engineering', [put('pages/x.md', 'x')], 'no')).status).toBe(403); // another team
    expect((await w.commit(lena, 'engineering', [put('pages/x.md', 'x')], 'no')).status).toBe(403); // guest
    expect((await w.commit(null, 'engineering', [put('pages/x.md', 'x')], 'no')).status).toBe(401);
    expect((await tree(sameera, 'engineering')).status).toBe(403);
    expect((await tree(lena, 'engineering')).status).toBe(403);
    expect((await tree(nadia, 'marketing')).status).toBe(403);
    expect((await blob(nadia, 'marketing', 'TEAM.md')).status).toBe(403);
    expect((await tree(omar, 'no-such-team')).status).toBe(404); // an admin sees every team: a missing slug is 404
    expect((await tree(nadia, 'no-such-team')).status).toBe(403); // a member cannot tell
    expect(await head(eng)).toBe(before);
  });
});

describe('the bot path guard goes through the kernel broker (criterion 5)', () => {
  it('denies the four guarded paths, logs each denial, allows pages/x.md', async () => {
    const bot = await w.makeBot(eng, ['files.write']);
    const before = await head(eng);
    const denied = ['bots/x/BOT.md', 'TEAM.md', 'skills/x/SKILL.md', 'routines/x.yaml', 'Bots/x/BOT.md', 'team.md', 'pages/%2e%2e/bots/x.md'];
    for (const path of denied) {
      const res = await w.commit(bot, 'engineering', [put(path, 'x\n')], 'bot write');
      expect(res.status, path).toBe(403);
    }
    expect(await head(eng)).toBe(before);
    const ok = await w.commit(bot, 'engineering', [put('pages/x.md', 'from a bot\n')], 'Bot page');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(CommitRepoResponse.parse(ok.body).authorId).toBe(bot.actorId);
    const [c] = await history(eng);
    expect(c?.author.email).toBe(`${bot.actorId}@actors.manythreads.invalid`);
    // every denial is an audit event
    const events = await w.system(async (tx) =>
      (await tx.query<{ payload: { path: string; capability: string } }>("SELECT payload FROM app.events WHERE type = 'kernel.capability.denied' AND payload->>'actorId' = $1", [bot.actorId])).rows.map((r) => r.payload),
    );
    expect(events.map((e) => e.path).sort()).toEqual([...denied].sort());
    expect(new Set(events.map((e) => e.capability))).toEqual(new Set(['files.write']));
  });

  it('a bot with no grant, and a bot deleting (destructive), are refused even for pages/', async () => {
    const bare = await w.makeBot(eng, []);
    expect((await w.commit(bare, 'engineering', [put('pages/n.md', 'x')], 'no grant')).status).toBe(403);
    const writer = await w.makeBot(eng, ['files.write']);
    expect((await w.commit(writer, 'engineering', [put('pages/del.md', 'x\n')], 'add')).status).toBe(201);
    const del = await w.commit(writer, 'engineering', [{ op: 'delete', path: 'pages/del.md' }], 'remove');
    expect(del.status).toBe(403);
    expect((await blob(omar, 'engineering', 'pages/del.md')).status).toBe(200);
  });
});

describe('text only (criterion 4)', () => {
  it('a PNG to pages/ is 422 attachment_not_in_repo and nothing is committed or indexed', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR')]);
    const before = await head(eng);
    const res = await w.commit(nadia, 'engineering', [{ op: 'put', path: 'pages/logo.png', content: png.toString('base64'), encoding: 'base64' }], 'logo');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: { code: 'attachment_not_in_repo' } });
    expect(await head(eng)).toBe(before);
    expect((await blob(nadia, 'engineering', 'pages/logo.png')).status).toBe(404);
    await w.system(async (tx) => expect((await tx.query("SELECT 1 FROM app.repo_entries WHERE team_id = $1 AND path = 'pages/logo.png'", [eng])).rows).toHaveLength(0));
    // text with a NUL, in the first 8 KB, is binary too; a good file in the same commit is not written either
    const nul = await w.commit(nadia, 'engineering', [put('pages/ok2.md', 'fine\n'), put('pages/nul.md', 'a\u0000b')], 'nul');
    expect(nul.status).toBe(422);
    expect(await head(eng)).toBe(before);
    // invalid base64
    expect((await w.commit(nadia, 'engineering', [{ op: 'put', path: 'pages/b.bin', content: '***', encoding: 'base64' }], 'bad')).status).toBe(400);
  });
});

describe('concurrency (criterion 2)', () => {
  it('20 concurrent writes to different files: a linear history with all 20 commits and every change', async () => {
    const before = (await history(eng)).length;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.commit(i % 2 ? nadia : omar, 'engineering', [put(`pages/c/${i}.md`, `page ${i}\n`)], `Page ${i}`)),
    );
    expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
    const commits = await history(eng);
    expect(commits).toHaveLength(before + 20);
    for (const c of commits) expect(c.parents.length).toBeLessThanOrEqual(1);
    const tip = await git.tree(w.gitDir(eng), 'pages/c', 'main');
    expect(tip.entries.map((e) => e.name).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `${i}.md`).sort());
    for (let i = 0; i < 20; i += 1) expect((await git.blob(w.gitDir(eng), `pages/c/${i}.md`, 'main', 1000)).content.toString()).toBe(`page ${i}\n`);
    await w.system(async (tx) => {
      expect((await tx.query<{ head_sha: string }>('SELECT head_sha FROM app.repos WHERE team_id = $1', [eng])).rows[0]?.head_sha).toBe(commits[0]?.sha);
      expect((await tx.query("SELECT 1 FROM app.repo_entries WHERE team_id = $1 AND path LIKE 'pages/c/%'", [eng])).rows).toHaveLength(20);
      expect((await tx.query('SELECT 1 FROM app.repo_commits WHERE team_id = $1', [eng])).rows).toHaveLength(commits.length);
    });
  });

  it('two writes to one file from the same base: one commits, the other gets 409 with the current content, nothing is overwritten', async () => {
    const created = CommitRepoResponse.parse((await w.commit(nadia, 'engineering', [put('pages/race.md', 'v1\n')], 'race base')).body);
    const base = created.paths[0]!.blobSha!;
    const [a, b] = await Promise.all([
      w.commit(nadia, 'engineering', [put('pages/race.md', 'from nadia\n', { baseBlobSha: base })], 'Nadia edit'),
      w.commit(omar, 'engineering', [put('pages/race.md', 'from omar\n', { baseBlobSha: base })], 'Omar edit'),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const winner = a.status === 201 ? 'from nadia\n' : 'from omar\n';
    const loser = a.status === 201 ? b : a;
    const conflict = RepoConflictResponse.parse(loser.body);
    expect(conflict.error.code).toBe('conflict');
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]).toMatchObject({ path: 'pages/race.md', reason: 'changed', currentContent: winner });
    expect(conflict.conflicts[0]?.currentBlobSha).not.toBe(base);
    expect((await git.blob(w.gitDir(eng), 'pages/race.md', 'main', 1000)).content.toString()).toBe(winner);
  });

  it('a conflict in one change refuses the whole commit; create-only, missing and stale bases are told apart', async () => {
    const f = CommitRepoResponse.parse((await w.commit(nadia, 'engineering', [put('pages/c1.md', 'one\n'), put('pages/c2.md', 'two\n')], 'two files')).body);
    const [b1, b2] = f.paths.map((p) => p.blobSha!);
    const before = await head(eng);
    const stale = await w.commit(omar, 'engineering', [put('pages/c1.md', 'ONE\n', { baseBlobSha: b1 }), put('pages/c2.md', 'TWO\n', { baseBlobSha: b1 })], 'mixed bases');
    expect(stale.status).toBe(409);
    expect(RepoConflictResponse.parse(stale.body).conflicts.map((c) => [c.path, c.reason])).toEqual([['pages/c2.md', 'changed']]);
    expect(await head(eng)).toBe(before);
    expect((await git.blob(w.gitDir(eng), 'pages/c1.md', 'main', 100)).content.toString()).toBe('one\n');

    const exists = await w.commit(omar, 'engineering', [put('pages/c1.md', 'x', { baseBlobSha: null })], 'create only');
    expect(RepoConflictResponse.parse(exists.body).conflicts[0]?.reason).toBe('exists');
    const missing = await w.commit(omar, 'engineering', [put('pages/ghost.md', 'x', { baseBlobSha: b2 })], 'edit a ghost');
    expect(RepoConflictResponse.parse(missing.body).conflicts[0]).toMatchObject({ reason: 'missing', currentContent: null });
    const delStale = await w.commit(omar, 'engineering', [{ op: 'delete', path: 'pages/c2.md', baseBlobSha: b1 }], 'delete stale');
    expect(delStale.status).toBe(409);
    expect((await w.commit(omar, 'engineering', [put('pages/fresh.md', 'x', { baseBlobSha: null })], 'create only ok')).status).toBe(201);
    expect((await w.commit(omar, 'engineering', [{ op: 'delete', path: 'pages/c2.md', baseBlobSha: b2 }], 'delete fresh')).status).toBe(201);
    expect((await blob(omar, 'engineering', 'pages/c2.md')).status).toBe(404);
    expect(await head(eng)).not.toBe(before);
  });

  it('files and folders of one name conflict instead of corrupting the tree', async () => {
    await w.commit(nadia, 'engineering', [put('pages/leaf.md', 'x\n'), put('pages/dir/inner.md', 'y\n')], 'shapes');
    const below = await w.commit(nadia, 'engineering', [put('pages/leaf.md/child.md', 'z')], 'below a file');
    expect(RepoConflictResponse.parse(below.body).conflicts[0]?.reason).toBe('parent_is_file');
    const over = await w.commit(nadia, 'engineering', [put('pages/dir', 'z')], 'over a folder');
    expect(RepoConflictResponse.parse(over.body).conflicts[0]?.reason).toBe('folder');
    expect((await w.commit(nadia, 'engineering', [put('pages/a', 'z'), put('pages/a/b', 'z')], 'overlap')).status).toBe(400);
  });

  it('concurrent appends all land', async () => {
    await w.commit(nadia, 'engineering', [put('pages/journal.md', 'start\n')], 'journal');
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) => w.commit(i % 2 ? nadia : omar, 'engineering', [{ op: 'append', path: 'pages/journal.md', content: `line ${i}\n` }], `append ${i}`)),
    );
    expect(res.map((r) => r.status)).toEqual(Array(8).fill(201));
    const text = (await git.blob(w.gitDir(eng), 'pages/journal.md', 'main', 10_000)).content.toString();
    expect(text.split('\n').sort()).toEqual(['', 'line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'start'].sort());
  });

  it('writing what is already there is not a commit', async () => {
    await w.commit(nadia, 'engineering', [put('pages/same.md', 'same\n')], 'same');
    const before = await head(eng);
    const res = await w.commit(nadia, 'engineering', [put('pages/same.md', 'same\n')], 'same again');
    expect(res.status).toBe(200);
    expect(CommitRepoResponse.parse(res.body)).toMatchObject({ noop: true, sha: before });
    expect(await head(eng)).toBe(before);
    expect((await w.commit(nadia, 'engineering', [{ op: 'delete', path: 'pages/never-existed.md' }], 'rm')).status).toBe(200);
  });
});

describe('paths', () => {
  it.each(['../x.md', 'pages/../../x.md', '/etc/passwd', '.git/config', 'pages/.git/hooks/x', 'pages/.GIT/x', 'pages//x.md', 'pages/', 'a\\b.md', 'pages/x.md.', ''])(
    'refuses %j and commits nothing',
    async (path) => {
      const before = await head(eng);
      const res = await w.commit(nadia, 'engineering', [put(path, 'x')], 'bad path');
      expect(res.status, path).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'validation_failed' } });
      expect(await head(eng)).toBe(before);
    },
  );

  it('stores a decomposed name NFC-normalised', async () => {
    const res = await w.commit(nadia, 'engineering', [put('pages/café.md', 'x\n')], 'cafe');
    expect(res.status).toBe(201);
    expect(CommitRepoResponse.parse(res.body).paths[0]?.path).toBe('pages/café.md');
    expect((await blob(nadia, 'engineering', 'pages/café.md')).status).toBe(200);
  });

  it('reads refuse traversal and odd refs', async () => {
    expect((await tree(nadia, 'engineering', '?path=..')).status).toBe(400);
    expect((await tree(nadia, 'engineering', '?path=pages/../bots')).status).toBe(400);
    expect((await tree(nadia, 'engineering', '?ref=--output=x')).status).toBe(400);
    expect((await tree(nadia, 'engineering', '?ref=refs/heads/main')).status).toBe(400);
    expect((await tree(nadia, 'engineering', '?path=nope')).status).toBe(404);
    expect((await tree(nadia, 'engineering', '?path=TEAM.md')).status).toBe(400);
    expect((await blob(nadia, 'engineering', 'pages')).status).toBe(400);
    expect((await blob(nadia, 'engineering', '../etc/passwd')).status).toBe(400);
  });

  it('reads an older commit by sha', async () => {
    const v1 = CommitRepoResponse.parse((await w.commit(nadia, 'engineering', [put('pages/versions.md', 'v1\n')], 'v1')).body);
    await w.commit(nadia, 'engineering', [put('pages/versions.md', 'v2\n')], 'v2');
    expect(GetRepoBlobResponse.parse((await blob(nadia, 'engineering', 'pages/versions.md', v1.sha)).body).content).toBe('v1\n');
    expect(GetRepoBlobResponse.parse((await blob(nadia, 'engineering', 'pages/versions.md')).body).content).toBe('v2\n');
    expect((await blob(nadia, 'engineering', 'pages/versions.md', randomUUID().replaceAll('-', '').slice(0, 40))).status).toBe(404);
  });

  it('strict bodies: unknown keys and a missing message are 400', async () => {
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/repo/commit', { changes: [put('pages/z.md', 'x')], message: 'm', author: 'someone else' })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/repo/commit', { changes: [put('pages/z.md', 'x')], message: ' ' })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/repo/commit', { changes: [], message: 'm' })).status).toBe(400);
    expect((await w.call(nadia, 'POST', '/api/teams/engineering/repo/commit', { changes: [{ op: 'put', path: 'pages/z.md', content: 'x', coAuthors: [] }], message: 'm' })).status).toBe(400);
  });
});
