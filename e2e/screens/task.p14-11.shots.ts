import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P14-11 (search filters, chips, saved searches, pages in the results) on the live site.
 * Omar searches words that already exist in the seeded content, so nothing is posted. The only thing written is one saved search whose
 * name starts with "[verify P14-11]"; it is deleted in the same run (and any left by an aborted run is swept first and last).
 * Priya (Engineering, not a member of the private #eng-leads) checks that a word only found there answers like a nonsense word.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p14-11-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P14-11]';
const HOME = '/t/engineering/threads';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function signIn(browser: Browser, who: string, phone: boolean): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`${who}@kahf.example`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password`).not.toHaveURL(/\/sign-in/);
  await page.goto(HOME);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p14-11-${name}.png`), animations: 'disabled' });
}

/** Types into the sidebar box (on a phone behind the Find button) and waits for the results of exactly that text. */
async function search(page: Page, q: string, phone: boolean, keepScroll = false): Promise<void> {
  if (phone) {
    if (await page.getByTestId('search-results').count()) await page.goto(HOME);
    await page.getByRole('button', { name: 'Find' }).click();
  }
  const box = phone ? page.locator('#shell-rail').getByRole('searchbox') : page.locator('[data-landmark="search"]').getByRole('searchbox');
  await box.fill(q);
  await answered(page, () => box.press('Enter'));
  await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', q, T);
  if (!keepScroll) await panelTop(page);
}

/** Where the results panel is scrolled to; the panel keeps its place when a new search replaces the results. Sets it to the top when asked. */
async function panelTop(page: Page, log = false): Promise<void> {
  const where = await page.getByTestId('search-results').evaluate((el) => {
    let top = 0;
    for (let n: HTMLElement | null = el; n; n = n.parentElement) {
      top = Math.max(top, n.scrollTop);
      n.scrollTop = 0;
    }
    return top;
  });
  if (log) console.log('panel scrolled by', where);
}

/**
 * Runs an action that starts a search and waits for the server's answer to it: the panel keeps showing the previous results while the
 * new ones load, so the page's own text cannot say when the answer is there.
 */
async function answered(page: Page, act: () => Promise<unknown>): Promise<void> {
  const reply = page.waitForResponse((r) => r.url().includes('/api/search?') && !r.url().includes('/saved'), T);
  await act();
  await reply;
  await page.waitForTimeout(500);
}

async function counts(page: Page): Promise<string> {
  const r = page.getByTestId('search-results');
  const n = async (id: string): Promise<number> => r.getByTestId(id).getByTestId('search-hit').count();
  return `messages ${await n('search-messages')}, threads ${await n('search-threads')}, files ${await n('search-files')}, pages ${await n('search-pages')}; chips ${await r.getByTestId('search-chip').count()}; more ${await r.getByTestId('search-more').count()}; empty ${await r.getByTestId('search-empty').count()}`;
}

async function disclose(page: Page, name: string): Promise<void> {
  const b = page.getByRole('button', { name, exact: true });
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
}

async function sweepSaved(page: Page): Promise<number> {
  const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
  const res = await page.request.get('/api/search/saved');
  const items = ((await res.json()) as { items: { id: string; name: string }[] }).items.filter((s) => s.name.startsWith(TAG));
  for (const s of items) await page.request.delete(`/api/search/saved/${s.id}`, { headers: { 'x-csrf-token': csrf } });
  return items.length;
}

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(300_000);

test('desktop: filters, chips, pages, the form, saved searches', async ({ browser }) => {
  const page = await signIn(browser, 'omar', false);
  console.log('swept before:', await sweepSaved(page));
  try {
    await search(page, 'deploy', false);
    console.log('deploy:', await counts(page));
    await shot(page, '01-plain-deploy');
    await page.getByTestId('search-pages').scrollIntoViewIfNeeded();
    await page.getByTestId('search-pages').getByRole('heading').scrollIntoViewIfNeeded();
    await shot(page, '02-pages-group');

    await search(page, 'from:nadia deploy', false, true);
    await shot(page, '02b-new-search-keeps-scroll');
    await panelTop(page, true);
    console.log('from:nadia deploy:', await counts(page));
    await shot(page, '03-from-nadia');

    await search(page, 'in:alerts deploy', false);
    console.log('in:alerts deploy:', await counts(page));
    await shot(page, '04-in-alerts');

    await search(page, 'has:link release', false);
    console.log('has:link release:', await counts(page));
    await shot(page, '05-has-link');

    await search(page, 'has:file', false);
    console.log('has:file:', await counts(page));
    await shot(page, '06-has-file-only');

    await search(page, 'is:thread release', false);
    console.log('is:thread release:', await counts(page));
    await shot(page, '07-is-thread');

    await search(page, 'after:2026-01-01 before:2026-12-31 deploy', false);
    console.log('after/before deploy:', await counts(page));
    await shot(page, '08-after-before');
    await search(page, 'before:2020-01-01 deploy', false);
    console.log('before:2020 deploy:', await counts(page));
    await shot(page, '09-before-2020-nothing');

    await search(page, 'from:nadia in:dev has:link release', false);
    console.log('all together:', await counts(page));
    await shot(page, '10-three-chips');
    await answered(page, () => page.getByRole('button', { name: 'Remove filter: Has a link' }).click());
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', 'from:nadia in:dev release', T);
    console.log('after removing a chip:', await counts(page));
    await shot(page, '11-chip-removed');

    await search(page, 'from:zzqx deploy', false);
    console.log('from:zzqx:', await counts(page), '|', await page.getByTestId('search-unmatched').innerText());
    await shot(page, '12-unknown-person-note');
    await search(page, 'in:zzqx deploy', false);
    console.log('in:zzqx:', await counts(page), '|', await page.getByTestId('search-unmatched').innerText());
    await shot(page, '13-unknown-channel-note');

    await search(page, 'release', false);
    console.log('release:', await counts(page));
    const more = page.getByTestId('search-more').first();
    if (await more.count()) {
      await more.scrollIntoViewIfNeeded();
      console.log('more note:', await more.innerText());
    }
    await shot(page, '14-there-are-more');

    // the Filters form
    await search(page, 'deploy', false);
    await disclose(page, 'Filters');
    const form = page.getByRole('form', { name: 'Search filters' });
    await expect(form).toBeVisible(T);
    await shot(page, '15-filters-form-empty');
    await form.getByLabel('From').fill('nadia');
    await form.getByLabel('In channel').fill('dev');
    await form.getByLabel('have a link').check();
    await form.getByLabel('After').fill('2026-01-01');
    await shot(page, '16-filters-form-filled');
    await answered(page, () => form.getByRole('button', { name: 'Apply filters' }).click());
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', /from:nadia/, T);
    console.log('form query:', await page.getByTestId('search-results').getAttribute('data-query'));
    console.log('form result:', await counts(page));
    await shot(page, '17-filters-form-applied');

    // save, change the search, run the saved one again, delete it
    const savedName = `${TAG} dev links`;
    await disclose(page, 'Saved searches');
    await shot(page, '18-saved-panel-before');
    await page.getByLabel('Name for this search').fill(savedName);
    await page.getByRole('button', { name: 'Save this search' }).click();
    await expect(page.getByTestId('saved-list')).toContainText(savedName, T);
    await shot(page, '19-saved-search-kept');
    const savedQuery = (await page.getByTestId('search-results').getAttribute('data-query')) ?? '';
    await search(page, 'budget', false);
    await disclose(page, 'Saved searches');
    await expect(page.getByTestId('saved-list')).toContainText(savedName, T);
    await shot(page, '20-saved-list-from-another-search');
    await answered(page, () => page.getByTestId('saved-list').getByRole('button', { name: new RegExp(`^${savedName.replace(/[[\]]/g, '\\$&')}`) }).click());
    await expect(page.getByTestId('search-results')).toHaveAttribute('data-query', savedQuery, T);
    console.log('saved rerun:', await counts(page));
    await shot(page, '21-saved-search-rerun');
    await disclose(page, 'Saved searches');
    await page.getByRole('button', { name: `Delete saved search ${savedName}` }).click();
    await expect(page.getByTestId('saved-empty')).toBeVisible(T);
    await shot(page, '22-saved-search-deleted');
  } finally {
    console.log('swept after:', await sweepSaved(page).catch(() => -1));
    await page.context().close();
  }
});

test('phone: the results panel has no sideways scroll', async ({ browser }) => {
  const page = await signIn(browser, 'omar', true);
  try {
    await search(page, 'from:nadia in:dev has:link release', true);
    console.log('phone:', await counts(page));
    await shot(page, '30-phone-results-chips');
    const wide = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      win: window.innerWidth,
      body: document.body.scrollWidth,
      over: Array.from(document.querySelectorAll('[data-testid="search-results"] *'))
        .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1)
        .slice(0, 5)
        .map((e) => `${e.tagName}.${(e as HTMLElement).className}`),
    }));
    console.log('phone widths:', JSON.stringify(wide));
    expect(wide.doc).toBeLessThanOrEqual(wide.win);
    await disclose(page, 'Filters');
    await page.getByRole('form', { name: 'Search filters' }).scrollIntoViewIfNeeded();
    await shot(page, '31-phone-filters-form');
    const wide2 = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    console.log('phone form no sideways:', wide2);
    await search(page, 'deploy', true);
    await page.getByTestId('search-pages').getByRole('heading').scrollIntoViewIfNeeded();
    await shot(page, '32-phone-pages-group');
    await search(page, 'from:zzqx deploy', true);
    await shot(page, '33-phone-unknown-person');
    console.log('phone sideways overall:', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  } finally {
    await page.context().close();
  }
});

test('priya: a phrase only in the private #eng-leads answers like a nonsense phrase', async ({ browser }) => {
  const PRIVATE = 'mean time to recovery';
  const NONSENSE = 'quokka lantern walnut kestrel';
  const omar = await signIn(browser, 'omar', false);
  await search(omar, PRIVATE, false);
  console.log('omar sees the private phrase:', await counts(omar));
  await shot(omar, '40-omar-sees-private-hit');
  await omar.context().close();

  const page = await signIn(browser, 'priya', false);
  try {
    const answer = async (q: string): Promise<string> => {
      await search(page, q, false);
      const text = (await page.getByTestId('search-results').innerText()).replace(q, '<Q>').replace(/\s+/g, ' ').trim();
      console.log(`priya "${q}":`, await counts(page), '|', text.slice(0, 300));
      return text;
    };
    const real = await answer(PRIVATE);
    await shot(page, '41-priya-private-phrase');
    const fake = await answer(NONSENSE);
    await shot(page, '42-priya-nonsense-phrase');
    expect(real).toBe(fake);
    // a word the private channel shares with public messages (a close spelling): Priya only ever sees the public ones
    const near = await answer('probation');
    await shot(page, '43-priya-probation-public-matches-only');
    expect(near).not.toContain('eng-leads');
    const inReal = await answer('in:eng-leads probation');
    await shot(page, '44-priya-in-private-channel');
    const inFake = await answer('in:zzqxnone probation');
    await shot(page, '45-priya-in-nonsense-channel');
    expect(inReal.replace(/eng-leads/g, '<C>')).toBe(inFake.replace(/zzqxnone/g, '<C>'));
    await expect(page.getByTestId('search-hit')).toHaveCount(0);
  } finally {
    console.log('swept (priya):', await sweepSaved(page).catch(() => -1));
    await page.context().close();
  }
});
