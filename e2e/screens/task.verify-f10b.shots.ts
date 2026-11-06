import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/*
 * Eighth-pass live check of feature 10 (P21-17 touch targets, recipes, setup fold, usage chart tooltip, bot usage gutters, Add a bot head, plain Model and Safety copy).
 * Run: set -a; . ~/manythreads.passwords.env; set +a; MANYTHREADS_URL=https://manythreads.kahf.to \
 *   pnpm -C e2e exec playwright test -c screens/task.config.ts task.verify-f10b --retries=0 --timeout=60000
 * Read-only as Omar: never saves, approves, denies, installs, changes a role or joins a team. Each probe step is non-fatal; the facts are logged as `[v] ...`.
 */
const BASE = process.env['MANYTHREADS_URL'] ?? 'https://manythreads.kahf.to';
const OUT = process.env['MANYTHREADS_SHOTS_DIR'] ?? '/tmp/claude-0/-root-manythreads/daef2f10-3041-491b-8f76-f5e85142bb02/scratchpad/f10b';
const TEAM = process.env['TEAM'] ?? 'engineering';
const BOT = process.env['BOT'] ?? 'engineer';
const log = (s: string): void => console.log(`[v] ${s}`);
mkdirSync(OUT, { recursive: true });
test.describe.configure({ mode: 'serial' });
test.use({ actionTimeout: 4000 });
test.beforeEach(() => { test.setTimeout(150_000); });

const problems: string[] = [];
const wirePage = (page: Page, tag: string): void => {
  page.on('pageerror', (e) => { problems.push(`PAGEERROR ${tag} ${page.url()} ${e.message}`); });
  page.on('console', (m) => { if (m.type() === 'error' && !/content security policy|eval/i.test(m.text())) problems.push(`console.error ${tag} ${page.url()} ${m.text().slice(0, 160)}`); });
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()} ${tag} ${r.request().method()} ${r.url().replace(BASE, '')}`); });
};
async function newCtx(browser: Browser, w: number, h: number, mobile: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width: w, height: h }, reducedMotion: 'reduce', ...(mobile ? { isMobile: true, hasTouch: true } : {}) });
  const page = await ctx.newPage();
  wirePage(page, String(w));
  return { ctx, page };
}
async function go(page: Page, path: string, wait = 1800): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle', { timeout: 6_000 }).catch(() => undefined);
  await page.waitForTimeout(wait);
}
const shoot = async (page: Page, n: string): Promise<void> => { await page.waitForTimeout(400); await page.screenshot({ path: join(OUT, `${n}.png`) }); log(`shot ${n}`); };
type Box = { x: number; y: number; width: number; height: number } | null;
const bx = (b: Box): string => (b ? `${Math.round(b.width * 10) / 10}x${Math.round(b.height * 10) / 10}@${Math.round(b.x)},${Math.round(b.y)}` : 'none');
async function overflow(page: Page, tag: string): Promise<void> {
  const r = await page.evaluate(() => ({ vw: window.innerWidth, sw: document.documentElement.scrollWidth, bsw: document.body.scrollWidth }));
  log(`SCROLLX ${tag}: vw=${r.vw} docScrollWidth=${r.sw} bodyScrollWidth=${r.bsw}${r.sw > r.vw ? ' OVERFLOW-X' : ' ok'}`);
}
let omar: { ctx: BrowserContext; page: Page };
let phone: { ctx: BrowserContext; page: Page };

test('1 login', async ({ browser }) => {
  // signed out sign-in at 390: Show password and Forgot password
  const a = await newCtx(browser, 390, 844, true);
  await go(a.page, '/sign-in');
  await a.page.getByLabel('Password', { exact: true }).fill('x-not-a-password');
  const tg = a.page.getByTestId('password-toggle');
  log(`(d) 390 Show password box=${bx(await tg.boundingBox())} label="${await tg.getAttribute('aria-label')}"`);
  const fg = a.page.getByRole('link', { name: /forgot/i });
  log(`(d) 390 Forgot link box=${bx(await fg.first().boundingBox().catch(() => null))} count=${await fg.count()}`);
  await shoot(a.page, 'd-signin-390');
  await overflow(a.page, 'signin-390');
  await a.ctx.close();
  const b = await newCtx(browser, 1440, 900, false);
  await go(b.page, '/sign-in');
  log(`(d) 1440 Show password box=${bx(await b.page.getByTestId('password-toggle').boundingBox())} Forgot box=${bx(await b.page.getByRole('link', { name: /forgot/i }).first().boundingBox().catch(() => null))}`);
  await shoot(b.page, 'd-signin-1440');
  await b.ctx.close();

  omar = await newCtx(browser, 1440, 900, false);
  phone = await newCtx(browser, 390, 844, true);
  for (const c of [omar, phone]) {
    await go(c.page, '/sign-in');
    await c.page.getByLabel('Email').fill(process.env['OMAR_EMAIL'] ?? '');
    await c.page.getByLabel('Password', { exact: true }).fill(process.env['OMAR_PASSWORD'] ?? '');
    await c.page.getByRole('button', { name: 'Sign in' }).click();
    await expect(c.page).not.toHaveURL(/\/sign-in/, { timeout: 20_000 });
  }
  log('signed in');
});

test('2 (a) bot page header buttons, (j) model and safety copy', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, `/t/${TEAM}/bots/${BOT}`);
    log(`bot page ${w}: url=${p.url().replace(BASE, '')} h1="${(await p.locator('h1').first().innerText({ timeout: 2000 }).catch(() => '?')).replace(/\s+/g, ' ')}"`);
    for (const id of ['open-conversation', 'deploy-bot', 'bot-more']) {
      const l = p.getByTestId(id);
      log(`(a) ${w} ${id}: count=${await l.count()} box=${bx(await l.first().boundingBox().catch(() => null))}`);
    }
    await shoot(p, `a-botpage-${w}`);
    await overflow(p, `botpage-${w}`);
    await p.getByTestId('bot-more').click().catch(() => log('bot-more click failed'));
    await p.waitForTimeout(300);
    const mm = await p.getByRole('menu').first().boundingBox().catch(() => null);
    log(`(a) ${w} "..." menu box=${bx(mm)} inside=${mm ? mm.x >= 0 && mm.x + mm.width <= w : '?'}`);
    await shoot(p, `a-botmore-${w}`);
    await p.keyboard.press('Escape');
  }
  const bad = /gateway aliases?|resolved at workspace|stage 2|classifier on the local alias|local alias/i;
  for (const tab of ['model', 'safety']) {
    for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
      const p = c.page;
      await go(p, `/t/${TEAM}/bots/${BOT}?tab=${tab}`);
      const txt = (await p.locator('[role=tabpanel]').first().innerText({ timeout: 3000 }).catch(() => '')).replace(/\s+/g, ' ');
      log(`(j) ${tab} ${w}: selected="${await p.locator('[role=tab][aria-selected=true]').first().innerText({ timeout: 2000 }).catch(() => '?')}" jargon=${JSON.stringify(txt.match(bad))} text=${JSON.stringify(txt.slice(0, 1400))}`);
      await shoot(p, `j-${tab}-${w}`);
      await overflow(p, `${tab}-${w}`);
    }
  }
});

test('3 (b) members row menu', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, '/settings/workspace/members');
    const m = p.getByTestId('member-menu');
    log(`(b) ${w} member-menu count=${await m.count()} first=${bx(await m.first().boundingBox().catch(() => null))} second=${bx(await m.nth(1).boundingBox().catch(() => null))}`);
    await shoot(p, `b-members-${w}`);
    await overflow(p, `members-${w}`);
    await m.first().click().catch(() => log('member-menu click failed'));
    await p.waitForTimeout(400);
    const mb = await p.getByRole('menu').first().boundingBox().catch(() => null);
    log(`(b) ${w} menu box=${bx(mb)} inside=${mb ? mb.x >= 0 && mb.x + mb.width <= w && mb.y >= 0 : '?'} items=${JSON.stringify(await p.getByRole('menuitem').allTextContents())}`);
    const last = p.getByRole('menuitem').last();
    const lb = await last.boundingBox().catch(() => null);
    if (lb) {
      const top = await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? (e.closest('[role=menuitem]') ? 'menuitem' : e.tagName) : null; }, { x: lb.x + lb.width / 2, y: lb.y + lb.height / 2 });
      log(`(b) ${w} last menuitem centre hit=${top}`);
    }
    await shoot(p, `b-members-menu-${w}`);
    await p.keyboard.press('Escape');
  }
});

test('4 (c) notification toggles', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, '/account/notifications');
    const info = await p.evaluate(() => {
      const els = Array.from(document.querySelectorAll('[data-testid=notification-kinds] input[type=checkbox], [data-testid=notification-kinds] [role=switch], [data-testid=notification-kinds] button[aria-checked]'));
      return els.slice(0, 4).map((el) => {
        const r = el.getBoundingClientRect();
        const lab = el.closest('label');
        const lr = lab?.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
        let hits = 0, tot = 0;
        for (let dx = -20; dx <= 20; dx += 4) for (let dy = -20; dy <= 20; dy += 4) { tot++; const h = document.elementFromPoint(cx + dx, cy + dy); if (h && (h === el || h === lab || lab?.contains(h) || el.contains(h))) hits++; }
        // the tap layer pseudo-element of the label / switch
        const pseudo = [lab, el, lab?.querySelector('span')].filter(Boolean).map((n) => { const a = getComputedStyle(n as Element, '::before'); const b = getComputedStyle(n as Element, '::after'); return `${(n as Element).tagName}:before(${a.content},${a.width}x${a.height},pos=${a.position},inset=${a.top}/${a.right}/${a.bottom}/${a.left}) after(${b.content},${b.width}x${b.height},pos=${b.position},inset=${b.top}/${b.right}/${b.bottom}/${b.left})`; });
        return { tag: el.tagName, name: el.getAttribute('aria-label') ?? el.id, box: `${Math.round(r.width)}x${Math.round(r.height)}`, label: lr ? `${Math.round(lr.width)}x${Math.round(lr.height)}` : null, display: cs.display, hit: `${hits}/${tot}`, pseudo };
      });
    });
    log(`(c) ${w} toggles: ${JSON.stringify(info, null, 1).replace(/\n\s*/g, ' ')}`);
    const html = await p.locator('[data-testid=notification-kinds] .nset-row').first().evaluate((e) => e.outerHTML.slice(0, 700)).catch(() => '?');
    log(`(c) ${w} first row html: ${html}`);
    await shoot(p, `c-notifications-${w}`);
    await overflow(p, `notifications-${w}`);
  }
});

test('5 (e) recipes', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, `/t/${TEAM}/recipes`);
    const cards = p.getByTestId('recipe-card');
    const n = await cards.count();
    log(`(e) ${w} cards=${n}`);
    const rows = await cards.evaluateAll((els) => els.map((e) => {
      const h = e.querySelector('h2,h3,h4,[class*=name],strong') as HTMLElement | null;
      const st = e.querySelector('[data-testid=recipe-state]') as HTMLElement | null;
      const add = e.querySelector('[data-testid=recipe-add]') as HTMLElement | null;
      const r = (x: HTMLElement | null) => { if (!x) return null; const b = x.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.x)},${Math.round(b.y)}`; };
      const title = h ? h.textContent?.trim() : (e.textContent ?? '').slice(0, 20);
      const lines = h ? Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight || '20')) : null;
      return `${title} | title ${r(h)} lines~${lines} | state ${r(st)} "${st?.textContent}" | add ${r(add)} | card ${r(e as HTMLElement)}`;
    }));
    for (const r of rows) log(`(e) ${w} ${r}`);
    await shoot(p, `e-recipes-${w}`);
    await p.screenshot({ path: join(OUT, `e-recipes-full-${w}.png`), fullPage: true });
    await overflow(p, `recipes-${w}`);
    // find 'Decision log'
    const dl = p.getByTestId('recipe-card').filter({ hasText: 'Decision log' }).first();
    if (await dl.count()) { await dl.scrollIntoViewIfNeeded(); await dl.hover().catch(() => undefined); await shoot(p, `e-recipes-decisionlog-${w}`); }
    else log(`(e) ${w} no Decision log card`);
  }
});

test('6 (f) setup first step fold', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, '/onboarding');
    const step = p.locator('.ob-step').first();
    const info = await step.evaluate((e) => {
      const q = (s: string) => { const x = e.querySelector(s) as HTMLElement | null; if (!x) return null; const b = x.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
      return { head: q('.ob-head'), title: q('.ob-head > span:first-child'), chip: q('.ob-head .chip'), btn: q('.ob-toggle'), num: q('.ob-num') };
    }).catch(() => null);
    log(`(f) ${w} first step: ${JSON.stringify(info)}`);
    await p.screenshot({ path: join(OUT, `f-setup-${w}.png`) });
    await step.scrollIntoViewIfNeeded().catch(() => undefined);
    await shoot(p, `f-setup-step-${w}`);
    await overflow(p, `setup-${w}`);
  }
});

test('7 (g) usage chart tooltip and Esc, (h) bot usage gutters', async () => {
  const p = omar.page;
  await go(p, '/settings/workspace/usage');
  const col = p.locator('.usage-col');
  log(`(g) bars=${await col.count()}`);
  const title = p.locator('[data-testid^=usage-chart-] .box-h').first();
  const tabbable = p.locator('.usage-col[tabindex="0"]').first();
  await tabbable.scrollIntoViewIfNeeded().catch(() => undefined);
  await tabbable.focus();
  await p.waitForTimeout(400);
  const tip = tabbable.locator('.usage-tip');
  const vis = async (): Promise<string> => tip.evaluate((e) => { const cs = getComputedStyle(e); const b = e.getBoundingClientRect(); return `display=${cs.display} vis=${cs.visibility} opacity=${cs.opacity} box=${Math.round(b.width)}x${Math.round(b.height)}@${Math.round(b.x)},${Math.round(b.y)}`; });
  const tbox = await title.boundingBox();
  log(`(g) title box=${bx(tbox)}; focused bar tip: ${await vis()}`);
  const tipBox = await tip.boundingBox().catch(() => null);
  const overlap = tipBox && tbox ? !(tipBox.x + tipBox.width <= tbox.x || tipBox.x >= tbox.x + tbox.width || tipBox.y + tipBox.height <= tbox.y || tipBox.y >= tbox.y + tbox.height) : '?';
  log(`(g) tip box=${bx(tipBox)} overlaps title box=${overlap}; text="${await tip.textContent()}"; titleText="${await title.textContent()}"`);
  // is title actually covered? elementFromPoint at title centre
  if (tbox) log(`(g) element at title centre: ${await p.evaluate(({ x, y }) => { const e = document.elementFromPoint(x, y); return e ? `${e.tagName}.${e.className}` : null; }, { x: tbox.x + Math.min(30, tbox.width / 2), y: tbox.y + tbox.height / 2 })}`);
  await shoot(p, 'g-usage-tip-1440');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  log(`(g) after Esc: data-tip=${await p.locator('[data-testid^=usage-chart-]').first().getAttribute('data-tip')}; tip: ${await vis()}; focus still on bar=${await p.evaluate(() => document.activeElement?.classList.contains('usage-col'))}`);
  await shoot(p, 'g-usage-esc-1440');
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(300);
  log(`(g) after ArrowLeft: tip: ${await (async () => tabbable.page().locator('.usage-col:focus .usage-tip').evaluate((e) => { const cs = getComputedStyle(e); return `vis=${cs.visibility} opacity=${cs.opacity} display=${cs.display}`; }).catch(() => 'n/a'))()}`);
  await shoot(p, 'g-usage-back-1440');
  // phone
  const q = phone.page;
  await go(q, '/settings/workspace/usage');
  await shoot(q, 'g-usage-390');
  await overflow(q, 'usage-390');
  // (h) bot usage
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const pg = c.page;
    await go(pg, `/t/${TEAM}/bots/${BOT}/usage`);
    const m = await pg.evaluate(() => {
      const el = document.querySelector('[data-testid^=usage-], .usage-page') as HTMLElement | null;
      const h1 = document.querySelector('h1') as HTMLElement | null;
      const box = document.querySelector('.box') as HTMLElement | null;
      const r = (x: HTMLElement | null) => { if (!x) return null; const b = x.getBoundingClientRect(); return `x=${Math.round(b.x)} right=${Math.round(b.right)} w=${Math.round(b.width)}`; };
      return { vw: window.innerWidth, h1: r(h1), firstBox: r(box), usage: r(el), usageClass: el?.className };
    });
    log(`(h) ${w} ${pg.url().replace(BASE, '')}: ${JSON.stringify(m)}`);
    await shoot(pg, `h-botusage-${w}`);
    await overflow(pg, `botusage-${w}`);
  }
});

test('8 (i) add a bot heading', async () => {
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    const p = c.page;
    await go(p, `/t/${TEAM}/bots/new`);
    const m = await p.evaluate(() => {
      const r = (x: Element | null) => { if (!x) return null; const b = x.getBoundingClientRect(); return `x=${Math.round(b.x)} right=${Math.round(b.right)} w=${Math.round(b.width)}`; };
      const h1 = document.querySelector('h1');
      const hd = h1?.closest('header, .page-head, [class*=head]') ?? null;
      const cards = Array.from(document.querySelectorAll('[data-testid=setup-brief], [data-testid=setup-examples], .box')).slice(0, 4).map((e) => `${(e as HTMLElement).dataset['testid'] ?? e.className}: ${r(e)}`);
      return { vw: window.innerWidth, h1: r(h1), head: r(hd), headClass: hd?.className, cards };
    });
    log(`(i) ${w}: ${JSON.stringify(m)}`);
    await shoot(p, `i-addbot-${w}`);
    await overflow(p, `addbot-${w}`);
  }
});

test('8b follow-ups: Forgot password, recipe Add, Model section words', async ({ browser }) => {
  const a = await newCtx(browser, 390, 844, true);
  await go(a.page, '/sign-in');
  const fg = a.page.getByRole('button', { name: /forgot password/i });
  log(`(d) 390 Forgot password button count=${await fg.count()} box=${bx(await fg.first().boundingBox().catch(() => null))}`);
  await shoot(a.page, 'd-signin-forgot-390');
  await a.ctx.close();
  const q = phone.page;
  await go(q, `/t/${TEAM}/recipes`);
  const add = q.getByTestId('recipe-add');
  log(`(e) 390 recipe-add count=${await add.count()} first=${bx(await add.first().boundingBox().catch(() => null))} visible=${await add.first().isVisible().catch(() => false)}`);
  const dl = q.getByTestId('recipe-card').filter({ hasText: 'Decision log' }).first();
  log(`(e) 390 Decision log card html: ${(await dl.evaluate((e) => e.outerHTML.slice(0, 1200)).catch(() => '?'))}`);
  const p = omar.page;
  await go(p, `/t/${TEAM}/recipes`);
  const c0 = p.getByTestId('recipe-card').first();
  await c0.hover();
  await p.waitForTimeout(300);
  log(`(e) 1440 hovered Add box=${bx(await c0.getByTestId('recipe-add').boundingBox().catch(() => null))}`);
  await shoot(p, 'e-recipes-hover-1440');
  for (const [c, w] of [[phone, 390], [omar, 1440]] as const) {
    await go(c.page, `/t/${TEAM}/bots/${BOT}?tab=model`);
    const t = (await c.page.locator('#sec-model').innerText({ timeout: 3000 }).catch(() => 'NO #sec-model')).replace(/\s+/g, ' ');
    log(`(j) model section ${w}: ${JSON.stringify(t)}`);
    await c.page.locator('#sec-model').scrollIntoViewIfNeeded().catch(() => undefined);
    await shoot(c.page, `j-modelsec-${w}`);
    await overflow(c.page, `modelsec-${w}`);
  }
  const a0 = q.getByTestId('recipe-add');
  log(`(e) 390 Add buttons disabled=${JSON.stringify(await a0.evaluateAll((els) => els.slice(0, 3).map((e) => `${(e as HTMLButtonElement).disabled} bg=${getComputedStyle(e).backgroundColor} op=${getComputedStyle(e).opacity}`)))}`);
  await go(phone.page, '/sign-in');
});

test('9 summary', async () => {
  const uniq = [...new Set(problems)];
  log(`PROBLEMS total ${problems.length}, unique ${uniq.length}`);
  for (const u of uniq) log(`  ${u}`);
  await omar.ctx.close();
  await phone.ctx.close();
});
