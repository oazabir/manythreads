import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { apiOn, channelsOf } from '../../support/stack-browser.ts';
import { DESKTOP, expectWireframe, openPage } from '../support/vt.ts';

/*
 * The viewers in the Files panel (PLAN phase 4 section 5, own baselines, class W): a PDF, an image, code, a Mermaid diagram, and an embedded
 * app, each opened from its row. 1440x900: viewer-pdf.png, viewer-image.png, viewer-code.png, viewer-mermaid.png, viewer-app.png. What a
 * viewer draws with its own fonts and engines (the PDF page, the diagram, the app's frame) is masked: the baseline holds the layout around it, the
 * toolbar, the details and the panel, which are this product's.
 */
const file = (name: string) => readFileSync(fileURLToPath(new URL(`../../fixtures/files/${name}`, import.meta.url)));
const ORDER = [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list', 'right-panel']];

let stack: Stack;
test.skip(({ isMobile }) => isMobile, 'the spec sets its own viewport');
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_CLOCK: 'fixed' });
  const omar = await apiOn(playwright, stack, 'omar');
  const dev = (await channelsOf(omar))['dev'];
  for (const [name, mime, data] of [['handbook.pdf', 'application/pdf', file('sample.pdf')], ['diagram.png', 'image/png', file('sample.png')]] as const) {
    const res = await omar.ctx.post(`/api/channels/${dev}/files`, { headers: { ...(await omar.headers()), 'content-type': mime, 'x-file-name': name }, data });
    expect(res.status()).toBe(201);
  }
  const res = await omar.ctx.post('/api/teams/engineering/repo/commit', {
    data: { changes: [{ op: 'put', path: 'pages/scripts/rollout.ts', content: readFileSync(fileURLToPath(new URL('../../fixtures/files/sample.ts', import.meta.url)), 'utf8'), encoding: 'utf8' }], message: 'Add the rollout script' },
    headers: await omar.headers(),
  });
  expect(res.status()).toBe(201);
  await omar.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

const mask = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) => els.forEach((el) => el.setAttribute('data-vt-mask', '')));

test('the PDF viewer matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=channels/dev&panel=file:' + (await fileId(page, 'handbook.pdf')));
    const panel = page.locator('[data-landmark="right-panel"]');
    await expect(panel.getByTestId('pdf-canvas')).toHaveAttribute('data-rendered', '1');
    await mask(page, '[data-testid="pdf-canvas"]');
    await expectWireframe(page, 'viewer-pdf', ORDER);
  } finally {
    await close();
  }
});

test('the image viewer matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=channels/dev&panel=file:' + (await fileId(page, 'diagram.png')));
    const img = page.locator('[data-landmark="right-panel"] img.media-img');
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    await expectWireframe(page, 'viewer-image', ORDER);
  } finally {
    await close();
  }
});

test('the code viewer matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=pages/scripts&panel=file:pages/scripts/rollout.ts');
    await expect(page.locator('[data-landmark="right-panel"]').getByTestId('viewer-code')).toHaveAttribute('data-language', 'typescript');
    await expectWireframe(page, 'viewer-code', ORDER);
  } finally {
    await close();
  }
});

test('the Mermaid viewer matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?path=pages/diagrams&panel=file:pages/diagrams/dispatch.mmd');
    const mm = page.locator('[data-landmark="right-panel"]').getByTestId('viewer-mermaid');
    await expect(mm).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await mask(page, '[data-testid="viewer-mermaid"] iframe');
    await expectWireframe(page, 'viewer-mermaid', ORDER);
  } finally {
    await close();
  }
});

test('the embedded app opened in the centre matches its baseline (W)', async ({ browser }) => {
  const { page, close } = await openPage(browser, stack, 'omar', DESKTOP);
  try {
    await page.goto('/t/engineering/files?open=apps/release-checklist');
    const view = page.getByTestId('file-view');
    await expect(view.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(view).toContainText('This app cannot read your session or other files.');
    await mask(page, '[data-testid="file-view"] iframe');
    await expectWireframe(page, 'viewer-app', [['team-switch', 'search', 'sidebar'], ['header', 'tree', 'list']]);
  } finally {
    await close();
  }
});

/** The file id of an attachment of #dev, read through the tree (the panel entry names an attachment by id). */
async function fileId(page: Page, name: string): Promise<string> {
  const res = await page.request.get('/api/teams/engineering/files/tree?path=channels/dev');
  const entry = ((await res.json()) as { entries: { name: string; fileId: string | null }[] }).entries.find((e) => e.name === name);
  if (!entry?.fileId) throw new Error(`no attachment ${name} in #dev`);
  return entry.fileId;
}
