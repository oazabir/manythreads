import { describe, expect, it } from 'vitest';
import { isPlainRepoUrl, parseGithubRepo, isRepoOriginAllowed, parseRepoOriginAllow, ProjectRepoUrl } from '../src/index.ts';

const GOOD = ['https://github.com/a/b', 'https://github.com/a/b.git', 'https://github.com/a/b/', 'https://host:8443/x/y', 'https://github.com/a/...', 'https://github.com/a/.hidden'];
const BAD = [
  'http://github.com/a/b',
  'https://user:pw@github.com/a/b',
  'https://@host/x',
  'https://host/x?',
  'https://host/x#',
  'https://host/x?a=1',
  'https://host/x#f',
  'https://host/a@b',
  'https://host/a/../b',
  'https://host/a/./b',
  'https://host/a/..',
  'https://host/..',
  'https://host/%2e%2e/b',
  'https://host/a/%2E/b',
  'https://host/a/.%2e/b',
  'https://host//x',
  'https://host/a//b',
  'https://host/a b',
  'https://host/a\\b',
  'https://',
  'https:///x',
];

describe('plain repository addresses', () => {
  it('accepts plain addresses', () => {
    for (const g of GOOD) {
      expect(isPlainRepoUrl(g), g).toBe(true);
      expect(ProjectRepoUrl.safeParse(g).success, g).toBe(true);
    }
  });
  it('refuses the rest, in the schema and the helper alike', () => {
    for (const b of BAD) {
      expect(isPlainRepoUrl(b), b).toBe(false);
      expect(ProjectRepoUrl.safeParse(b).success, b).toBe(false);
    }
  });
  it('stays linear on hostile input', () => {
    const t = Date.now();
    isPlainRepoUrl(`https://h/${'a/'.repeat(50_000)}@`);
    isPlainRepoUrl(`https://h/${'/'.repeat(100_000)}`);
    expect(Date.now() - t).toBeLessThan(500);
  });
});

describe('the origin allowlist', () => {
  it('keeps plain https prefixes and ends each at a slash', () => {
    expect(parseRepoOriginAllow('https://github.com/oazabir, http://x/, https://h/../y/, https://github.com/org')).toEqual([
      'https://github.com/oazabir/',
      'https://github.com/org/',
    ]);
    expect(parseRepoOriginAllow(undefined)).toEqual([]);
  });
  it('allows by prefix, never a look-alike or a non-plain address', () => {
    const allow = parseRepoOriginAllow('https://github.com/oazabir');
    expect(isRepoOriginAllowed('https://github.com/oazabir/manythreads', allow)).toBe(true);
    expect(isRepoOriginAllowed('https://github.com/oazabir-evil/x', allow)).toBe(false);
    expect(isRepoOriginAllowed('https://github.com/oazabir/../evil/x', allow)).toBe(false);
    expect(isRepoOriginAllowed('https://github.com/oazabir/%2e%2e/evil/x', allow)).toBe(false);
  });
});

describe('parseGithubRepo', () => {
  it('names the owner, the repository and the API of github.com and of an enterprise host', () => {
    expect(parseGithubRepo('https://github.com/acme/widgets')).toEqual({ host: 'github.com', owner: 'acme', repo: 'widgets', apiBase: 'https://api.github.com' });
    expect(parseGithubRepo('https://github.com/acme/widgets.git/')).toMatchObject({ owner: 'acme', repo: 'widgets' });
    expect(parseGithubRepo('https://GitHub.com/acme/my.repo_1-x')).toMatchObject({ host: 'github.com', repo: 'my.repo_1-x' });
    expect(parseGithubRepo('https://git.corp.example/acme/widgets')).toEqual({ host: 'git.corp.example', owner: 'acme', repo: 'widgets', apiBase: 'https://git.corp.example/api/v3' });
  });

  it('refuses everything that is not exactly host/owner/repo, and anything that is not a plain address', () => {
    for (const bad of [
      'https://github.com',
      'https://github.com/acme',
      'https://github.com/acme/widgets/tree/main',
      'https://github.com/acme/..',
      'https://github.com/-acme/widgets',
      'https://github.com/acme/wid gets',
      'https://user@github.com/acme/widgets',
      'http://github.com/acme/widgets',
      'https://github.com/acme/widgets?x=1',
      'https://github.com/acme//widgets',
      'git@github.com:acme/widgets.git',
    ])
      expect(parseGithubRepo(bad), bad).toBeNull();
  });

  it('is linear on a long hostile path', () => {
    const t = Date.now();
    parseGithubRepo(`https://github.com/${'a'.repeat(20000)}/${'.'.repeat(20000)}`);
    parseGithubRepo(`https://github.com/acme/${'a.git'.repeat(8000)}x/y`);
    expect(Date.now() - t).toBeLessThan(200);
  });
});
