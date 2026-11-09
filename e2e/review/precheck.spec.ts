// Pre-checks on the screenshots (PLAN P13-02, block 4 "e2e/review/precheck.spec.ts", decision E36).
//   - Every picture the manifests list is a valid PNG with more than 200 distinct colours (always a failure).
//   - Every picture has an entry in review/precheck-report.json (the screenshot hook ran for it).
//   - axe-core contrast and label violations and off-token colours, radii and fonts are REPORTED (test annotations); they fail the run only with
//     MANYTHREADS_PRECHECK_STRICT=1 (P13-10 turns that on in CI).
// The first group needs no output: it takes a real page and a real screenshot and proves the hook itself.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { readManifests, journeysRoot } from '../personas/harness/manifest.ts';
import type { ShotEvent } from '../personas/harness/shot.ts';
import { precheckShot, default as shotHook } from '../../tools/review/hook.ts';
import { checkPicture, isStrict, readReport, reportPath, strictProblems, summariseReport } from '../../tools/review/precheck.ts';

const FIXTURE = (body: string): string => `<!doctype html><html lang="en"><head><title>fixture</title><style>
  body{margin:0;background:#FFFFFF;color:#1B2430;font-family:"Inter",system-ui,sans-serif}
  main{padding:24px;display:grid;gap:12px}
  .card{background:#EEF3F8;border:1px solid #B9CBDD;border-radius:10px;padding:12px}
  .off{background:#123456;color:#FEDCBA;border-radius:4px;padding:12px}
  .grey{color:#9AA0A6}
  button{border:0;font:inherit;background:#EEF3F8;color:#1B2430}
</style></head><body><main>${body}</main></body></html>`;

/** Enough different colours to be a screen and not a blank page: a gradient is an image, so the colour probe does not count it. */
const BUSY = '<div style="height:160px;background:linear-gradient(90deg,#FF0000,#00FF00,#0000FF,#FF00FF,#FFFF00)"></div>';

function shotEvent(page: ShotEvent['page'], png: Buffer, step: string): ShotEvent {
  return {
    page,
    png,
    file: `/tmp/${step}.png`,
    step: { persona: 'omar', journeyId: 'O1', id: step, number: 1, expect: 'app-frame', composer: false, loading: false, mask: [], next: undefined, plate: undefined, expectDenied: undefined, pending: undefined },
    entry: {
      persona: 'omar',
      journey: 'O1',
      step,
      kind: 'desktop',
      viewport: { width: 1440, height: 900 },
      url: '/fixture',
      landmark: 'app-frame',
      number: 1,
      file: `omar/01-O1-${step}.png`,
      sha256: 'x',
      bytes: png.length,
      time: new Date().toISOString(),
    },
  };
}

test.describe('the screenshot hook on a fixture page', () => {
  test('a blank page fails the pre-check', async ({ page }, info) => {
    const report = join(info.outputPath('report'), 'r.json');
    await page.setContent(FIXTURE(''));
    const png = await page.screenshot();
    await expect(precheckShot(shotEvent(page, png, 'blank'), { report })).rejects.toThrow(/blank/);
    expect(readReport(report).entries['omar/01-O1-blank.png']?.picture.problem).toMatch(/blank/);
  });

  test('an off-token colour, radius and font are reported, and fail only in strict mode', async ({ page }, info) => {
    const report = join(info.outputPath('report'), 'r.json');
    await page.setContent(FIXTURE(`<div class="card">On tokens</div><div class="off" data-testid="injected" style="font-family:'Comic Sans MS',cursive">Off tokens</div>${BUSY}`));
    const png = await page.screenshot();
    const entry = await precheckShot(shotEvent(page, png, 'offtoken'), { report });
    expect(entry.picture.problem).toBeUndefined();
    expect(entry.tokens?.colours.map((c) => c.value).sort()).toEqual(expect.arrayContaining(['#123456', '#FEDCBA']));
    expect(entry.tokens?.radii.map((r) => r.value)).toContain('4px');
    expect(entry.tokens?.fonts.map((f) => f.value)).toContain('comic sans ms');
    expect(readReport(report).entries['omar/01-O1-offtoken.png']?.tokens?.colours.length).toBeGreaterThan(0);
    await expect(precheckShot(shotEvent(page, png, 'offtoken'), { report, strict: true })).rejects.toThrow(/strict/);
  });

  test('low contrast and a nameless button are reported by axe-core', async ({ page }, info) => {
    const report = join(info.outputPath('report'), 'r.json');
    await page.setContent(FIXTURE(`<p class="grey">Grey on white</p><button></button>${BUSY}`));
    const png = await page.screenshot();
    const entry = await precheckShot(shotEvent(page, png, 'axe'), { report });
    expect(entry.axe?.contrast).toBeGreaterThanOrEqual(1);
    expect(entry.axe?.labels).toBeGreaterThanOrEqual(1);
  });

  test('a page on the tokens with readable text is clean, and the registered hook accepts it', async ({ page }, info) => {
    const report = join(info.outputPath('report'), 'r.json');
    await page.setContent(FIXTURE(`<div class="card"><p>Dark text on a light card.</p><button>Send</button></div>${BUSY}`));
    const png = await page.screenshot();
    const entry = await precheckShot(shotEvent(page, png, 'clean'), { report, strict: true });
    expect(strictProblems('x', entry)).toEqual([]);
    expect(typeof shotHook).toBe('function');
  });
});

const root = journeysRoot();
const { entries } = readManifests(root);
const strict = isStrict();

test.describe('the pictures of the last persona run', () => {
  test.skip(entries.length === 0, `no manifest below ${root}: run a persona project first (see the header of this file)`);

  test('every picture is a valid PNG with more than 200 distinct colours', () => {
    const problems: string[] = [];
    for (const e of entries) {
      if (e.kind === 'native') continue;
      const file = join(root, e.file);
      if (!existsSync(file)) problems.push(`${e.file}: not on disk`);
      else {
        const check = checkPicture(readFileSync(file));
        if (check.problem) problems.push(`${e.file}: ${check.problem}`);
      }
    }
    expect(problems).toEqual([]);
  });

  test('every picture has a pre-check entry, with axe-core and the style probe run', () => {
    const report = readReport(reportPath());
    const missing = entries.filter((e) => e.kind !== 'native' && !report.entries[e.file]).map((e) => e.file);
    expect(missing, 'run the persona project with MANYTHREADS_PERSONAS_ONSHOT=<repo>/tools/review/hook.ts').toEqual([]);
    const broken = Object.entries(report.entries).filter(([, r]) => r.axeError || r.tokensError).map(([k, r]) => `${k}: ${r.axeError ?? r.tokensError}`);
    expect(broken).toEqual([]);
  });

  test(`axe-core contrast is zero and computed styles use tokens (${strict ? 'strict: fails' : 'report only'})`, () => {
    const report = readReport(reportPath());
    const s = summariseReport(report);
    test.info().annotations.push({
      type: 'pre-check report',
      description: `${s.pictures} pictures: ${s.contrastViolations} contrast, ${s.labelViolations} label, ${s.offTokenColours} colour, ${s.offTokenRadii} radius, ${s.offTokenFonts} font finding(s)`,
    });
    console.log(`pre-check report: ${JSON.stringify(s)}`);
    if (strict) {
      const problems = Object.entries(report.entries).flatMap(([k, r]) => strictProblems(k, r));
      expect(problems).toEqual([]);
    }
  });
});
