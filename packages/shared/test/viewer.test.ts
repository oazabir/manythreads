import { describe, expect, it } from 'vitest';
import {
  REPO_APP_PATH_RE,
  ViewerContribution,
  embeddedAppHeaders,
  extensionOf,
  matchPathGlob,
  pickViewerContribution,
  viewerMatches,
} from '../src/index.ts';

describe('viewer contributions (provider.viewer)', () => {
  it('parses a contribution and fills the defaults', () => {
    const c = ViewerContribution.parse({ id: 'pdf', label: 'PDF', match: { ext: ['pdf'], mime: ['application/pdf'] } });
    expect(c).toMatchObject({ priority: 0, input: 'url', editable: false, fallback: false });
    expect(() => ViewerContribution.parse({ id: 'Bad Id', label: 'x', match: {} })).toThrow();
    expect(() => ViewerContribution.parse({ id: 'x', label: 'x', match: { ext: ['.pdf'] } })).toThrow();
    expect(() => ViewerContribution.parse({ id: 'x', label: 'x', match: {}, surprise: 1 })).toThrow();
  });

  it('extension is the last dotted part of the file name, lowercase', () => {
    expect(extensionOf('a/b/Report.PDF')).toBe('pdf');
    expect(extensionOf('a.d/b')).toBe('');
    expect(extensionOf('.gitignore')).toBe('');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
  });

  it('globs: * stays in a folder, ** crosses folders', () => {
    expect(matchPathGlob('bots/*/BOT.md', 'bots/coder/BOT.md')).toBe(true);
    expect(matchPathGlob('bots/*/BOT.md', 'bots/a/b/BOT.md')).toBe(false);
    expect(matchPathGlob('bots/**', 'bots/a/b/c.md')).toBe(true);
    expect(matchPathGlob('**/*.csv', 'pages/reports/signups.csv')).toBe(true);
    expect(matchPathGlob('**/*.csv', 'signups.csv')).toBe(true);
    expect(matchPathGlob('pages/*.md', 'pages/x/y.md')).toBe(false);
    expect(matchPathGlob('TEAM.md', 'TEAM.md')).toBe(true);
    expect(matchPathGlob('TEAM.md', 'team.md')).toBe(false);
  });

  it('globs on hostile input stay fast', () => {
    const glob = '**/'.repeat(30) + 'x*' + '*a'.repeat(30);
    const path = 'a/'.repeat(300) + 'a'.repeat(3000);
    const t = Date.now();
    matchPathGlob(glob, path);
    matchPathGlob('*a*a*a*a*a*a*a*b', 'a'.repeat(5000));
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('matches by mime family, extension or path; folders only by folder rules', () => {
    const img = ViewerContribution.parse({ id: 'img', label: 'I', match: { mime: ['image/*'] } });
    expect(viewerMatches(img, { path: 'x', mime: 'image/png' })).toBe(true);
    expect(viewerMatches(img, { path: 'x.png' })).toBe(false); // no mime, no ext rule
    expect(viewerMatches(img, { path: 'x', mime: 'text/plain' })).toBe(false);
    const app = ViewerContribution.parse({ id: 'app', label: 'A', match: { folder: { has: ['index.html'], lacks: ['index.md'] } } });
    expect(viewerMatches(app, { path: 'a', kind: 'folder', entries: ['index.html'] })).toBe(true);
    expect(viewerMatches(app, { path: 'a', kind: 'folder', entries: ['index.html', 'index.md'] })).toBe(false);
    expect(viewerMatches(app, { path: 'index.html' })).toBe(false);
    expect(viewerMatches(img, { path: 'a', kind: 'folder', mime: 'image/png' })).toBe(false);
  });

  it('frontmatter keys are all required', () => {
    const g = ViewerContribution.parse({ id: 'g', label: 'G', match: { ext: ['md'], frontmatter: ['google'] } });
    expect(viewerMatches(g, { path: 'a.md' })).toBe(false);
    expect(viewerMatches(g, { path: 'a.md', frontmatterKeys: ['google', 'title'] })).toBe(true);
  });

  it('the highest priority wins, the later one on a tie, a fallback only when nothing else claims the file', () => {
    const items = [
      ViewerContribution.parse({ id: 'card', label: 'C', priority: -100, fallback: true, match: {} }),
      ViewerContribution.parse({ id: 'text', label: 'T', priority: 0, match: { mime: ['text/*'] } }),
      ViewerContribution.parse({ id: 'md', label: 'M', priority: 10, match: { ext: ['md'] } }),
    ];
    expect(pickViewerContribution(items, { path: 'a.md', mime: 'text/markdown' })?.id).toBe('md');
    expect(pickViewerContribution(items, { path: 'a.txt', mime: 'text/plain' })?.id).toBe('text');
    expect(pickViewerContribution(items, { path: 'a.bin' })?.id).toBe('card');
    expect(pickViewerContribution(items, { path: 'a', kind: 'folder' })).toBeUndefined();
  });
});

describe('embedded app content route', () => {
  it('knows its own paths', () => {
    expect(REPO_APP_PATH_RE.test('/api/teams/engineering/repo/app/apps/x/index.html')).toBe(true);
    expect(REPO_APP_PATH_RE.test('/api/teams/engineering/repo/blob?path=apps/x/index.html')).toBe(false);
    expect(REPO_APP_PATH_RE.test('/api/teams//repo/app/x')).toBe(false);
    expect(REPO_APP_PATH_RE.test('/x/api/teams/a/repo/app/x')).toBe(false);
  });

  it('answers with the strict policy', () => {
    const h = embeddedAppHeaders();
    expect(h['content-security-policy']).toContain("connect-src 'none'");
    expect(h['content-security-policy']).toContain("default-src 'none'");
    expect(h['x-content-type-options']).toBe('nosniff');
  });
});
