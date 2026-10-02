import { describe, expect, it } from 'vitest';
import { createViewerRegistry, viewerRegistry } from '../src/kernel/viewers';
import '../src/viewers/builtins';
import { frontmatterKeys, isGoogleHost, parseGoogleLink, splitFrontmatter } from '../src/viewers/frontmatter';
import { mimeForPath } from '../src/viewers/mime';
import { memorySource } from '../src/viewers/source';

const pick = (path: string, extra: { mime?: string; kind?: 'file' | 'folder'; entries?: string[]; frontmatterKeys?: string[] } = {}) =>
  viewerRegistry.pick({ path, mime: extra.mime ?? mimeForPath(path), ...extra })?.id;

describe('viewer selection (provider.viewer registry)', () => {
  it('opens each kind of file with its viewer', () => {
    const table: Record<string, string> = {
      'pages/reports/week-37.md': 'markdown',
      'pages/reports/signups.csv': 'csv',
      'pages/reports/export.tsv': 'csv',
      'pages/handbook.pdf': 'pdf',
      'channels/dev/shot.png': 'image',
      'channels/dev/photo.JPG': 'image',
      'channels/dev/logo.svg': 'image',
      'channels/dev/demo.mp4': 'video',
      'channels/dev/demo.webm': 'video',
      'channels/dev/call.wav': 'audio',
      'channels/dev/call.mp3': 'audio',
      'src/index.ts': 'code',
      'config/app.yaml': 'code',
      'README.txt': 'code',
      'pages/architecture.mmd': 'mermaid',
      'channels/dev/report.docx': 'office',
      'channels/dev/model.xlsx': 'office',
      'channels/dev/deck.pptx': 'office',
      'channels/dev/archive.zip': 'download',
      'channels/dev/blob': 'download',
    };
    for (const [path, id] of Object.entries(table)) expect(pick(path), path).toBe(id);
  });

  it('prefers the store mime type over the extension for the family, and the viewer priority over the generic text viewer', () => {
    expect(pick('notes', { mime: 'text/markdown' })).toBe('markdown');
    expect(pick('data', { mime: 'text/csv' })).toBe('csv');
    expect(pick('thing', { mime: 'image/webp' })).toBe('image');
    expect(pick('thing', { mime: 'text/x-unknown' })).toBe('code');
    expect(pick('thing', { mime: 'application/pdf; charset=binary' })).toBe('pdf');
    expect(pick('thing', { mime: 'application/octet-stream' })).toBe('download');
  });

  it('a page with google: frontmatter is a link card, any other page is the editor', () => {
    expect(pick('pages/plan.md', { frontmatterKeys: ['google'] })).toBe('google-link');
    expect(pick('pages/plan.md', { frontmatterKeys: ['title'] })).toBe('markdown');
    expect(pick('pages/plan.md')).toBe('markdown');
  });

  it('a folder with index.html and no index.md is an embedded app; with index.md it is not', () => {
    expect(pick('apps/release-checklist', { kind: 'folder', entries: ['index.html', 'app.js'] })).toBe('app');
    expect(pick('apps/x', { kind: 'folder', entries: ['index.html', 'index.md'] })).toBeUndefined();
    expect(pick('apps/x', { kind: 'folder', entries: ['readme.txt'] })).toBeUndefined();
    // a file named like an app folder is not an app
    expect(pick('apps/index.html')).toBe('code');
  });

  it('a later registration of an id replaces it, and the higher priority wins', () => {
    const reg = createViewerRegistry();
    const load = () => Promise.resolve({ default: () => null });
    reg.register({ id: 'plain', label: 'Plain', priority: 0, match: { ext: ['md'] }, load });
    reg.register({ id: 'fancy', label: 'Fancy', priority: 5, match: { ext: ['md'] }, load });
    expect(reg.pick({ path: 'a.md' })?.id).toBe('fancy');
    reg.register({ id: 'plain', label: 'Plain 2', priority: 9, match: { ext: ['md'] }, load });
    expect(reg.pick({ path: 'a.md' })?.label).toBe('Plain 2');
    expect(reg.list()).toHaveLength(2);
    // equal priority: the later registration wins
    reg.register({ id: 'late', label: 'Late', priority: 9, match: { ext: ['md'] }, load });
    expect(reg.pick({ path: 'a.md' })?.id).toBe('late');
  });

  it('keeps one lazy component per viewer', () => {
    const def = viewerRegistry.get('csv');
    expect(def).toBeDefined();
    if (!def) return;
    expect(viewerRegistry.component(def)).toBe(viewerRegistry.component(def));
  });

  it('every built-in viewer loads lazily (nothing is imported until it is opened)', () => {
    for (const def of viewerRegistry.list()) expect(typeof def.load, def.id).toBe('function');
  });
});

describe('frontmatter', () => {
  const text = '---\ngoogle:\n  kind: sheet\n  title: "Q3 numbers"\n  url: https://docs.google.com/spreadsheets/d/abc/edit\ntags: [a]\n---\n\nBody\n';

  it('splits the block off without changing a byte', () => {
    const { frontmatter, body } = splitFrontmatter(text);
    expect(frontmatter + body).toBe(text);
    expect(body).toBe('\nBody\n');
    expect(splitFrontmatter('# no block\n').frontmatter).toBe('');
    expect(splitFrontmatter('---\nnever closed\n').frontmatter).toBe('');
  });

  it('lists top-level keys only', () => {
    expect(frontmatterKeys(splitFrontmatter(text).frontmatter)).toEqual(['google', 'tags']);
  });

  it('reads the google block and refuses anything that is not a https Google address', () => {
    const link = parseGoogleLink(splitFrontmatter(text).frontmatter);
    expect(link).toEqual({ url: 'https://docs.google.com/spreadsheets/d/abc/edit', title: 'Q3 numbers', kind: 'sheet' });
    expect(parseGoogleLink('---\ngoogle: https://drive.google.com/file/d/1/view\n---\n')?.url).toBe('https://drive.google.com/file/d/1/view');
    expect(parseGoogleLink('---\ngoogle:\n  url: javascript:alert(1)\n---\n')).toBeNull();
    expect(parseGoogleLink('---\ngoogle:\n  url: http://docs.google.com/x\n---\n')).toBeNull();
    expect(isGoogleHost('https://evil.example/docs.google.com')).toBe(false);
    expect(isGoogleHost('https://docs.google.com.evil.example/x')).toBe(false);
    expect(isGoogleHost('https://docs.google.com/x')).toBe(true);
  });
});

describe('content sources', () => {
  it('a memory source gives the same content as text and as bytes', async () => {
    const s = memorySource({ text: 'héllo' });
    expect(await s.text()).toBe('héllo');
    expect(new TextDecoder().decode(await s.bytes())).toBe('héllo');
  });
});
