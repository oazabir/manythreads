import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserLike } from '../lib/e2e-require.ts';
import { loadChromium } from '../lib/e2e-require.ts';
import { runAxe, summariseAxe } from '../lib/axe.ts';
import { judgeProbe, probePage, type RawProbe } from '../lib/probe.ts';
import {
  checkManifestPictures,
  checkPicture,
  main,
  readReport,
  strictProblems,
  strictReportProblems,
  summariseReport,
  writeReportEntry,
  type ReportEntry,
} from '../precheck.ts';
import { blankPng, busyPng, manifestEntry, tempDir, writePictures } from './support.ts';

describe('picture check', () => {
  it('fails a blank picture, a file that is not a PNG and a cut-off file', () => {
    expect(checkPicture(blankPng()).problem).toMatch(/blank/);
    expect(checkPicture(Buffer.from('not a picture at all, not at all, no it is not')).problem).toMatch(/not a PNG/);
    expect(checkPicture(busyPng().subarray(0, 80)).problem).toBeTruthy();
  });

  it('passes a busy picture', () => {
    expect(checkPicture(busyPng())).toMatchObject({ valid: true, width: 40, height: 40 });
    expect(checkPicture(busyPng()).problem).toBeUndefined();
  });

  it('fails when a manifest picture is blank or missing, and names it', () => {
    const root = tempDir();
    const entries = [manifestEntry('omar', 'desktop', 1), manifestEntry('omar', 'desktop', 2), manifestEntry('omar', 'mobile', 1)];
    writePictures(root, entries);
    writeFileSync(join(root, entries[1]!.file), blankPng());
    mkdirSync(join(root, 'omar'), { recursive: true });
    const { checked, problems } = checkManifestPictures(root, [...entries, manifestEntry('omar', 'desktop', 3)]);
    expect(checked).toBe(3);
    expect(problems).toHaveLength(2);
    expect(problems.some((p) => p.startsWith('omar/02-O1-s2.png') && /blank/.test(p))).toBe(true);
    expect(problems.some((p) => p.startsWith('omar/03-O1-s3.png') && /not there/.test(p))).toBe(true);
  });

  it('exits non-zero on a blank picture from the command', () => {
    const root = tempDir();
    const entries = [manifestEntry('omar', 'desktop', 1)];
    writePictures(root, entries);
    const manifest = join(root, 'omar', 'manifest.desktop.json');
    writeFileSync(manifest, JSON.stringify(entries));
    expect(main(['--root', root, '--report', join(root, 'none.json')])).toBe(0);
    writeFileSync(join(root, entries[0]!.file), blankPng());
    expect(main(['--root', root, '--report', join(root, 'none.json')])).toBe(1);
  });
});

describe('report and strict mode', () => {
  const clean: ReportEntry = { persona: 'omar', journey: 'O1', step: 'a', kind: 'desktop', picture: checkPicture(busyPng()), axe: { violations: [], contrast: 0, labels: 0 }, tokens: { colours: [], radii: [], fonts: [] } };
  const dirty: ReportEntry = {
    ...clean,
    step: 'b',
    axe: { violations: [], contrast: 2, labels: 1 },
    tokens: { colours: [{ value: '#123456', property: 'background-color', count: 3, samples: ['div.x'] }], radii: [], fonts: [] },
  };

  it('reports findings without failing, and fails them only when strict is asked for', () => {
    const file = join(tempDir(), 'review', 'precheck-report.json');
    writeReportEntry(file, 'omar/01-O1-a.png', clean);
    writeReportEntry(file, 'omar/02-O1-b.png', dirty);
    const report = readReport(file);
    expect(summariseReport(report)).toMatchObject({ pictures: 2, contrastViolations: 2, labelViolations: 1, offTokenColours: 1 });
    expect(strictProblems('omar/01-O1-a.png', clean)).toEqual([]);
    const strict = strictReportProblems(report);
    expect(strict).toHaveLength(3);
    expect(strict.join('\n')).toMatch(/#123456/);
    // the command: report only exits 0, --strict exits 1
    const root = tempDir();
    expect(main(['--root', root, '--report', file])).toBe(0);
    expect(main(['--root', root, '--report', file, '--strict'])).toBe(1);
  });

  it('replaces the entry of a picture that is taken again', () => {
    const file = join(tempDir(), 'r.json');
    writeReportEntry(file, 'a.png', dirty);
    writeReportEntry(file, 'a.png', clean);
    expect(Object.keys(readReport(file).entries)).toEqual(['a.png']);
    expect(strictReportProblems(readReport(file))).toEqual([]);
  });

  it('counts a live check that could not run as a strict problem', () => {
    expect(strictProblems('a.png', { ...clean, axeError: 'boom' })[0]).toMatch(/axe-core could not run: boom/);
  });
});

describe('judging what the page used', () => {
  const sighting = (value: string, property?: string) => ({ value, ...(property ? { property } : {}), count: 1, samples: ['div'] });
  const raw = (extra: Partial<RawProbe>): RawProbe => ({ theme: 'light', elements: 1, colours: [], radii: [], fonts: [], ...extra });

  it('accepts token colours, token radii and the token fonts', () => {
    const f = judgeProbe(
      raw({
        colours: [sighting('rgb(27, 36, 48)', 'color'), sighting('rgb(255, 255, 255)', 'background-color'), sighting('rgba(0, 0, 0, 0)', 'background-color'), sighting('rgba(0, 0, 0, 0.05)', 'background-color')],
        radii: [sighting('6'), sighting('10'), sighting('14')],
        fonts: [sighting('inter'), sighting('jetbrains mono')],
      }),
    );
    expect(f).toEqual({ colours: [], radii: [], fonts: [] });
  });

  it('reports a colour, a radius and a font that are not tokens', () => {
    const f = judgeProbe(raw({ colours: [sighting('rgb(18, 52, 86)', 'background-color')], radii: [sighting('4')], fonts: [sighting('comic sans ms')] }));
    expect(f.colours.map((c) => c.value)).toEqual(['#123456']);
    expect(f.radii.map((c) => c.value)).toEqual(['4px']);
    expect(f.fonts.map((c) => c.value)).toEqual(['comic sans ms']);
  });

  it('judges a dark page by the dark palette', () => {
    const lightBlue = sighting('rgb(127, 176, 227)', 'color'); // --human in the dark theme
    expect(judgeProbe(raw({ theme: 'dark', colours: [lightBlue] })).colours).toEqual([]);
    expect(judgeProbe(raw({ theme: 'light', colours: [lightBlue] })).colours).toHaveLength(1);
  });
});

describe('in a real page', () => {
  let browser: BrowserLike;
  beforeAll(async () => {
    browser = await loadChromium().launch({ headless: true });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  const fixture = (body: string, theme = ''): string =>
    `<!doctype html><html lang="en" ${theme}><head><title>fixture</title><style>
      :root{--surface:#FFFFFF;--ink:#1B2430;--radius-md:10px}
      body{margin:0;background:var(--surface);color:var(--ink);font-family:"Inter",system-ui,sans-serif}
      .ok{background:#EEF3F8;border-radius:10px;padding:8px}
      .bad{background:#123456;color:#FEDCBA;border-radius:4px;padding:8px;font-family:"Comic Sans MS",cursive}
    </style></head><body><main>${body}</main></body></html>`;

  it('reports an injected off-token colour, radius and font, and nothing for a token-only page', async () => {
    const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
    await page.setContent(fixture('<div class="ok">On tokens</div>'));
    const clean = judgeProbe(await probePage(page));
    expect(clean.colours).toEqual([]);
    expect(clean.radii).toEqual([]);
    await page.setContent(fixture('<div class="ok">On tokens</div><div class="bad" data-testid="injected">Off tokens</div>'));
    const found = judgeProbe(await probePage(page));
    expect(found.colours.map((c) => c.value).sort()).toEqual(['#123456', '#FEDCBA']);
    expect(found.colours[0]!.samples.join()).toContain('injected');
    expect(found.radii.map((r) => r.value)).toEqual(['4px']);
    expect(found.fonts.map((f) => f.value)).toEqual(['comic sans ms']);
    await page.close();
  }, 60_000);

  it('finds low contrast and a control with no name with axe-core', async () => {
    const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    const page = await context.newPage();
    await page.setContent(fixture('<p style="color:#9AA0A6">Grey on white</p><button></button>'));
    const axe = await runAxe(page as never);
    expect(axe.contrast).toBeGreaterThanOrEqual(1);
    expect(axe.labels).toBeGreaterThanOrEqual(1);
    await page.setContent(fixture('<p>Dark on white</p><button>Send</button>'));
    const calm = await runAxe(page as never);
    expect(calm.contrast).toBe(0);
    expect(calm.labels).toBe(0);
    await context.close();
  }, 60_000);

  it('summarises axe violations by rule', () => {
    const s = summariseAxe([
      { id: 'color-contrast', impact: 'serious', help: 'x', nodes: [{ target: ['p'] }, { target: ['span'] }] },
      { id: 'button-name', impact: 'critical', help: 'y', nodes: [{ target: ['button'] }] },
      { id: 'region', impact: 'moderate', help: 'z', nodes: [{ target: ['div'] }] },
    ]);
    expect(s).toMatchObject({ contrast: 2, labels: 1 });
    expect(s.violations).toHaveLength(3);
  });
});
