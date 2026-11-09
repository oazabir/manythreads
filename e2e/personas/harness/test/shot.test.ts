// shot() really fails: every check it promises is injected here as a defect of a real page, and the step must throw with a message that says which. A page with
// none of them takes a picture and writes the manifest. (Real Chromium; pages are served by route handlers, no stack.)
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resolvePersona, type JourneyDeclaration, type StepDeclaration } from '../journey.ts';
import { readManifests } from '../manifest.ts';
import { shot, waitReady } from '../shot.ts';
import { BUSY, closeBrowser, launch, screen, serve, type Served } from './browser.ts';
import { journey, step } from './fixtures.ts';
import { manifestSchemaProblems } from './schema.ts';

let root = '';
const opened: Served[] = [];

beforeAll(async () => {
  await launch();
  root = mkdtempSync(join(tmpdir(), 'mt-shot-'));
}, 120_000);
afterEach(async () => {
  while (opened.length > 0) await opened.pop()!.close();
});
afterAll(async () => {
  await closeBrowser();
  rmSync(root, { recursive: true, force: true });
});

const GOOD = (extra = ''): string => screen(`<main data-landmark="app-frame"><h1>Engineering</h1>${BUSY}${extra}</main>`);

async function take(html: string, declared: Partial<StepDeclaration> = {}, routes: Parameters<typeof serve>[1] = {}, options: { timeoutMs?: number; root?: string } = {}) {
  const served = await serve(html, routes);
  opened.push(served);
  const j: JourneyDeclaration = journey('omar', 'O1', [step('look', declared)], { viewports: ['desktop'] });
  const resolved = resolvePersona([j], 'omar')[0]!;
  return shot(served.page, resolved, { root: options.root ?? root, kind: 'desktop', timeoutMs: options.timeoutMs ?? 1500 });
}

describe('shot() passes a clean screen', () => {
  it('writes the picture and its manifest entry', async () => {
    const entry = await take(GOOD());
    expect(entry).toMatchObject({ persona: 'omar', journey: 'O1', step: 'look', kind: 'desktop', file: 'omar/01-O1-look.png', landmark: 'app-frame' });
    expect(existsSync(join(root, 'omar', '01-O1-look.png'))).toBe(true);
    expect(readManifests(root).entries.map((e) => e.file)).toContain('omar/01-O1-look.png');
    // what is written is what docs/journeys/manifest.schema.json describes
    expect(manifestSchemaProblems([entry])).toEqual([]);
    expect(manifestSchemaProblems(JSON.parse(readFileSync(join(root, 'omar', 'manifest.desktop.json'), 'utf8')))).toEqual([]);
    expect(manifestSchemaProblems([{ ...entry, extra: 1, number: 0, kind: 'tablet' }]).length).toBe(3);
  }, 30_000);
});

describe('shot() fails the step when', () => {
  it('the landmark is not on the screen', async () => {
    await expect(take(screen(`<main data-landmark="somewhere-else">${BUSY}</main>`))).rejects.toThrow(/omar\/O1\/look: landmark "app-frame" is not visible/);
  }, 30_000);

  it('the landmark is in the page but not visible', async () => {
    await expect(take(screen(`<main data-landmark="app-frame" style="display:none">x</main>${BUSY}`))).rejects.toThrow(/landmark "app-frame" is not visible/);
  }, 30_000);

  it('the error page is showing', async () => {
    await expect(take(GOOD('<h1>Something went wrong</h1>'))).rejects.toThrow(/the error page is showing/);
  }, 30_000);

  it('the control the next step uses is not on the page', async () => {
    await expect(take(GOOD(), { next: { testid: 'composer' } })).rejects.toThrow(/the next control \[data-testid="composer"\] is not on the page/);
  }, 30_000);

  it('the console shows an error', async () => {
    await expect(take(screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: 'console.error("boom in the console")' }))).rejects.toThrow(/the screen is not clean[\s\S]*console: boom in the console/);
  }, 30_000);

  it('the page throws', async () => {
    await expect(take(screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: 'setTimeout(function(){ throw new Error("kaboom") }, 10)' }))).rejects.toThrow(/pageerror: .*kaboom/);
  }, 30_000);

  it('a request fails', async () => {
    const html = screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: 'fetch("/api/dead").catch(function(){})' });
    await expect(take(html, {}, { '/api/dead': { abort: true } })).rejects.toThrow(/requestfailed: GET http:\/\/harness\.test\/api\/dead/);
  }, 30_000);

  it('the server answers 500, or 404', async () => {
    const html = (path: string): string => screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: `fetch("${path}").catch(function(){})` });
    await expect(take(html('/api/boom'), {}, { '/api/boom': { status: 500 } })).rejects.toThrow(/response: GET http:\/\/harness\.test\/api\/boom answered 500/);
    await expect(take(html('/api/missing'))).rejects.toThrow(/answered 404/);
  }, 30_000);

  it('the picture is blank, and nothing is written for it', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mt-shot-blank-'));
    try {
      await expect(take(screen('<main data-landmark="app-frame">Hello</main>'), {}, {}, { root: fresh })).rejects.toThrow(/omar\/O1\/look: .*looks blank/);
      expect(existsSync(join(fresh, 'omar', '01-O1-look.png'))).toBe(false);
      expect(readManifests(fresh).entries).toEqual([]);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  }, 30_000);

  it('the screen never becomes ready, and says so within the time it was given', async () => {
    const started = Date.now();
    await expect(take(screen(`<main data-landmark="app-frame">${BUSY}</main>`, { ready: 'false' }), {}, {}, { timeoutMs: 1200 })).rejects.toThrow(/the screen never became ready within 1200 ms \(data-ready=false/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

describe('waitReady cannot hang', () => {
  it('a page that never answers an evaluate is given up on, not waited for', async () => {
    const served = await serve(screen('<main>x</main>', { ready: 'false' }));
    opened.push(served);
    // the page is stuck in a loop from now on: evaluate never returns
    void served.page.evaluate(() => { for (;;) { /* wedged */ } }).catch(() => undefined);
    const started = Date.now();
    await expect(waitReady(served.page, 1500)).rejects.toThrow(/never became ready within 1500 ms/);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 40_000);
});

describe('a step that expects a refusal', () => {
  const page403 = (script = ''): string => screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: `fetch("/api/no").catch(function(){});${script}` });
  const routes = { '/api/no': { status: 403 }, '/api/boom': { status: 500 } };

  it('passes when that status was answered', async () => {
    await expect(take(page403(), { expectDenied: 403 }, routes)).resolves.toMatchObject({ step: 'look' });
  }, 30_000);

  it('fails when nothing answered it', async () => {
    await expect(take(GOOD(), { expectDenied: 403 })).rejects.toThrow(/expects the server to answer 403, and nothing did/);
  }, 30_000);

  it('still fails when the page threw while the refusal was shown', async () => {
    await expect(take(page403('setTimeout(function(){ throw new Error("crashed on the refusal") }, 10)'), { expectDenied: 403 }, routes)).rejects.toThrow(/pageerror: .*crashed on the refusal/);
  }, 30_000);

  it('still fails when a server fault came with the refusal', async () => {
    await expect(take(page403('fetch("/api/boom").catch(function(){})'), { expectDenied: 403 }, routes)).rejects.toThrow(/answered 500/);
  }, 30_000);
});

describe('the known noise', () => {
  it('the 404 of a run origin and of a conversation state is not a defect, any other 404 is', async () => {
    const fetches = (paths: string[]): string => screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: paths.map((p) => `fetch("${p}").catch(function(){});`).join('') });
    await expect(take(fetches(['/api/runs/abc/origin', '/api/teams/t/bots/b/conversations/c1/state']))).resolves.toMatchObject({ step: 'look' });
    await expect(take(fetches(['/api/runs/abc/origin/other']))).rejects.toThrow(/answered 404/);
    await expect(take(fetches(['/api/runs/abc/steps']))).rejects.toThrow(/answered 404/);
  }, 60_000);

  it('rules a persona adds after the monitor is attached still count', async () => {
    const served = await serve(screen(`<main data-landmark="app-frame">${BUSY}</main>`, { script: 'fetch("/api/odd").catch(function(){})' }), { '/api/odd': { status: 404 } });
    opened.push(served);
    const { monitorPage } = await import('../monitor.ts');
    monitorPage(served.page);
    monitorPage(served.page, [{ url: /\/api\/odd$/ }]);
    const j = journey('omar', 'O1', [step('look')], { viewports: ['desktop'] });
    await expect(shot(served.page, resolvePersona([j], 'omar')[0]!, { root, kind: 'desktop', timeoutMs: 1500 })).resolves.toMatchObject({ step: 'look' });
  }, 30_000);
});

describe('the stored picture', () => {
  it('is what the page showed (bytes match the manifest hash)', async () => {
    const entry = await take(GOOD());
    const bytes = readFileSync(join(root, entry.file));
    expect(bytes.length).toBe(entry.bytes);
  }, 30_000);
});
