import { expect, test, type Page } from '@playwright/test';

/*
 * PLAN section 4, `e2e/files/viewers.spec.ts` (component level): /dev/viewers renders every viewer on its fixture from
 * e2e/fixtures/files; each mounts and nothing logs a console error or throws. The CSV and Markdown editing here are the editors'
 * own behaviour (what a save would write); the commit side comes with the Files screen.
 */

test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone layout of the viewers is covered by e2e/files/mobile-web.spec.ts');

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    // the embedded app probes its own sandbox on load: its refused fetch is the CSP doing its job, not a defect of the page
    if (m.type() === 'error' && !m.location().url.includes('/repo/app/')) problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  return problems;
}

const tile = (page: Page, id: string) => page.getByTestId(`dev-viewer-${id}`);

test('every viewer mounts on its fixture and nothing logs an error', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/dev/viewers');

  // Markdown: the editor shows the page (heading, table, task list)
  const md = tile(page, 'markdown').getByTestId('viewer-markdown');
  await expect(md.locator('.md-prose h1')).toHaveText('Week 37');
  await expect(md.locator('.md-prose table')).toBeVisible();
  await expect(md.locator('ul[data-type="taskList"] li')).toHaveCount(2);

  // Google link: a card, no iframe
  const google = tile(page, 'google').getByTestId('viewer-google');
  await expect(google).toContainText('Q3 planning notes');
  await expect(google.getByRole('link', { name: 'Open in Google' })).toHaveAttribute('href', /^https:\/\/docs\.google\.com\//);
  await expect(google.locator('iframe')).toHaveCount(0);

  // CSV: a grid with column letters and row numbers
  const csv = tile(page, 'csv').getByTestId('viewer-csv');
  await expect(csv.getByTestId('csv-cell')).toHaveCount(12);
  await expect(csv.getByRole('columnheader', { name: 'C' })).toBeVisible();
  await expect(csv.getByRole('button', { name: '+ Add row' })).toBeVisible();
  await expect(csv).toContainText('Saving creates a commit by Tariq');

  // PDF: pdf.js draws page 1 of 3, the toolbar pages and zooms
  const pdf = tile(page, 'pdf').getByTestId('viewer-pdf');
  await expect(pdf.getByTestId('pdf-page')).toHaveText('1/3');
  await expect(pdf.getByTestId('pdf-canvas')).toHaveAttribute('data-rendered', '1');
  await pdf.getByRole('button', { name: 'Next page' }).click();
  await expect(pdf.getByTestId('pdf-page')).toHaveText('2/3');
  await expect(pdf.getByTestId('pdf-canvas')).toHaveAttribute('data-rendered', '2');
  await pdf.getByRole('button', { name: 'Zoom in' }).click();
  await expect(pdf.getByTestId('pdf-zoom')).toHaveText('125%');
  await pdf.getByRole('button', { name: 'Previous page' }).click();
  await expect(pdf.getByTestId('pdf-page')).toHaveText('1/3');
  await expect(pdf.getByRole('link', { name: 'Download' })).toHaveAttribute('href', /sample\.pdf$/);

  // image: loaded (it has a size)
  const img = tile(page, 'image').locator('img.media-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // video and audio: media elements with their source
  await expect(tile(page, 'video').locator('video')).toHaveAttribute('src', /sample\.webm$/);
  await expect(tile(page, 'audio').locator('audio')).toHaveAttribute('src', /sample\.wav$/);

  // code: highlighted, read-only
  const code = tile(page, 'code').getByTestId('viewer-code');
  await expect(code).toHaveAttribute('data-language', 'typescript');
  await expect(code.locator('.hljs-keyword').first()).toBeVisible();
  await expect(code).toContainText('read-only');

  // Mermaid: a sandboxed frame that draws the diagram (an svg inside it), and the Source toggle
  const mm = tile(page, 'mermaid').getByTestId('viewer-mermaid');
  await expect(mm).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  const frame = mm.locator('iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(mm.frameLocator('iframe').locator('svg').first()).toBeVisible();
  await mm.getByRole('button', { name: 'Source' }).click();
  await expect(mm.getByTestId('mermaid-source')).toContainText('flowchart LR');

  // Office: a download card without a rendition, the PDF viewer with one
  await expect(tile(page, 'office').getByTestId('viewer-download')).toContainText('Preview is not available for Office files');
  await expect(tile(page, 'office-pdf').getByTestId('viewer-pdf').getByTestId('pdf-page')).toHaveText('1/3');

  // an embedded app: sandboxed frame and the copy
  const app = tile(page, 'app').getByTestId('viewer-app');
  await expect(app.getByTestId('app-badge')).toContainText('Sandboxed app');
  await expect(app).toContainText('This app cannot read your session or other files.');
  await expect(app.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');

  // nothing opens this file: a download card
  await expect(tile(page, 'unknown').getByTestId('viewer-download')).toContainText('There is no preview');

  expect(problems).toEqual([]);
});

test('a Mermaid syntax error shows the message and the source, and nothing throws (criterion 8)', async ({ page }) => {
  const problems = watch(page);
  await page.goto('/dev/viewers');
  const mm = tile(page, 'mermaid-error').getByTestId('viewer-mermaid');
  await expect(mm).toHaveAttribute('data-state', 'error', { timeout: 30_000 });
  await expect(mm.getByTestId('mermaid-error')).toBeVisible();
  await expect(mm.getByTestId('mermaid-error-message')).not.toBeEmpty();
  await expect(mm.getByTestId('mermaid-source')).toContainText('B{Is it ok?');
  await expect(mm.getByTestId('mermaid-source')).toContainText('flowchart LR');
  // the good diagram next to it is unaffected
  await expect(tile(page, 'mermaid').getByTestId('viewer-mermaid')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
});

test('editing one CSV cell changes that cell only in what would be saved (criterion 7)', async ({ page }) => {
  await page.goto('/dev/viewers');
  const csv = tile(page, 'csv').getByTestId('viewer-csv');
  const save = csv.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  const cell = csv.locator('[data-testid="csv-cell"][data-row="2"][data-col="1"]');
  await expect(cell).toHaveValue('455');
  await cell.fill('456');
  await expect(save).toBeEnabled();
  await save.click();
  const saved = tile(page, 'csv').getByTestId('dev-saved-csv');
  await expect(saved).toHaveText('week,signups,churn\n2026-W36,410,1.2%\n2026-W37,456,1.1%\n"2026-W38","470","1.0%"\n');
  await expect(csv).toContainText('Saved. A commit by Tariq was made.');
  // + Add row appends one line
  await csv.getByRole('button', { name: '+ Add row' }).click();
  await csv.locator('[data-testid="csv-cell"][data-row="4"][data-col="0"]').fill('2026-W39');
  await csv.locator('[data-testid="csv-cell"][data-row="4"][data-col="1"]').fill('480');
  await save.click();
  await expect(saved).toHaveText('week,signups,churn\n2026-W36,410,1.2%\n2026-W37,456,1.1%\n"2026-W38","470","1.0%"\n2026-W39,480,\n');
});

test('Markdown: the slash menu inserts a table, Raw shows the text, a save writes the edit', async ({ page }) => {
  await page.goto('/dev/viewers');
  const md = tile(page, 'markdown').getByTestId('viewer-markdown');
  const save = md.getByRole('button', { name: 'Save', exact: true });
  await expect(save).toBeDisabled();
  const prose = md.locator('.md-prose');
  await prose.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/table');
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-slash="table"]')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(prose.locator('table')).toHaveCount(2);
  await expect(save).toBeEnabled();
  await md.getByRole('button', { name: 'Raw' }).click();
  const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
  await expect(raw).toHaveValue(/\| Metric\s+\| Count\s+\|/);
  await expect(raw).toHaveValue(/\|\s+\|\s+\|\s+\|/);
  // raw edits go back to the editor
  await raw.fill(`${await raw.inputValue()}\nAdded in raw.\n`);
  await md.getByRole('button', { name: 'Raw' }).click();
  await expect(prose).toContainText('Added in raw.');
  await save.click();
  const saved = tile(page, 'markdown').getByTestId('dev-saved-markdown');
  await expect(saved).toContainText('# Week 37');
  await expect(saved).toContainText('Added in raw.');
  await expect(md).toContainText('Saved. A commit by Tariq was made.');
});

test('Markdown: untouched text keeps its bytes, and Raw round-trips exactly', async ({ page }) => {
  await page.goto('/dev/viewers');
  const md = tile(page, 'markdown').getByTestId('viewer-markdown');
  await md.getByRole('button', { name: 'Raw' }).click();
  const raw = md.getByRole('textbox', { name: 'Raw Markdown' });
  const original = await (await page.request.get('/__dev/files/page.md')).text();
  await expect(raw).toHaveValue(original);
  await md.getByRole('button', { name: 'Raw' }).click();
  await md.getByRole('button', { name: 'Raw' }).click();
  await expect(raw).toHaveValue(original);
  await expect(md.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});
