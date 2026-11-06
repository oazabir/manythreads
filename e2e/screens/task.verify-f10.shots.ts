import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Live check of feature 10 (P21-16 approvals, P21-17 bots, P21-18 add a bot / recipes / agents / projects, P21-19 account, settings, sign-in).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-f10 --retries=0 --timeout=60000
 * Signs in through the form (env vars, never printed). Read-only: it never approves, denies, saves, installs, sends an invitation, changes a role
 * or joins a team. The one edit (a draft field on the bot page) is discarded with "Discard changes".
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/f10';
const TEAM = process.env['TEAM'] ?? 'engineering';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 4000 });
test.beforeEach(() => { test.setTimeout(150_000); });

const problems: string[] = [];
const wirePage = (page: Page, tag: string): void => {
  page.on('pageerror', (e) => { problems.push(`PAGEERROR ${tag} ${page.url()} ${e.message}`); log(`PAGEERROR ${tag} ${e.message.slice(0, 160)}`); });
  page.on('console', (m) => {
    const t = m.text();
    if (/content security policy|refused to|violates|CSP-violation/i.test(t)) { problems.push(`CSP ${tag} ${page.url()} ${t.slice(0, 200)}`); log(`CSP ${tag} ${t.slice(0, 200)}`); }
    else if (m.type() === 'error') { problems.push(`console.error ${tag} ${page.url()} ${t.slice(0, 160)}`); log(`console.error ${tag} ${page.url().replace(BASE, '')} ${t.slice(0, 160)}`); }
  });
  page.on('response', (r) => { if (r.status() >= 400) { problems.push(`HTTP ${r.status()} ${tag} ${r.request().method()} ${r.url().replace(BASE, '')}`); log(`HTTP ${r.status()} ${tag} ${r.request().method()} ${r.url().replace(BASE, '')}`); } });
  page.on('requestfailed', (r) => { problems.push(`REQFAIL ${tag} ${r.url().replace(BASE, '')} ${r.failure()?.errorText}`); log(`REQFAIL ${tag} ${r.url().replace(BASE, '')} ${r.failure()?.errorText}`); });
};
async function newCtx(browser: Browser, w: number, h: number, mobile: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  wirePage(page, String(w));
  await page.addInitScript(() => { document.addEventListener('securitypolicyviolation', (e) => console.log(`CSP-violation ${e.violatedDirective} ${e.blockedURI} src=${e.sourceFile}:${e.lineNumber}:${e.columnNumber} sample=${(e.sample || '').slice(0, 80)}`)); });
  return { ctx, page };
}
async function signIn(page: Page, who: string, next?: string): Promise<void> {
  await page.getByLabel('Email').fill(process.env[`${who}_EMAIL`] ?? '');
  await page.getByLabel('Password', { exact: true }).fill(process.env[`${who}_PASSWORD`] ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
  void next;
}
let omar: { ctx: BrowserContext; page: Page };
let phone: { ctx: BrowserContext; page: Page };

const shoot = async (page: Page, n: string, full = false): Promise<void> => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, `${n}.png`), fullPage: full });
  log(`shot ${n}`);
};
/** Layout facts of the page as it stands: horizontal overflow, things off the right edge, touch targets under 44 px (phone). */
async function facts(page: Page, tag: string, touch = false): Promise<void> {
  const r = await page.evaluate((touchCheck) => {
    const vw = window.innerWidth;
    const doc = document.documentElement;
    const off: string[] = [];
    const small: string[] = [];
    const name = (e: Element): string => `${e.tagName.toLowerCase()}${(e as HTMLElement).dataset['testid'] ? `[${(e as HTMLElement).dataset['testid']}]` : ''}:${((e as HTMLElement).getAttribute('aria-label') || e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30)}`;
    for (const e of Array.from(document.querySelectorAll('body *'))) {
      const b = (e as HTMLElement).getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (b.right > vw + 1 && off.length < 6 && !(e as HTMLElement).closest('[data-scroll],.b-tabs,.table-wrap,[class*="scroll"]')) off.push(`${name(e)} right=${Math.round(b.right)}`);
      if (touchCheck && /^(a|button|select|input)$/i.test(e.tagName) && (b.height < 43.5 || b.width < 43.5) && small.length < 14 && b.right <= vw && b.bottom > 0) small.push(`${name(e)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    return { vw, sw: doc.scrollWidth, off, small };
  }, touch);
  log(`FACTS ${tag}: vw=${r.vw} scrollWidth=${r.sw}${r.sw > r.vw ? ' OVERFLOW-X' : ''}; offscreen=[${r.off.join(' | ')}]${touch ? `; <44px=[${r.small.join(' | ')}]` : ''}`);
}
async function go(page: Page, path: string, wait = 1800): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(wait);
}
/** Open a path on both viewports, shoot and log facts. */
async function both(path: string, name: string, full = false): Promise<void> {
  for (const [p, w, touch] of [[omar.page, '1440', false], [phone.page, '390', true]] as const) {
    await go(p, path);
    log(`PAGE ${name} ${w}: ${p.url().replace(BASE, '')} h1="${await p.locator('h1').first().textContent().catch(() => null)}"`);
    await shoot(p, `${name}-${w}`, full);
    await facts(p, `${name}-${w}`, touch);
  }
}

test('1 sign-in (signed out) and sign in', async ({ browser }) => {
  const anon = await newCtx(browser, 1440, 900, false);
  const ap = anon.page;
  await go(ap, '/sign-in');
  await shoot(ap, '01-signin-1440');
  const card = ap.locator('.auth-card');
  const cb = await card.boundingBox();
  log(`card width=${Math.round(cb?.width ?? 0)} brand text="${await ap.locator('.auth-card header').innerText().catch(() => '')}" tagline="${await ap.getByTestId('auth-tagline').textContent().catch(() => null)}"`);
  const brandFont = await ap.locator('.auth-card header').evaluate((e) => getComputedStyle(e.querySelector('*') ?? e).fontSize).catch(() => '?');
  log(`brand font-size ${brandFont}`);
  const btn = ap.getByRole('button', { name: 'Sign in', exact: true });
  const bb = await btn.boundingBox();
  log(`Sign in button width=${Math.round(bb?.width ?? 0)} (card inner? ${Math.round(cb?.width ?? 0)})`);
  const pw = ap.getByLabel('Password', { exact: true });
  const em = ap.getByLabel('Email');
  log(`attrs email: type=${await em.getAttribute('type')} autocomplete=${await em.getAttribute('autocomplete')} name=${await em.getAttribute('name')}; password: type=${await pw.getAttribute('type')} autocomplete=${await pw.getAttribute('autocomplete')} name=${await pw.getAttribute('name')}`);
  log(`Remember-this-device present: ${await ap.getByText(/remember this device/i).count()}`);
  const tg = ap.getByTestId('password-toggle');
  await pw.fill('x-not-a-password');
  const t0 = await pw.getAttribute('type');
  const pressed0 = await tg.getAttribute('aria-pressed');
  await tg.click();
  const t1 = await pw.getAttribute('type');
  const pressed1 = await tg.getAttribute('aria-pressed');
  await shoot(ap, '01-signin-shown-1440');
  await tg.click();
  log(`password toggle: type ${t0}->${t1}->${await pw.getAttribute('type')}; aria-pressed ${pressed0}->${pressed1}; label="${await tg.getAttribute('aria-label')}" box=${JSON.stringify(await tg.boundingBox())}`);
  await anon.ctx.close();

  const a2 = await newCtx(browser, 390, 844, true);
  await go(a2.page, '/sign-in');
  await shoot(a2.page, '01-signin-390');
  const c2 = await a2.page.locator('.auth-card').boundingBox();
  const b2 = await a2.page.getByRole('button', { name: 'Sign in', exact: true }).boundingBox();
  log(`390 card=${Math.round(c2?.x ?? 0)}+${Math.round(c2?.width ?? 0)} Sign-in button=${Math.round(b2?.width ?? 0)}x${Math.round(b2?.height ?? 0)}`);
  await facts(a2.page, 'signin-390', true);
  await a2.ctx.close();

  omar = await newCtx(browser, 1440, 900, false);
  await go(omar.page, '/sign-in');
  await signIn(omar.page, 'OMAR');
  phone = await newCtx(browser, 390, 844, true);
  await go(phone.page, '/sign-in');
  await signIn(phone.page, 'OMAR');
  await go(omar.page, '/');
  await shoot(omar.page, '01-home-1440');
  log(`signed in; url ${omar.page.url().replace(BASE, '')}`);
});

test('2 router smoke', async ({ browser }) => {
  const p = omar.page;
  await go(p, '/');
  await go(p, `/t/${TEAM}/bots`);
  const href = await p.locator('[data-testid="bot-row"] a').first().getAttribute('href').catch(() => null);
  log(`first bot link ${href}`);
  const botUrl = href ?? `/t/${TEAM}/bots/engineer`;
  await go(p, botUrl);
  log(`deep link bot: ${p.url().replace(BASE, '')} page=${await p.getByTestId('bot-page').count()} tabs=${await p.locator('[role=tab]').count()}`);
  await go(p, `/t/${TEAM}/approvals`);
  log(`deep link approvals: ${p.url().replace(BASE, '')} inbox=${await p.getByTestId('approvals-inbox').count()}`);
  await p.goBack(); await p.waitForTimeout(1200);
  log(`Back -> ${p.url().replace(BASE, '')} bot-page=${await p.getByTestId('bot-page').count()}`);
  await p.goBack(); await p.waitForTimeout(1200);
  log(`Back -> ${p.url().replace(BASE, '')}`);
  await p.goForward(); await p.waitForTimeout(1200);
  log(`Forward -> ${p.url().replace(BASE, '')}`);
  await p.goForward(); await p.waitForTimeout(1200);
  log(`Forward -> ${p.url().replace(BASE, '')} inbox=${await p.getByTestId('approvals-inbox').count()}`);
  await p.reload(); await p.waitForTimeout(1800);
  log(`reload -> ${p.url().replace(BASE, '')} inbox=${await p.getByTestId('approvals-inbox').count()} signed-in=${!/sign-in/.test(p.url())}`);
  // in-app navigation through the sidebar
  await p.getByRole('link', { name: /^Bots/ }).first().click().catch(() => log('no Bots link in the sidebar'));
  await p.waitForTimeout(1000);
  log(`sidebar Bots -> ${p.url().replace(BASE, '')}`);
  // signed out deep link
  const anon = await newCtx(browser, 1440, 900, false);
  await anon.page.goto(botUrl);
  await anon.page.waitForTimeout(2000);
  log(`signed-out deep link ${botUrl} -> ${anon.page.url().replace(BASE, '')}`);
  await shoot(anon.page, '02-signedout-deeplink-1440');
  await anon.page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
  await anon.page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
  await anon.page.getByRole('button', { name: 'Sign in' }).click();
  await anon.page.waitForTimeout(3500);
  log(`after sign-in -> ${anon.page.url().replace(BASE, '')} (expected ${botUrl}) bot-page=${await anon.page.getByTestId('bot-page').count()}`);
  await anon.ctx.close();
});

test('3 settings nav and account pages', async () => {
  const p = omar.page;
  await go(p, '/account');
  log(`/account -> ${p.url().replace(BASE, '')}`);
  const hash = '#' + 'acc-notifications';
  await go(p, `/account${hash}`);
  log(`/account${hash} -> ${p.url().replace(BASE, '')} h1="${await p.locator('h1').first().textContent()}" h2s=${JSON.stringify(await p.locator('h2').allTextContents())}`);
  log(`nav text: ${JSON.stringify((await p.locator('nav').filter({ hasText: 'Profile' }).first().innerText().catch(() => '')).replace(/\n+/g, ' / ').slice(0, 400))}`);
  await both('/account/profile', '03-account-profile');
  await both('/account/notifications', '03-account-notifications');
  await both('/account/security', '03-account-security');
  await both('/account/connections', '03-account-connections');
  // select's text is not cut off
  await go(p, '/account/notifications');
  const sel = await p.locator('select').evaluateAll((els) => els.map((e) => { const s = e as HTMLSelectElement; return { id: s.id, w: Math.round(s.getBoundingClientRect().width), sw: s.scrollWidth, cw: s.clientWidth, txt: s.selectedOptions[0]?.textContent }; }));
  log(`notification selects: ${JSON.stringify(sel)}`);
  // sticky: scroll and see nav stays
  await go(p, '/settings/workspace/members');
  const navBox = p.locator('nav').filter({ hasText: 'Members' }).first();
  const y0 = (await navBox.boundingBox())?.y;
  await p.mouse.move(700, 500); await p.mouse.wheel(0, 600); await p.waitForTimeout(500);
  const y1 = (await navBox.boundingBox())?.y;
  log(`nav y before scroll=${y0} after=${y1} (sticky if equal) groups: ${JSON.stringify((await navBox.innerText()).replace(/\n+/g, ' / ').slice(0, 400))}`);
  // 390 select optgroups
  await go(phone.page, '/settings/workspace/general');
  const opt = await phone.page.locator('select').first().evaluate((s) => Array.from(s.querySelectorAll('optgroup')).map((g) => `${g.label}(${g.querySelectorAll('option').length})`)).catch(() => []);
  log(`390 section select optgroups: ${JSON.stringify(opt)}`);
  await shoot(phone.page, '03-settings-general-390');
  await facts(phone.page, 'settings-general-390', true);
  await go(omar.page, '/settings/workspace/general');
  await shoot(omar.page, '03-settings-general-1440');
  // icon check: every nav link has an svg
  const noIcon = await omar.page.locator('nav a').evaluateAll((as) => as.filter((a) => !a.querySelector('svg')).map((a) => (a.textContent ?? '').trim()));
  log(`nav links without svg icon: ${JSON.stringify(noIcon)}`);
});

test('4 members', async () => {
  const p = omar.page;
  await go(p, '/settings/workspace/members');
  await shoot(p, '04-members-1440');
  log(`rows=${await p.getByTestId('member-row').count()} first row: ${JSON.stringify((await p.getByTestId('member-row').first().innerText()).replace(/\s+/g, ' '))}`);
  log(`avatars in rows: ${await p.getByTestId('member-row').first().locator('.av, [class*=avatar], img, svg').count()}`);
  await p.getByTestId('members-search').fill('nad');
  await p.waitForTimeout(500);
  log(`search "nad" -> ${await p.getByTestId('member-row').count()} rows`);
  await shoot(p, '04-members-search-1440');
  await p.getByTestId('members-search').fill('zzzz');
  log(`search "zzzz" -> none-note="${await p.getByTestId('members-none').textContent().catch(() => null)}"`);
  await p.getByTestId('members-search').fill('');
  await p.getByTestId('member-menu').first().click();
  await p.waitForTimeout(400);
  log(`row menu items: ${JSON.stringify(await p.getByRole('menuitem').allTextContents())}`);
  await shoot(p, '04-members-menu-1440');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  log(`after Esc menu open count=${await p.getByRole('menuitem').count()} focus on menu button=${await p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.['testid'])}`);
  await p.getByTestId('invite-people').click();
  await p.waitForTimeout(600);
  await shoot(p, '04-invite-dialog-1440');
  log(`invite dialog: role=${await p.getByRole('dialog').count()} email field=${await p.getByTestId('invite-email').count()} buttons=${JSON.stringify(await p.getByRole('dialog').getByRole('button').allTextContents())}`);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  log(`invite dialog closed with Esc: ${(await p.getByRole('dialog').count()) === 0}`);
  // phone
  const q = phone.page;
  await go(q, '/settings/workspace/members');
  await shoot(q, '04-members-390');
  await facts(q, 'members-390', true);
  await q.getByTestId('member-menu').first().click();
  await q.waitForTimeout(400);
  const menu = q.getByRole('menu').first();
  const mb = await menu.boundingBox();
  log(`390 member menu box ${JSON.stringify(mb)} inside screen: ${mb ? mb.x >= 0 && mb.x + mb.width <= 390 : '?'}`);
  await shoot(q, '04-members-menu-390');
  await q.keyboard.press('Escape');
  await q.getByTestId('invite-people').click();
  await q.waitForTimeout(600);
  await shoot(q, '04-invite-dialog-390');
  await facts(q, 'invite-390', true);
  await q.keyboard.press('Escape');
});

test('5 approvals', async () => {
  const p = omar.page;
  await go(p, `/t/${TEAM}/approvals`);
  await shoot(p, '05-approvals-1440');
  const rows = p.getByTestId('approval-row');
  const n = await rows.count();
  log(`approval rows: ${n}; testids: sentence=${await p.getByTestId('approval-row-sentence').count()} risk=${await p.getByTestId('approval-row-risk').count()} age=${await p.getByTestId('approval-age').count()}`);
  log(`tabs: ${JSON.stringify(await p.locator('[data-testid^="approvals-tab-"]').allInnerTexts())}`);
  for (let i = 0; i < Math.min(n, 6); i++) log(`row ${i}: ${JSON.stringify((await rows.nth(i).innerText()).replace(/\s+/g, ' ').slice(0, 200))} age="${await rows.nth(i).getByTestId('approval-age').textContent().catch(() => null)}"`);
  log(`sidebar approvals badge: ${JSON.stringify(await p.locator('nav, aside').getByRole('link', { name: /Approvals/ }).first().evaluate((a) => { const pill = a.querySelector('[class*=pill],[class*=badge],[class*=count]'); return pill ? { text: pill.textContent, cls: pill.className, bg: getComputedStyle(pill).backgroundColor } : 'no pill'; }).catch(() => 'no link'))}`);
  if (n > 0) {
    const first = rows.first();
    const before = await first.getByTestId('approval-row-approve').isVisible().catch(() => false);
    await first.hover();
    await p.waitForTimeout(400);
    const hov = await first.getByTestId('approval-row-approve').isVisible().catch(() => false);
    log(`row hover: Approve visible before=${before} on hover=${hov}; Deny=${await first.getByTestId('approval-row-deny').isVisible().catch(() => false)}; open-instead=${await first.getByTestId('approval-row-open').isVisible().catch(() => false)}`);
    await shoot(p, '05-approvals-hover-1440');
    await p.mouse.move(5, 5);
    await p.getByTestId('approval-pick').first().focus().catch(() => first.focus());
    await p.waitForTimeout(300);
    log(`keyboard focus: Approve visible=${await first.getByTestId('approval-row-approve').isVisible().catch(() => false)} focused=${await p.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.['testid'] ?? document.activeElement?.tagName)}`);
    await shoot(p, '05-approvals-focus-1440');
    await first.getByTestId('approval-pick').first().click().catch(() => first.click());
    await p.waitForTimeout(800);
    await shoot(p, '05-approvals-detail-1440');
    log(`detail: ${JSON.stringify((await p.getByTestId('approval-card').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300))} header actions=${await p.getByTestId('approval-header-actions').count()}`);
  } else {
    log('no approval rows to inspect');
  }
  // other tabs
  for (const t of await p.locator('[data-testid^="approvals-tab-"]').all()) {
    const id = await t.getAttribute('data-testid');
    await t.click(); await p.waitForTimeout(700);
    log(`tab ${id}: rows=${await p.getByTestId('approval-row').count()} empty=${await p.getByTestId('approvals-empty').count()}`);
  }
  await shoot(p, '05-approvals-lasttab-1440');
  const q = phone.page;
  await go(q, `/t/${TEAM}/approvals`);
  await shoot(q, '05-approvals-390');
  await facts(q, 'approvals-390', true);
  if ((await q.getByTestId('approval-row').count()) > 0) {
    await q.getByTestId('approval-row').first().click();
    await q.waitForTimeout(800);
    await shoot(q, '05-approvals-detail-390');
    await facts(q, 'approvals-detail-390', true);
    log(`390 detail Approve visible=${await q.getByTestId('approval-approve').first().isVisible().catch(() => false)} box=${JSON.stringify(await q.getByTestId('approval-approve').first().boundingBox().catch(() => null))}`);
  }
});

test('6 bots roster and bot page', async () => {
  const p = omar.page;
  await go(p, `/t/${TEAM}/bots`);
  await shoot(p, '06-roster-1440');
  const rows = p.getByTestId('bot-row');
  log(`roster rows ${await rows.count()}; headers=${JSON.stringify(await p.locator('[data-testid="bots-roster"] [role=columnheader], [data-testid="bots-roster"] th').allInnerTexts())}`);
  log(`chips: place=${await p.getByTestId('bot-chip-place').count()} scope=${await p.getByTestId('bot-chip-scope').count()} kind=${await p.getByTestId('bot-chip-kind').count()} talk=${await p.getByTestId('bot-talk').count()} background=${await p.getByTestId('bot-background').count()} configure=${await p.getByTestId('bot-configure').count()}`);
  for (let i = 0; i < Math.min(await rows.count(), 5); i++) log(`row ${i}: ${JSON.stringify((await rows.nth(i).innerText()).replace(/\s+/g, ' ').slice(0, 160))}`);
  log(`talk is primary: ${await p.getByTestId('bot-talk').first().evaluate((e) => e.className).catch(() => '?')}; configure label=${await p.getByTestId('bot-configure').first().getAttribute('aria-label')}`);
  const q = phone.page;
  await go(q, `/t/${TEAM}/bots`);
  await shoot(q, '06-roster-390');
  await facts(q, 'roster-390', true);
  const more = q.getByRole('button', { name: /^More/ }).first();
  if (await more.count()) {
    await more.click(); await q.waitForTimeout(400);
    const mb = await q.getByRole('menu').first().boundingBox();
    log(`390 roster More menu box ${JSON.stringify(mb)} inside=${mb ? mb.x >= 0 && mb.x + mb.width <= 390 : '?'} items=${JSON.stringify(await q.getByRole('menuitem').allTextContents())}`);
    await shoot(q, '06-roster-more-390');
    await q.keyboard.press('Escape');
  } else log('390: no More button on roster');

  // bot page
  const href = await p.locator('[data-testid="bot-row"] a').first().getAttribute('href').catch(() => null);
  const botUrl = href ?? `/t/${TEAM}/bots/engineer`;
  log(`bot page ${botUrl}`);
  await go(p, botUrl);
  await shoot(p, '06-botpage-1440');
  log(`header buttons: talk=${await p.getByTestId('open-conversation').count()} deploy=${await p.getByTestId('deploy-bot').count()} more=${await p.getByTestId('bot-more').count()}`);
  await p.getByTestId('bot-more').click();
  await p.waitForTimeout(400);
  log(`"…" items: ${JSON.stringify(await p.getByRole('menuitem').allTextContents())}`);
  await shoot(p, '06-botpage-more-1440');
  await p.keyboard.press('Escape');
  log(`tabs: ${JSON.stringify(await p.getByRole('tab').allTextContents())}`);
  await p.getByRole('tab').first().focus();
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(300);
  log(`ArrowRight -> selected tab: ${await p.locator('[role=tab][aria-selected=true]').textContent()} url=${p.url().replace(BASE, '')}`);
  await p.keyboard.press('End'); await p.waitForTimeout(300);
  log(`End -> selected tab: ${await p.locator('[role=tab][aria-selected=true]').textContent()}`);
  await p.keyboard.press('Home'); await p.waitForTimeout(300);
  log(`Home -> selected tab: ${await p.locator('[role=tab][aria-selected=true]').textContent()}`);
  // old link
  await go(p, `${botUrl}?tab=guard`);
  log(`?tab=guard -> selected: ${await p.locator('[role=tab][aria-selected=true]').textContent()}; guard section in view=${await p.locator('#sec-guard').evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= -5 && r.top < window.innerHeight; }).catch(() => 'no #sec-guard')}; h2s=${JSON.stringify(await p.locator('[role=tabpanel] h2').allTextContents())}`);
  await shoot(p, '06-botpage-guard-1440');
  await go(p, `${botUrl}?tab=triggers`);
  log(`triggers section text: ${JSON.stringify((await p.locator('#sec-triggers').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700))}`);
  await shoot(p, '06-botpage-triggers-1440');
  await go(p, `${botUrl}?tab=placement`);
  await shoot(p, '06-botpage-where-1440');
  log(`placement text: ${JSON.stringify((await p.locator('#sec-placement').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500))}`);

  // draft edit -> save bar -> leave prompt -> keep editing -> discard
  await go(p, botUrl);
  log(`save bar before edit: ${await p.getByTestId('bot-foot').count()}`);
  const field = p.locator('[role=tabpanel] textarea, [role=tabpanel] input[type=text]').first();
  const val0 = await field.inputValue();
  await field.focus();
  await p.keyboard.press('End');
  await p.keyboard.type(' x');
  await p.waitForTimeout(600);
  const bar = p.getByTestId('bot-foot');
  log(`save bar after edit: count=${await bar.count()} text="${(await bar.innerText().catch(() => '')).replace(/\s+/g, ' ')}" position=${await bar.evaluate((e) => getComputedStyle(e).position).catch(() => '?')} box=${JSON.stringify(await bar.boundingBox().catch(() => null))}`);
  await shoot(p, '06-savebar-1440');
  await p.getByTestId('save-more').click(); await p.waitForTimeout(300);
  log(`arrow menu items: ${JSON.stringify(await p.getByRole('menuitem').allTextContents())}`);
  await shoot(p, '06-savebar-menu-1440');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // leave prompt
  await p.getByRole('link', { name: /^Bots/ }).first().click().catch(() => undefined);
  await p.waitForTimeout(800);
  log(`leave prompt: ${await p.getByTestId('leave-stay').count()} stay-button, text=${JSON.stringify((await p.getByRole('dialog').innerText().catch(() => '')).replace(/\s+/g, ' '))} url=${p.url().replace(BASE, '')}`);
  await shoot(p, '06-leave-prompt-1440');
  await p.getByTestId('leave-stay').click().catch(() => undefined);
  await p.waitForTimeout(400);
  log(`after Keep editing: url=${p.url().replace(BASE, '')} bar=${await bar.count()}`);
  // discard
  await p.getByTestId('save-more').click(); await p.waitForTimeout(300);
  await p.getByTestId('reset-bot').click(); await p.waitForTimeout(600);
  log(`after Discard: bar=${await bar.count()} field restored=${(await field.inputValue()) === val0}`);

  // phone bot page
  await go(q, botUrl);
  await shoot(q, '06-botpage-390');
  await facts(q, 'botpage-390', true);
  await q.getByTestId('bot-more').click(); await q.waitForTimeout(400);
  const mm = await q.getByRole('menu').first().boundingBox();
  log(`390 bot "…" menu ${JSON.stringify(mm)} inside=${mm ? mm.x >= 0 && mm.x + mm.width <= 390 : '?'}`);
  await shoot(q, '06-botpage-more-390');
  await q.keyboard.press('Escape');
  const f2 = q.locator('[role=tabpanel] textarea, [role=tabpanel] input[type=text]').first();
  await f2.focus(); await q.keyboard.press('End'); await q.keyboard.type(' x'); await q.waitForTimeout(600);
  await shoot(q, '06-savebar-390');
  const sb = await q.getByTestId('bot-foot').boundingBox();
  log(`390 save bar box ${JSON.stringify(sb)}`);
  await facts(q, 'savebar-390', true);
  await q.getByTestId('save-more').click(); await q.waitForTimeout(300);
  const sm = await q.getByRole('menu').first().boundingBox();
  log(`390 save menu ${JSON.stringify(sm)}`);
  await shoot(q, '06-savebar-menu-390');
  await q.getByTestId('reset-bot').click(); await q.waitForTimeout(500);
  log(`390 after Discard bar=${await q.getByTestId('bot-foot').count()}`);
  await go(q, `${botUrl}?tab=safety`);
  await shoot(q, '06-botpage-safety-390');
});

test('7 add a bot and 8 recipes', async () => {
  const p = omar.page;
  await go(p, `/t/${TEAM}/bots/new`);
  await shoot(p, '07-add-1440');
  const ex = p.getByTestId('setup-examples');
  log(`brief box before examples: ${await p.evaluate(() => { const b = document.querySelector('[data-testid=setup-brief]'); const e = document.querySelector('[data-testid=setup-examples]'); return b && e ? !!(b.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) : '?'; })}; example cards: ${await ex.locator('button, a, [role=button], li').count()}`);
  log(`examples text: ${JSON.stringify((await ex.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700))}`);
  await p.getByTestId('setup-examples-all').click({ timeout: 8000 }).catch((e) => log(`SEE-ALL CLICK FAILED: ${String(e.message).replace(/\s+/g, ' ').slice(0, 700)}`));
  await p.waitForTimeout(600);
  await shoot(p, '07-add-seeall-1440');
  log(`See all dialog: ${await p.getByRole('dialog').count()} filter=${await p.getByTestId('setup-examples-filter').count()}`);
  await p.getByTestId('setup-examples-filter').fill('digest').catch(() => undefined);
  await p.waitForTimeout(400);
  await shoot(p, '07-add-seeall-filter-1440');
  await p.keyboard.press('Escape');
  const q = phone.page;
  await go(q, `/t/${TEAM}/bots/new`);
  await shoot(q, '07-add-390');
  await facts(q, 'add-390', true);
  await q.getByTestId('setup-examples-all').click({ timeout: 8000 }).catch((e) => log(`SEE-ALL CLICK FAILED 390: ${String(e.message).replace(/\s+/g, ' ').slice(0, 700)}`));
  await q.waitForTimeout(600);
  await shoot(q, '07-add-seeall-390');
  await facts(q, 'add-seeall-390', true);
  await q.keyboard.press('Escape');

  // recipes
  await go(p, `/t/${TEAM}/recipes`);
  await shoot(p, '08-recipes-1440');
  const cards = p.getByTestId('recipe-card');
  log(`recipe cards ${await cards.count()}; "Ready to add" text count=${await p.getByText('Ready to add').count()}; states=${JSON.stringify(await p.getByTestId('recipe-state').allTextContents().then((a) => a.slice(0, 12)))}`);
  log(`first cards: ${JSON.stringify((await cards.evaluateAll((els) => els.slice(0, 8).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').slice(0, 50)))))}`);
  const c0 = cards.first();
  log(`Add button visible at rest=${await c0.getByTestId('recipe-add').isVisible().catch(() => false)}`);
  await c0.hover(); await p.waitForTimeout(400);
  log(`Add button visible on hover=${await c0.getByTestId('recipe-add').isVisible().catch(() => false)}`);
  await shoot(p, '08-recipes-hover-1440');
  await p.mouse.move(5, 5);
  await c0.getByTestId('recipe-add').focus().catch(() => undefined);
  log(`Add visible on focus=${await c0.getByTestId('recipe-add').isVisible().catch(() => false)} svg icons in cards=${await cards.first().locator('svg').count()}`);
  await go(q, `/t/${TEAM}/recipes`);
  await shoot(q, '08-recipes-390');
  await facts(q, 'recipes-390', true);
  log(`390 Add visible=${await q.getByTestId('recipe-add').first().isVisible().catch(() => false)} box=${JSON.stringify(await q.getByTestId('recipe-add').first().boundingBox().catch(() => null))}`);
});

test('9 agents and projects, bot chat markup', async () => {
  const p = omar.page;
  for (const t of ['customer-support', 'marketing']) {
    await go(p, `/t/${t}/approvals`);
    log(`approvals of ${t}: rows=${await p.getByTestId('approval-row').count()}`);
    if (await p.getByTestId('approval-row').count()) await shoot(p, `05-approvals-${t}-1440`);
  }
  await both(`/t/${TEAM}/agents`, '09-agents');
  log(`agents: strip=${await p.getByTestId('status-strip-item').count()} how-fold open=${await p.getByTestId('agents-how-fold').getAttribute('open').catch(() => 'n/a')} admin-note=${JSON.stringify(await p.getByTestId('agents-admin-note').textContent().catch(() => null))}`);
  await both(`/t/${TEAM}/projects`, '09-projects');
  log(`projects: strip=${await p.getByTestId('status-strip-item').count()} how-fold=${await p.getByTestId('projects-how-fold').count()} rows=${await p.getByTestId('projects-row').count()}`);
  // chat page for a bot in this team (Omar is on engineering, so no 403); read only
  const href = await p.locator('a[href*="/chat"]').first().getAttribute('href').catch(() => null);
  log(`a chat link seen: ${href}`);
  await both(`/t/${TEAM}/bots/engineer/chat`, '09-botchat');
  log('Join as admin NOT clicked (adds Omar to a team for real); 403 markup is checked by e2e/conversations/join-as-admin.spec.ts only');
});

test('10 audit, setup, health, usage', async () => {
  await both('/settings/workspace/audit', '10-audit');
  const p = omar.page;
  log(`audit: table=${await p.getByTestId('audit-table').count()} fold-toggles=${await p.getByTestId('audit-fold-toggle').count()} who chips=${JSON.stringify(await p.getByTestId('audit-who').innerText().catch(() => null))} outcome=${JSON.stringify(await p.getByTestId('audit-outcome').innerText().catch(() => null))}`);
  log(`audit "×" folded rows: ${JSON.stringify(await p.getByText(/[×x] ?\d+/).allTextContents().then((a) => a.slice(0, 5)))}`);
  const th = await p.locator('th').first().evaluate((e) => getComputedStyle(e).position).catch(() => '?');
  await p.mouse.move(700, 500); await p.mouse.wheel(0, 800); await p.waitForTimeout(500);
  const thb = await p.locator('th').first().boundingBox().catch(() => null);
  log(`audit th position=${th}; after scroll th y=${thb?.y}`);
  await shoot(p, '10-audit-scrolled-1440');
  if (await p.getByTestId('audit-fold-toggle').count()) {
    await p.getByTestId('audit-fold-toggle').first().click(); await p.waitForTimeout(400);
    await shoot(p, '10-audit-expanded-1440');
  }
  await both('/onboarding', '10-setup', true);
  log(`setup page text: ${JSON.stringify((await p.locator('main, [data-landmark=content]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 900))}`);
  await go(p, '/onboarding');
  await p.mouse.move(700, 500); await p.mouse.wheel(0, 900); await p.waitForTimeout(400);
  await shoot(p, '10-setup-scrolled-1440');
  await both('/settings/workspace/health', '10-health');
  log(`health summary: ${JSON.stringify(await p.getByTestId('health-summary').textContent().catch(() => null))}; rows: ${JSON.stringify((await p.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 700))}`);
  await both('/settings/workspace/usage', '10-usage');
  const bars = p.locator('[aria-label*=" runs"], [aria-label*="run:"], [role=img] [tabindex="0"], svg [tabindex="0"], [class*=bar][tabindex]');
  log(`usage focusable bars=${await bars.count()} sample aria=${JSON.stringify(await bars.first().getAttribute('aria-label').catch(() => null))}`);
  if (await bars.count()) {
    await bars.nth(Math.min(3, (await bars.count()) - 1)).hover(); await p.waitForTimeout(400);
    await shoot(p, '10-usage-tooltip-1440');
    await bars.first().focus(); await p.keyboard.press('Tab'); await p.waitForTimeout(300);
    log(`after Tab on bar, focused: ${await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))}`);
    await shoot(p, '10-usage-focus-1440');
  }
  log(`usage chart text: ${JSON.stringify((await p.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500))}`);
});

test('11 non-admin and guest views', async ({ browser }) => {
  for (const who of ['NADIA', 'LENA']) {
    if (!process.env[`${who}_EMAIL`]) { log(`${who}: no persona`); continue; }
    for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]] as const) {
      const c = await newCtx(browser, w, h, mobile);
      await go(c.page, '/sign-in');
      await signIn(c.page, who);
      await go(c.page, '/account/profile');
      const navText = (await c.page.locator('nav').filter({ hasText: 'Profile' }).first().innerText().catch(() => '')).replace(/\n+/g, ' / ');
      const opts = mobile ? await c.page.locator('select').first().evaluate((s) => Array.from(s.querySelectorAll('optgroup,option')).map((o) => o.tagName === 'OPTGROUP' ? `[${(o as HTMLOptGroupElement).label}]` : o.textContent)).catch(() => []) : [];
      log(`${who} ${w}: url=${c.page.url().replace(BASE, '')} nav=${JSON.stringify(navText.slice(0, 300))} select=${JSON.stringify(opts)}`);
      await shoot(c.page, `11-${who.toLowerCase()}-account-${w}`);
      await go(c.page, '/settings/workspace/members');
      log(`${who} ${w}: /settings/workspace/members -> ${c.page.url().replace(BASE, '')}`);
      await c.ctx.close();
    }
  }
});

test('11b extras', async ({ browser }) => {
  const q = phone.page;
  await go(q, '/settings/workspace/audit');
  await q.getByTestId('audit-table').scrollIntoViewIfNeeded();
  await q.waitForTimeout(500);
  await shoot(q, '10-audit-table-390');
  const p = omar.page;
  await go(p, '/settings/workspace/usage');
  const bars = p.locator('[tabindex="0"][aria-label*=" run"]');
  log(`usage bars with tabindex+aria: ${await bars.count()} sample=${JSON.stringify(await bars.nth(3).getAttribute('aria-label').catch(() => null))}`);
  const chart = p.locator('[aria-label="Bot runs per day, one bar for each day"]').first();
  log(`chart role=${await chart.getAttribute('role')} tabindex=${await chart.getAttribute('tabindex')} children focusable=${await chart.locator('[tabindex]').count()}`);
  await chart.focus().catch(() => undefined);
  for (let i = 0; i < 3; i++) { await p.keyboard.press('Tab'); }
  log(`after 3 Tabs focus: ${await p.evaluate(() => { const a = document.activeElement; return a ? `${a.tagName} aria=${a.getAttribute('aria-label')}` : null; })}`);
  await shoot(p, '10-usage-focus2-1440');
  const n = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 } });
  const np = await n.newPage();
  wirePage(np, 'nadia');
  await go(np, '/sign-in');
  await signIn(np, 'NADIA');
  await go(np, '/settings/workspace/members');
  await shoot(np, '11-nadia-members-1440');
  log(`nadia members page text: ${JSON.stringify((await np.locator('main').first().innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200))}`);
  await go(np, `/t/marketing/approvals`);
  await shoot(np, '05-approvals-nadia-marketing-1440');
  log(`nadia marketing approvals rows=${await np.getByTestId('approval-row').count()}`);
  if (await np.getByTestId('approval-row').count()) {
    const row = np.getByTestId('approval-row').first();
    await row.hover(); await np.waitForTimeout(400);
    log(`nadia row hover: approve=${await row.getByTestId('approval-row-approve').isVisible()} deny=${await row.getByTestId('approval-row-deny').isVisible()} open=${await row.getByTestId('approval-row-open').isVisible()}`);
    await shoot(np, '05-approvals-nadia-hover-1440');
    await np.mouse.move(5, 5);
    await row.getByTestId('approval-pick').focus().catch(() => undefined);
    await np.keyboard.press('Tab');
    log(`nadia keyboard focus: approve visible=${await row.getByTestId('approval-row-approve').isVisible()} focused=${await np.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.['testid'])}`);
    await shoot(np, '05-approvals-nadia-focus-1440');
  }
  await n.close();
});

test('12 summary', async () => {
  const uniq = [...new Set(problems)];
  log(`PROBLEMS total ${problems.length}, unique ${uniq.length}`);
  for (const u of uniq) log(`  ${u}`);
  await omar.ctx.close();
  await phone.ctx.close();
});
