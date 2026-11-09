// shot(page, step): the one way a persona journey takes a picture (PLAN P12-01, Bundle E decisions E31, E34).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { VIEWPORTS, stepRelativePath, type ResolvedStep } from './journey.ts';
import { appendManifest, journeysRoot, sha256, type ManifestEntry } from './manifest.ts';
import { judge, monitorPage } from './monitor.ts';
import { pictureProblem } from './png.ts';

export interface ShotOptions {
  /** Which viewport this picture is for (default: from the page's viewport: 390 px wide or less is `mobile`). */
  kind?: 'desktop' | 'mobile';
  /** Where the journeys folder is (default: `journeysRoot()`). */
  root?: string;
  /** Time to wait for the landmark and for `data-ready`. */
  timeoutMs?: number;
}

export interface ShotEvent {
  page: Page;
  step: ResolvedStep;
  entry: ManifestEntry;
  /** Absolute path of the picture just written. */
  file: string;
  /** The picture itself. */
  png: Buffer;
}

/** A callback that runs after a picture is written and its manifest entry is saved. A throw fails the step. */
export type ShotHook = (event: ShotEvent) => void | Promise<void>;

const hooks: ShotHook[] = [];
let envHookLoaded = false;

/**
 * Registers a callback for every picture (P13-02: the pre-checks run axe-core on the live page at the same step and look at the picture; P13-03 builds contact
 * sheets from the manifest). Returns a function that removes it. A module named by `MANYTHREADS_PERSONAS_ONSHOT` is also loaded once per worker, and its default
 * export is registered, so a tool can hook in without editing a spec.
 */
export function onShot(hook: ShotHook): () => void {
  hooks.push(hook);
  return () => {
    const i = hooks.indexOf(hook);
    if (i >= 0) hooks.splice(i, 1);
  };
}

async function loadEnvHook(): Promise<void> {
  if (envHookLoaded) return;
  envHookLoaded = true;
  const module = process.env['MANYTHREADS_PERSONAS_ONSHOT'];
  if (!module) return;
  const loaded = (await import(module.startsWith('/') ? `file://${module}` : module)) as { default?: ShotHook };
  if (typeof loaded.default !== 'function') throw new Error(`MANYTHREADS_PERSONAS_ONSHOT=${module}: the module must default-export a function (event) => void`);
  hooks.push(loaded.default);
}

const quote = (value: string): string => JSON.stringify(value);

/** The element that proves the screen: `data-landmark` or `data-testid` with this value. */
export function landmarkLocator(page: Page, landmark: string) {
  return page.locator(`[data-landmark=${quote(landmark)}],[data-testid=${quote(landmark)}]`).first();
}

/** Answers `fallback` when `work` has not finished in `ms`: a page stuck in a script loop never answers `evaluate`, and the wait for it must not wait forever too. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work.catch(() => fallback), late]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Waits for `data-ready="true"` on <html> (clients/web/src/api/ready.ts), seen twice 60 ms apart so the gap between two requests does not count. A page that
 * has asked the API nothing never gets the attribute: after 4 s the harness falls back to the network going quiet. It cannot hang: after `timeoutMs` it throws
 * (`the screen never became ready ...`), and each read of the page gives up after 5 s (a page stuck in a script loop does not answer).
 */
export async function waitReady(page: Page, timeoutMs: number): Promise<void> {
  const read = (): Promise<string | null | 'unreadable'> =>
    within(page.evaluate(() => document.documentElement.getAttribute('data-ready')), 5_000, 'unreadable');
  const fontsReady = (): Promise<unknown> => within(page.evaluate(() => document.fonts.ready.then(() => true)), 5_000, false);
  const start = Date.now();
  await page.waitForTimeout(150);
  while (Date.now() - start < timeoutMs) {
    const state = await read();
    if (state === 'true') {
      await page.waitForTimeout(60);
      if ((await read()) === 'true') {
        await fontsReady();
        return;
      }
    } else if (state === null && Date.now() - start > 4000) {
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      await fontsReady();
      return;
    }
    await page.waitForTimeout(100);
  }
  const now = await within(
    page.evaluate(() => ({ ready: document.documentElement.getAttribute('data-ready'), busy: document.querySelectorAll('[aria-busy="true"]').length })),
    5_000,
    { ready: 'unreadable', busy: -1 },
  );
  throw new Error(`the screen never became ready within ${timeoutMs} ms (data-ready=${String(now.ready)}, ${now.busy} element(s) still aria-busy)`);
}

/**
 * Runs one Playwright assertion and, when it fails, throws `message` (which names the step) followed by what the assertion saw. The message is added here and not
 * passed to `expect`: outside the Playwright test runner `expect` leaves a custom message out of the error, and the step must be named wherever the harness runs.
 */
async function must(message: string, assertion: () => Promise<unknown>): Promise<void> {
  try {
    await assertion();
  } catch (e) {
    const seen = (e instanceof Error ? e.message : String(e)).split('Call log:')[0]!.trim().split('\n').filter((l) => l.trim() !== '').slice(0, 6).join('\n  ');
    throw new Error(`${message}\n  ${seen}`);
  }
}

/** The viewport kind of a page. */
function kindOf(page: Page, given?: 'desktop' | 'mobile'): 'desktop' | 'mobile' {
  if (given) return given;
  const size = page.viewportSize();
  return size && size.width <= VIEWPORTS.mobile.width ? 'mobile' : 'desktop';
}

/**
 * Checks the screen, waits for it to finish loading, and writes `docs/journeys/<persona>/[mobile/]NN-<journey>-<step>.png`, then adds a manifest entry.
 *
 * It fails the step when: the landmark is not visible; the "Something went wrong" page is up; the control the next step uses is not on the page; the console
 * shows an error, the page throws, a request fails or the server answers 4xx/5xx (unless the step has `expectDenied`: then this status must have been answered
 * and the other checks are relaxed for this step only); the screen never becomes `data-ready`; or the picture is blank.
 */
export async function shot(page: Page, step: ResolvedStep, options: ShotOptions = {}): Promise<ManifestEntry> {
  if (step.pending !== undefined) throw new Error(`shot() was called for ${step.persona}/${step.journeyId}/${step.id}, which is pending (${step.pending})`);
  await loadEnvHook();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const monitor = monitorPage(page);
  const where = `${step.persona}/${step.journeyId}/${step.id}`;
  // 1. the screen is the one the step declared
  await must(`${where}: landmark "${step.expect}" is not visible at ${page.url()}`, () => expect(landmarkLocator(page, step.expect)).toBeVisible({ timeout: timeoutMs }));
  // 2. no error page
  await must(`${where}: the error page is showing`, () => expect(page.getByRole('heading', { name: 'Something went wrong' })).toHaveCount(0));
  // 3. the control the next step will use is there
  if (step.next && !step.next.unchecked) {
    const testid = step.next.testid;
    await must(`${where}: the next control [data-testid="${testid}"] is not on the page`, () => expect(page.locator(`[data-testid=${quote(testid)}]`).first()).toBeAttached({ timeout: 5_000 }));
  }
  // 4. finished loading
  if (!step.loading) await waitReady(page, timeoutMs);
  // 5. nothing went wrong while it loaded
  const problems = judge(monitor.take(), step.expectDenied);
  if (problems.length > 0) throw new Error(`${where}: the screen is not clean:\n- ${problems.slice(0, 6).join('\n- ')}`);
  // 6. the picture
  const kind = kindOf(page, options.kind);
  const root = options.root ?? journeysRoot();
  const rel = stepRelativePath(step, kind);
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  const masks = ['[data-vt-mask]', 'time', ...step.mask].map((s) => page.locator(s));
  const png = await page.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css', mask: masks });
  const blank = pictureProblem(png);
  if (blank) throw new Error(`${where}: ${blank}`);
  writeFileSync(file, png);
  const size = page.viewportSize() ?? VIEWPORTS[kind];
  const url = new URL(page.url());
  const entry: ManifestEntry = {
    persona: step.persona,
    journey: step.journeyId,
    step: step.id,
    kind,
    viewport: { width: size.width, height: size.height },
    url: `${url.pathname}${url.search}`,
    landmark: step.expect,
    number: step.number,
    file: rel,
    sha256: sha256(png),
    bytes: png.length,
    time: new Date().toISOString(),
  };
  appendManifest(root, entry);
  for (const hook of [...hooks]) await hook({ page, step, entry, file, png });
  return entry;
}
