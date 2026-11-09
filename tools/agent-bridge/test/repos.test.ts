import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRepoList, toLines } from '../src/repos.ts';
import { auth, harness, type Harness } from './support.ts';

// PUT /internal/repos (P19-09, decision E4): the pod's controller sends the repository list, the bridge checks it and writes the file the repo-sync step reads.
// A project added by a team has to reach that file in seconds, and a list with one bad line must never be half-written.

let h: Harness;
let folder: string;
let file: string;
beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'bridge-repos-'));
  file = join(folder, 'run', 'repos.txt');
  h = await harness({}, 'claude-code', { reposFile: file });
});
afterEach(async () => {
  await h.close();
  rmSync(folder, { recursive: true, force: true });
});

const repo = (over: Record<string, unknown> = {}) => ({ team: 'engineering', bot: 'builder', project: 'widgets', branch: 'main', origin: 'https://github.com/acme/widgets.git', ...over });
const put = (body: unknown, headers: Record<string, string> = auth, url = h.bridge.url) =>
  fetch(`${url}/internal/repos`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('PUT /internal/repos', () => {
  it('needs the bridge key, like every route', async () => {
    expect((await put({ repos: [repo()] }, {})).status).toBe(401);
    expect((await put({ repos: [repo()] }, { authorization: 'Bearer nope' })).status).toBe(401);
    expect(existsSync(file)).toBe(false);
  });

  it('writes one line per clone, the whole list in one step, and a second list replaces the first', async () => {
    const res = await put({ repos: [repo(), repo({ bot: 'writer', project: 'site', branch: null, origin: 'https://example.test/site.git' })] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 2 });
    expect(readFileSync(file, 'utf8')).toBe('engineering builder widgets main https://github.com/acme/widgets.git\nengineering writer site - https://example.test/site.git\n');
    expect((await put({ repos: [repo({ project: 'other' })] })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('engineering builder other main https://github.com/acme/widgets.git\n');
    // the temporary file is gone: the sync step sees the list or the old list, never a part
    expect(readdirSync(join(folder, 'run'))).toEqual(['repos.txt']);
  });

  it('writes an empty file for an empty list (the last project was removed)', async () => {
    await put({ repos: [repo()] });
    expect((await put({ repos: [] })).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('refuses a name or address that could change what the sync step does, and leaves the file as it was', async () => {
    await put({ repos: [repo()] });
    const before = readFileSync(file, 'utf8');
    const bad: Array<Record<string, unknown>> = [
      { project: '..' },
      { project: '.hidden' },
      { team: 'a/b' },
      { bot: 'x y' },
      { project: 'a\nengineering evil x - https://evil.test/x.git' },
      { branch: 'a b' },
      { branch: '../x' },
      { origin: 'http://github.com/acme/widgets.git' },
      { origin: 'file:///etc' },
      { origin: 'ssh://git@github.com/acme/w.git' },
      { origin: 'https://github.com/a b' },
      { origin: 'https://github.com/a\nengineering b c - https://evil.test' },
      { origin: 'https://github.com/$(id)' },
      { origin: 123 },
    ];
    for (const over of bad) {
      const res = await put({ repos: [repo(), repo(over)] });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(readFileSync(file, 'utf8')).toBe(before);
    }
  });

  it('refuses a body that is not the list, and a method other than PUT', async () => {
    expect((await put('not json')).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ repos: 'x' })).status).toBe(400);
    expect((await put({ repos: [1] })).status).toBe(400);
    expect((await fetch(`${h.bridge.url}/internal/repos`, { method: 'GET', headers: auth })).status).toBe(405);
  });
});

describe('a bridge started without a repository file', () => {
  it('answers 404: there is no such route for it', async () => {
    const plain = await harness();
    try {
      expect((await put({ repos: [repo()] }, auth, plain.bridge.url)).status).toBe(404);
    } finally {
      await plain.close();
    }
  });
});

describe('parseRepoList', () => {
  it('accepts a list and prints it as the sync step reads it', () => {
    const parsed = parseRepoList({ repos: [repo()] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(toLines(parsed.repos)).toBe('engineering builder widgets main https://github.com/acme/widgets.git\n');
  });
});
