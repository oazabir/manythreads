import { expect, test, type Frame, type Page } from '@playwright/test';
import { openAs } from '../channels/support.ts';

/*
 * PLAN P4-10 and criterion 8, `e2e/files/embedded-app.spec.ts`: an app folder renders in `sandbox="allow-scripts"` (no same-origin)
 * from the content route with the strict CSP. The fixture app probes its own surroundings on load and writes what it found
 * into its page; the spec reads that through the frame while a real session cookie sits on the origin. The route here is the
 * dev server's stand-in (/api/teams/_dev/repo/app/...); the real route's headers are covered by packages/server/test/app-csp.test.ts.
 */

test.skip(({ isMobile }) => isMobile, 'desktop layout');

const APP = '/api/teams/_dev/repo/app/apps/release-checklist/index.html';

/**
 * The fixture app's frame. An `<iframe>` in the DOM has not navigated yet: on a loaded runner the commit of its
 * `src` can land after `page.request.get` answered, so `page.frames()` still holds only `about:blank` and a plain
 * find misses — while the failure's own error snapshot, taken a moment later, shows the app loaded and probed.
 * Take the frame if it is already there, otherwise wait for the navigation; a timeout names the frame URLs seen.
 */
const appFrame = async (page: Page): Promise<Frame> => {
  const atApp = (f: Frame): boolean => f.url().includes(APP);
  const ready = page.frames().find(atApp);
  if (ready) return ready;
  return page.waitForEvent('framenavigated', { predicate: atApp, timeout: 30_000 }).catch((cause: unknown) => {
    throw new Error(
      `the app frame never committed to ${APP} (frames: ${page.frames().map((f) => f.url()).join(', ') || 'none'})`,
      { cause },
    );
  });
};

test('the app is sandboxed, cannot read the session or call /api, and the bridge answers', async ({ browser }) => {
  // signed in as Omar: the session cookie is on this origin, so "cannot read it" means something
  const { page, context } = await openAs(browser, 'omar', '/dev/viewers');
  try {
    const cookies = await context.cookies();
    expect(cookies.some((c) => c.name.includes('session') || c.name.includes('manythreads')), 'a session cookie is present').toBe(true);

    const tile = page.getByTestId('dev-viewer-app');
    const iframe = tile.locator('iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(await iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    await expect(iframe).toHaveAttribute('src', APP);
    await expect(tile.getByTestId('app-badge')).toContainText('Sandboxed app');
    await expect(tile).toContainText('This app cannot read your session or other files.');

    const frame = await appFrame(page);
    // 30 s, not 15: on a loaded CI runner the frame's own load (HTML + __manythreads.js behind a dev server
    // serving 248 parallel tests) can eat most of 15 s even though the probe then completes at once.
    await frame.waitForSelector('html[data-probed="1"]', { timeout: 30_000 });
    const probe = JSON.parse((await frame.locator('#probe').textContent()) ?? '{}') as Record<string, unknown>;

    // criterion 8: document.cookie is not readable (opaque origin: SecurityError), and nothing it holds is the session
    expect(String(probe['cookie'])).toMatch(/^(blocked:SecurityError|empty)$/);
    // a fetch to /api with credentials never reaches the server (connect-src 'none')
    expect(String(probe['fetch'])).toMatch(/^blocked:/);
    // no storage, no access to the page around it
    expect(String(probe['storage'])).toMatch(/^blocked:/);
    expect(String(probe['parent'])).toMatch(/^blocked:/);
    // the bridge: the app's folder and the team's name, nothing else
    expect(probe['bridge']).toEqual({ app: 'apps/release-checklist', team: 'Engineering' });

    // the same checks run by the test itself inside the frame, after load
    expect(await frame.evaluate(() => { try { return document.cookie; } catch (e) { return `blocked:${(e as Error).name}`; } })).toMatch(/^(blocked:SecurityError|)$/);
    expect(await frame.evaluate(() => fetch('/api/session', { credentials: 'include' }).then((r) => `status:${r.status}`, (e: Error) => `blocked:${e.name}`))).toMatch(/^blocked:/);
  } finally {
    await context.close();
  }
});

test('the content route answers with the strict CSP, and only the allowlisted bridge method works', async ({ page }) => {
  await page.goto('/dev/viewers');
  await expect(page.getByTestId('dev-viewer-app').locator('iframe')).toBeAttached();
  const res = await page.request.get(APP);
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  for (const part of ["default-src 'none'", "script-src 'self' 'unsafe-inline'", "connect-src 'none'", "frame-ancestors 'self'", "img-src data: blob: 'self'"]) {
    expect(csp, part).toContain(part);
  }
  expect(res.headers()['x-content-type-options']).toBe('nosniff');

  const frame = await appFrame(page);
  await frame.waitForSelector('html[data-probed="1"]', { timeout: 30_000 });
  // an unknown method is answered with an error, not with data
  const answer = await frame.evaluate(
    () =>
      new Promise<unknown>((resolve) => {
        window.addEventListener('message', (e) => resolve(e.data), { once: true });
        window.parent.postMessage({ channel: 'manythreads.app', id: 'x1', method: 'getSession' }, '*');
      }),
  );
  expect(answer).toMatchObject({ channel: 'manythreads.host', id: 'x1', ok: false });
  expect(JSON.stringify(answer)).not.toContain('Engineering');
});
