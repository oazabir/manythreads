import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { channelsOf } from '../support/stack-browser.ts';
import { STACK_ENV, apiOn, openFiles, row } from './support.ts';

/*
 * PLAN P4 section 4, `e2e/files/viewers.spec.ts` second half, through the Files screen: every kind of file in the seed opens in the right panel in its
 * own viewer (PDF, PNG, MP4, Office, Mermaid, CSV, an app folder), nothing logs a console error, and an attachment shows what it is (path, who, where).
 * The viewers themselves are checked on their fixtures in `viewers.spec.ts`.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');

let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  // the PDF of the seed is a placeholder of 711 bytes; a real three-page one is posted to #dev beside it
  const api = await apiOn(playwright, stack, 'nadia');
  const dev = (await channelsOf(api))['dev'];
  const res = await api.ctx.post(`/api/channels/${dev}/files`, {
    headers: { ...(await api.headers()), 'content-type': 'application/pdf', 'x-file-name': 'handbook.pdf' },
    data: readFileSync(fileURLToPath(new URL('../fixtures/files/sample.pdf', import.meta.url))),
  });
  expect(res.status()).toBe(201);
  await api.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    // the embedded app probes its own sandbox on load: its refused fetch is the CSP doing its job
    if (m.type() === 'error' && !m.location().url.includes('/repo/app/')) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

test('attachments of #dev open in their viewers from the list', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=channels/dev');
  const problems = watch(page);
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    // the PNG: a loaded image, and the details of an attachment
    await row(page, 'channels/dev/latency-before-after.png').click();
    const img = panel.locator('img.media-img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    const details = panel.getByTestId('file-details');
    await expect(details).toContainText('channels/dev/latency-before-after.png');
    await expect(details).toContainText('Rafi');
    await expect(details).toContainText('# dev');
    await expect(panel.getByTestId('panel-title')).toHaveText('latency-before-after.png');

    // the MP4: a media element with a source
    await row(page, 'channels/dev/canary-rollout.mp4').click();
    await expect(panel.locator('video')).toHaveAttribute('src', /\/api\/files\/.+\/content/);

    // the PDF: pdf.js draws page 1
    await row(page, 'channels/dev/handbook.pdf').click();
    await expect(panel.getByTestId('pdf-page')).toHaveText('1/3');
    await expect(panel.getByTestId('pdf-canvas')).toHaveAttribute('data-rendered', '1');

    // the Office file: no worker in this stack, so a download card with the file's name
    await row(page, 'channels/dev/release-notes-v2.14.docx').click();
    await expect(panel.getByTestId('file-viewer')).toHaveAttribute('data-viewer', 'office');
    await expect(panel).toContainText('release-notes-v2.14.docx');
    await expect(panel.getByRole('link', { name: 'Download' }).first()).toHaveAttribute('href', /\/api\/files\/.+\/content/);
  } finally {
    await close();
  }
  expect(problems).toEqual([]);
});

test('a diagram, a CSV, a page and a Google link card open from pages/', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=pages/diagrams');
  const problems = watch(page);
  const panel = page.locator('[data-landmark="right-panel"]');
  try {
    await row(page, 'pages/diagrams/dispatch.mmd').click();
    await expect(panel.getByTestId('viewer-mermaid')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await page.goto(`${stack.origin}/t/engineering/files?path=pages&panel=file:pages/q3-planning-notes.md`);
    await expect(panel.getByTestId('viewer-google')).toBeVisible();
    await page.goto(`${stack.origin}/t/engineering/files?path=pages/reports&panel=file:pages/reports/signups.csv`);
    await expect(panel.getByTestId('viewer-csv')).toBeVisible();
  } finally {
    await close();
  }
  expect(problems).toEqual([]);
});

test('an app folder says so and opens as a sandboxed app', async ({ browser, playwright }) => {
  const { page, close } = await openFiles(browser, playwright, stack, 'nadia', '?path=apps/release-checklist');
  const problems = watch(page);
  try {
    await expect(page.getByTestId('app-note')).toContainText('This folder is an app.');
    await page.getByTestId('open-app').click();
    const view = page.getByTestId('file-view');
    const iframe = view.locator('iframe');
    await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
    expect(await iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    await expect(view).toContainText('This app cannot read your session or other files.');
    // a folder that is not an app has no such note
    await page.goto(`${stack.origin}/t/engineering/files?path=pages`);
    await expect(row(page, 'pages/runbook.md')).toBeVisible();
    await expect(page.getByTestId('app-note')).toHaveCount(0);
  } finally {
    await close();
  }
  expect(problems).toEqual([]);
});
