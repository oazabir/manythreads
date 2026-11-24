import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * P14-10 (quick switcher, keyboard) and P14-02 (composer toolbar, emoji picker, Up arrow edits the last own message) on the live site.
 * Everything posted starts with "[verify P14-10-02]" and is deleted again in the same run (API sweep by the tag).
 * The unread state is made with "Mark unread from here" on a message other people wrote (nothing is posted for it).
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-10-02-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P14-10-02]';
const PAGES = ['/t/engineering/c/general', '/t/delivery/c/general', '/t/engineering/c/alerts'];

const msgs = (page: Page): Locator => page.getByTestId('channel-view').getByTestId('message');

async function apiDelete(page: Page, id: string): Promise<void> {
  const cid = await page.getByTestId('channel-view').getAttribute('data-channel-id');
  const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const res = await page.request.delete(`/api/channels/${cid}/messages/${id}`, { headers: { 'x-csrf-token': csrf } });
  console.log('api delete', id.slice(-6), res.status());
}

/** Delete every message of this run that is in the open channel. */
async function sweep(page: Page, path: string): Promise<number> {
  await page.goto(path);
  await page.getByTestId('channel-view').waitFor({ timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  if (await jump.isVisible()) await jump.click();
  await page.waitForTimeout(1_000);
  const ids = await msgs(page).filter({ hasText: TAG }).evaluateAll((els) => els.map((e) => e.getAttribute('data-message-id') ?? ''));
  for (const id of ids) await apiDelete(page, id);
  return ids.length;
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('omar@kahf.example');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/);
}

test.describe.configure({ retries: 0 });
test.setTimeout(300_000);

test('quick switcher, keyboard, composer toolbar, emoji picker, edit last', async ({ browser }) => {
  test.skip(process.env['P141002_ONLY'] === 'cleanup' || process.env['P141002_ONLY'] === 'phone', 'only a part was asked for');
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const shot = async (name: string): Promise<void> => {
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, `p14-10-02-${name}.png`), animations: 'disabled' });
  };
  await signIn(page);
  for (const url of PAGES) await sweep(page, url);
  try {
    // ---- quick switcher
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    await page.waitForTimeout(1_500);
    await page.mouse.move(5, 5); // a pointer resting where the list opens would highlight a row by hover
    await page.keyboard.press('Control+k');
    const search = page.getByTestId('quick-switcher-search');
    await expect(search).toBeVisible(T);
    await expect(page.getByTestId('quick-switcher-option').first()).toBeVisible(T);
    console.log('switcher rows (empty query):', await page.getByTestId('quick-switcher-option').count());
    console.log((await page.getByTestId('quick-switcher-list').innerText()).replace(/\n+/g, ' | ').slice(0, 600));
    console.log('hints:', JSON.stringify(await page.getByTestId('quick-switcher-option').evaluateAll((els) => els.slice(0, 14).map((e) => `${e.querySelector('.qs-label')?.textContent}=${(e.querySelector('.qs-hint') as HTMLElement | null)?.innerText ?? ''}@${Math.round(e.querySelector('.qs-hint')?.getBoundingClientRect().width ?? -1)}`))));
    console.log('active row:', await page.locator('[data-testid="quick-switcher-option"][aria-selected="true"] .qs-label').innerText());
    await shot('01-switcher-open');
    await search.fill('al');
    await page.waitForTimeout(600);
    console.log('rows for "al":', (await page.getByTestId('quick-switcher-list').innerText()).replace(/\n+/g, ' | ').slice(0, 400));
    await shot('02-switcher-narrowed');
    await page.keyboard.press('Escape');
    await expect(search).toHaveCount(0, T);
    // Caps Lock: the browser reports a capital K
    await page.keyboard.press('Control+K');
    await expect(search).toBeVisible(T);
    await search.fill('gen');
    await page.waitForTimeout(500);
    await shot('03-switcher-capslock');
    await page.keyboard.press('Control+K');
    await expect(search).toHaveCount(0, T);
    // a result opens its place
    await page.keyboard.press('Control+k');
    await search.fill('alerts');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/c\/alerts/, T);
    // the ? sheet
    await page.locator('body').click({ position: { x: 700, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Shift+?');
    await expect(page.getByTestId('shortcut-sheet')).toBeVisible(T);
    await shot('04-shortcut-sheet');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcut-sheet')).toHaveCount(0, T);

    // ---- an unread channel: mark a message of someone else unread in #alerts, leave, press Alt+Down
    await page.goto('/t/engineering/c/alerts');
    await expect(msgs(page).first()).toBeVisible(T);
    await page.waitForTimeout(1_500);
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    if (await jump.isVisible()) await jump.click();
    await page.waitForTimeout(800);
    const others = msgs(page).filter({ hasNotText: TAG });
    const n = await others.count();
    const row = others.nth(Math.max(0, n - 4));
    await row.scrollIntoViewIfNeeded();
    for (let i = 0; i < 4; i++) {
      await row.hover();
      await row.getByRole('button', { name: 'More actions' }).click();
      if (await page.getByRole('menuitem', { name: 'Mark unread from here' }).isVisible({ timeout: 1_500 }).catch(() => false)) break;
      await page.keyboard.press('Escape');
    }
    await page.getByRole('menuitem', { name: 'Mark unread from here' }).click();
    await expect(page.getByTestId('unread-divider')).toBeVisible(T);
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    await page.waitForTimeout(2_500);
    await shot('05-before-alt-down');
    await page.locator('body').click({ position: { x: 700, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(2_500);
    console.log('Alt+Down went to', page.url());
    await shot('06-alt-down-next-unread');
    if (!/\/c\/alerts/.test(page.url())) {
      await page.goto('/t/engineering/c/alerts');
      await page.waitForTimeout(2_500);
    }
    const first = page.getByTestId('jump-first-unread');
    console.log('jump-first-unread visible:', await first.isVisible());
    await shot('07-jump-first-unread');
    if (await first.isVisible()) {
      await first.click();
      await page.waitForTimeout(1_000);
      await shot('08-after-jump-first-unread');
    }

    // ---- composer toolbar in #general (Engineering)
    await page.goto('/t/engineering/c/general');
    await expect(page.getByTestId('channel-view')).toBeVisible(T);
    const composer = page.getByRole('textbox', { name: /^Message #/ });
    await composer.click();
    await page.waitForTimeout(500);
    await shot('09-composer-toolbar-focus');
    const word = async (text: string): Promise<void> => {
      await composer.pressSequentially(text);
      for (let i = 0; i < text.length; i++) await page.keyboard.press('Shift+ArrowLeft');
    };
    await composer.fill(`${TAG} `);
    await word('bold');
    await page.getByRole('button', { name: 'Bold' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await word('italic');
    await page.getByRole('button', { name: 'Italic' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await word('item one');
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Enter');
    await composer.pressSequentially('const x = 1;');
    await page.getByLabel('Insert a code block').selectOption({ label: 'TypeScript' });
    await page.waitForTimeout(500);
    console.log('composer text:', JSON.stringify(await composer.inputValue()));
    await shot('10-composer-formats-applied');
    await page.keyboard.press('Enter');
    const posted = msgs(page).filter({ hasText: TAG }).last();
    await expect(posted).toBeVisible(T);
    await page.waitForTimeout(1_000);
    await shot('11-formatted-message-sent');

    // ---- emoji picker
    await composer.click();
    await page.getByRole('button', { name: 'Emoji' }).click();
    const picker = page.getByTestId('emoji-picker');
    await expect(picker).toBeVisible(T);
    await shot('12-emoji-picker-open');
    await picker.getByLabel('Search emoji').fill('smile');
    await page.waitForTimeout(500);
    await shot('13-emoji-search-smile');
    await picker.getByLabel('Search emoji').fill('wave');
    await page.waitForTimeout(400);
    await shot('13b-emoji-search-wave');
    await picker.getByLabel('Search emoji').fill('thumb');
    await picker.getByRole('radio', { name: 'Medium-dark skin tone' }).click();
    await page.waitForTimeout(500);
    await shot('14-emoji-skin-tone');
    await picker.getByLabel('Search emoji').fill('wave');
    await picker.locator('.emp-cell').first().click();
    await page.waitForTimeout(500);
    if (await picker.isVisible()) {
      await picker.getByLabel('Search emoji').fill('');
      await page.waitForTimeout(300);
    }
    await shot('15-emoji-inserted');
    console.log('composer after emoji:', JSON.stringify(await composer.inputValue()));
    if (!(await picker.isVisible())) await page.getByRole('button', { name: 'Emoji' }).click();
    await expect(picker).toBeVisible(T);
    await expect(picker.getByTestId('emoji-recent')).toBeVisible(T);
    await shot('16-emoji-recents');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0, T);

    // ---- Up arrow in an empty composer opens the last own message for editing
    await composer.fill('');
    await composer.click();
    await page.keyboard.press('ArrowUp');
    const editBox = page.getByRole('textbox', { name: 'Edit message' });
    await expect(editBox).toBeVisible(T);
    console.log('edit box holds:', JSON.stringify((await editBox.inputValue()).slice(0, 80)));
    await shot('17-up-arrow-edit');
    await page.keyboard.press('Escape');
  } finally {
    for (const url of PAGES) console.log('cleanup', url, 'deleted', await sweep(page, url).catch(() => -1));
    console.log('left in general:', await msgs(page).filter({ hasText: TAG }).count());
    await page.goto('/t/engineering/c/alerts');
    await page.waitForTimeout(1_500);
    const j = page.getByRole('button', { name: 'Jump to latest' });
    if (await j.isVisible()) await j.click();
    await page.waitForTimeout(1_500);
    console.log('alerts after the run: New line', await page.getByTestId('unread-divider').count(), '; jump button', await page.getByTestId('jump-first-unread').count());
    await context.close();
  }
});

test('phone: composer toolbar and the header', async ({ browser }) => {
  test.skip(process.env['P141002_ONLY'] === 'cleanup' || process.env['P141002_ONLY'] === 'desktop', 'only a part was asked for');
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signIn(page);
  await page.goto('/t/engineering/c/alerts');
  await expect(page.getByTestId('channel-view')).toBeVisible(T);
  await page.waitForTimeout(2_500);
  await page.screenshot({ path: join(OUT, 'p14-10-02-20-phone-header.png'), animations: 'disabled' });
  const head = await page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll('header, [role="banner"], .chead, .channel-head, h1, h2').forEach((el) => {
      const r = el.getBoundingClientRect();
      out.push(`${el.tagName}.${(el as HTMLElement).className} "${(el.textContent ?? '').trim().slice(0, 60)}" w=${Math.round(r.width)} sw=${el.scrollWidth} h=${Math.round(r.height)} y=${Math.round(r.y)}`);
    });
    return out;
  });
  console.log('phone header elements:\n' + head.join('\n'));
  const composer = page.getByRole('textbox', { name: /^Message #/ });
  await composer.tap();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'p14-10-02-21-phone-composer-toolbar.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Emoji' }).tap().catch(() => undefined);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'p14-10-02-22-phone-emoji-picker.png'), animations: 'disabled' });
  await context.close();
});

test('clean up what an aborted run left', async ({ browser }) => {
  test.skip(process.env['P141002_ONLY'] !== 'cleanup', 'only on request');
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await signIn(page);
  for (const url of PAGES) console.log('cleanup', url, await sweep(page, url));
  await context.close();
});
