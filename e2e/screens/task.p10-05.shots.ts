import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, request as pwRequest, test, type Browser, type Page } from '@playwright/test';

/**
 * P10-05 (Audit console and export) on the live site. Omar (workspace admin) reads Settings, Workspace, Audit (history rows, filters by action,
 * outcome, team and date, Show older, the empty state), makes fresh events (a refused sign-in for a made-up address, a throwaway proposal that is
 * made and withdrawn) and sees them arrive, checks that no canary text reaches a row, exports the file and checks its signature with openssl
 * (then with one byte changed), and finds the export's own row. Priya (a plain member) has no Audit entry and the three routes answer 403.
 * The phone picture shows the cards. Everything written is a throwaway; the proposal is withdrawn again.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p10-05-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P10-05]';
const TEAM = 'engineering';
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
// strings that must never come back in an audit row
const CANARY_PW = 'canarypw-p1005-Zx9Qv';
const CANARY_BODY = 'canarybody-p1005-Rt5Lm';
const CANARY_TITLE = 'canarytitle-p1005-Kd3Wn';
const BOGUS_LOCAL = 'nobody-p1005';
const BOGUS_EMAIL = `${BOGUS_LOCAL}@example.invalid`;
const PROPOSAL_PATH = 'skills/verify-p10-05.md';

type Res = { status: number; text: string; json: unknown };
type Api = { get: (path: string) => Promise<Res>; post: (path: string, data?: unknown) => Promise<Res> };
type Row = {
  id: string;
  occurredAt: string;
  actor: { id: string | null; kind: string; name: string };
  category: string;
  action: string;
  target: { kind: string | null; id: string | null; label: string | null };
  team: { id: string; name: string } | null;
  outcome: string;
  reason: string | null;
  source: string;
};
type Page_ = { entries: Row[]; nextCursor: string | null };

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
  if (PASSWORD.length < 8) throw new Error('MANYTHREADS_LIVE_PASSWORD is not set (the live screenshot password)');
  mkdirSync(OUT, { recursive: true });
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: phone ? PHONE : DESKTOP,
    reducedMotion: 'reduce',
    acceptDownloads: true,
    timezoneId: 'UTC',
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(`${who}@kahf.example`);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page, `${who} signs in with the screenshot password`).not.toHaveURL(/\/sign-in/);
  await page.goto(`/t/${TEAM}/threads`);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

function apiOf(page: Page): Api {
  const call = async (method: 'GET' | 'POST', path: string, data?: unknown): Promise<Res> => {
    const csrf = (await page.context().cookies()).find((c) => /manythreads_csrf$/.test(c.name))?.value ?? '';
    const res = method === 'GET' ? await page.request.get(path) : await page.request.post(path, { data: data ?? {}, headers: { 'x-csrf-token': csrf } });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status(), text, json };
  };
  return { get: (p) => call('GET', p), post: (p, d) => call('POST', p, d) };
}

async function shot(page: Page, name: string, fullPage = false): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p10-05-${name}.png`), animations: 'disabled', fullPage });
}

/** Every row the API holds for a query string, newest first, with the raw JSON text of every page (to search for canaries). */
async function allRows(api: Api, query = ''): Promise<{ rows: Row[]; raw: string }> {
  const rows: Row[] = [];
  let raw = '';
  let cursor: string | null = null;
  for (let i = 0; i < 100; i++) {
    const qs = `limit=200${query ? `&${query}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await api.get(`/api/admin/audit?${qs}`);
    if (res.status !== 200) throw new Error(`audit list ${res.status}: ${res.text.slice(0, 200)}`);
    raw += res.text;
    const page = res.json as Page_;
    rows.push(...page.entries);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return { rows, raw };
}

const tally = (rows: Row[], key: (r: Row) => string): string =>
  JSON.stringify(
    Object.fromEntries(
      [...rows.reduce((m, r) => m.set(key(r), (m.get(key(r)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]),
    ),
  );

async function withdrawMine(api: Api): Promise<string> {
  const notes: string[] = [];
  const open = ((await api.get(`/api/teams/${TEAM}/proposals?status=open&limit=200`)).json as { proposals?: { id: string; title: string }[] } | null)?.proposals ?? [];
  for (const p of open.filter((x) => x.title.startsWith(TAG))) {
    let r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/withdraw`);
    if (r.status >= 400) r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/reject`, { note: 'verification run cleanup' });
    notes.push(`proposal ${p.id.slice(0, 8)} -> ${r.status}`);
  }
  return notes.join('; ') || 'nothing to withdraw';
}

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(600_000);
test.use({ actionTimeout: 30_000 });

test('Omar and Priya: audit rows, filters, fresh events, content-blind, signed export, member refused, phone', async ({ browser }) => {
  const work = mkdtempSync(join(tmpdir(), 'p1005-'));
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  console.log('withdrawn before:', await withdrawMine(omarApi));
  try {
    // ---- health: the list answers for an admin
    const probe = await omarApi.get('/api/admin/audit?limit=5');
    console.log('GET /api/admin/audit as Omar:', probe.status);
    expect(probe.status).toBe(200);

    // ---- (a) the screen with the history rows
    await omar.goto('/settings/workspace/audit');
    await expect(omar.getByTestId('audit-table')).toBeVisible(T);
    await expect(omar.locator('.audit-row').first()).toBeVisible(T);
    const nav = (await omar.locator('nav').first().innerText()).replace(/\s+/g, ' ');
    console.log('nav has Audit:', /Audit/.test(nav));
    const before = await allRows(omarApi);
    console.log('total rows:', before.rows.length);
    console.log('by action:', tally(before.rows, (r) => r.action));
    console.log('by outcome:', tally(before.rows, (r) => r.outcome));
    console.log('by actor kind:', tally(before.rows, (r) => r.actor.kind));
    console.log('by team:', tally(before.rows, (r) => r.team?.name ?? '(none)'));
    console.log('by source:', tally(before.rows, (r) => r.source));
    console.log('by day:', tally(before.rows, (r) => r.occurredAt.slice(0, 10)));
    console.log('oldest / newest:', before.rows.at(-1)?.occurredAt, before.rows[0]?.occurredAt);
    const blankActor = before.rows.filter((r) => !r.actor.name.trim());
    const nullActorId = before.rows.filter((r) => r.actor.id === null);
    console.log('rows with a blank actor name:', blankActor.length, '| rows with null actor id:', nullActorId.length, tally(nullActorId, (r) => `${r.actor.kind}:${r.actor.name}:${r.action}`));
    const rawIdLabels = before.rows.filter((r) => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.target.label ?? '') || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(r.actor.name));
    console.log('rows whose actor name or target label is a raw uuid:', rawIdLabels.length, rawIdLabels.slice(0, 3).map((r) => `${r.action} ${r.actor.name} ${r.target.label}`));
    const noTargetLabel = before.rows.filter((r) => r.target.kind && !r.target.label);
    console.log('rows with a target kind but no label:', noTargetLabel.length, tally(noTargetLabel, (r) => `${r.action}/${r.target.kind}`));
    const ids = new Set(before.rows.map((r) => r.id));
    console.log('duplicate row ids:', before.rows.length - ids.size);
    const dupKey = new Map<string, number>();
    for (const r of before.rows) dupKey.set(`${r.occurredAt}|${r.actor.name}|${r.action}|${r.target.id}`, (dupKey.get(`${r.occurredAt}|${r.actor.name}|${r.action}|${r.target.id}`) ?? 0) + 1);
    console.log('same-instant-same-action look-alike rows:', [...dupKey.values()].filter((n) => n > 1).length);
    const future = before.rows.filter((r) => Date.parse(r.occurredAt) > Date.now() + 60_000);
    console.log('rows dated in the future:', future.length);
    const proposalApplied = before.rows.filter((r) => r.action === 'proposal.applied');
    console.log('proposal.applied rows:', proposalApplied.length, proposalApplied.slice(0, 40).map((r) => r.target.label).join(' | '));
    console.log('verify-p7-01/p7-08 rows:', before.rows.filter((r) => /verify-p7-0[18]/.test(r.target.label ?? '')).length);
    const first5 = before.rows.slice(0, 5).map((r) => `${r.occurredAt} ${r.actor.name} ${r.action} ${r.target.kind}:${r.target.label} ${r.team?.name ?? '-'} ${r.outcome} ${r.reason ?? ''}`);
    console.log('newest five:', first5);
    expect(before.rows.length).toBeGreaterThan(0);
    await shot(omar, '01-audit-desktop-top');
    await omar.locator('.audit-results').scrollIntoViewIfNeeded();
    const rowsOnScreen = await omar.locator('.audit-row').count();
    console.log('rows on the first screen:', rowsOnScreen);
    expect(rowsOnScreen).toBeLessThanOrEqual(50);
    const widths = await omar.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      cells: Array.from(document.querySelectorAll('.audit-row:first-child td, .audit-table th')).slice(0, 6).map((c) => Math.round(c.getBoundingClientRect().width)),
      clipped: Array.from(document.querySelectorAll('.audit-row td *')).filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'visible').length,
    }));
    console.log('desktop widths:', JSON.stringify(widths));
    await omar.evaluate(() => window.scrollTo(0, 420));
    await shot(omar, '02-audit-desktop-table');

    // Show older
    if (before.rows.length > 50) {
      await omar.getByRole('button', { name: 'Show older' }).scrollIntoViewIfNeeded();
      await omar.getByRole('button', { name: 'Show older' }).click();
      await expect.poll(() => omar.locator('.audit-row').count(), T).toBeGreaterThan(50);
      console.log('rows after Show older:', await omar.locator('.audit-row').count());
      await omar.locator('.audit-row').nth(55).scrollIntoViewIfNeeded().catch(() => undefined);
      await shot(omar, '03-audit-show-older');
      await omar.goto('/settings/workspace/audit');
      await expect(omar.getByTestId('audit-table')).toBeVisible(T);
    } else {
      console.log('Show older: fewer than 51 rows, no button expected; present:', await omar.getByRole('button', { name: 'Show older' }).count());
    }

    // filter by action
    const actionFilter = omar.getByLabel('Did what');
    const pickAction = before.rows.some((r) => r.action === 'proposal.applied') ? 'Applied a proposal' : 'Signed in';
    await actionFilter.selectOption({ label: pickAction });
    await expect(omar.locator('.audit-row').first()).toBeVisible(T);
    await omar.waitForTimeout(600);
    const actionRows = await omar.locator('.audit-row').evaluateAll((els) => els.map((e) => e.getAttribute('data-action')));
    console.log(`filter Did what = ${pickAction}:`, actionRows.length, [...new Set(actionRows)]);
    expect(new Set(actionRows).size).toBe(1);
    await shot(omar, '04-filter-action');

    // filter by outcome (withheld, then refused)
    await omar.getByRole('button', { name: 'Clear filters' }).click();
    for (const [label, word] of [['Withheld', 'withheld'], ['Refused', 'denied']] as const) {
      await omar.getByLabel('Outcome').selectOption({ label });
      await omar.waitForTimeout(900);
      const n = await omar.locator('.audit-row').count();
      const outs = await omar.locator('.audit-row').evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('data-outcome')))]);
      const empty = await omar.getByTestId('audit-empty').count();
      console.log(`filter Outcome = ${label}: rows ${n}, outcomes ${JSON.stringify(outs)}, empty state ${empty}`);
      if (n > 0) expect(outs).toEqual([word]);
      await shot(omar, `05-filter-outcome-${word}`);
    }
    await omar.getByRole('button', { name: 'Clear filters' }).click();

    // filter by team
    const teamsInRows = [...new Set(before.rows.map((r) => r.team?.name).filter((x): x is string => !!x))];
    console.log('teams seen in rows:', teamsInRows);
    if (teamsInRows[0]) {
      const teamName = teamsInRows.includes('Engineering') ? 'Engineering' : teamsInRows[0];
      await omar.locator('label.audit-f', { has: omar.locator('span', { hasText: /^Team$/ }) }).locator('select').selectOption({ label: teamName });
      await omar.waitForTimeout(900);
      const names = await omar.locator('.audit-row td[data-label="Team"]').allInnerTexts();
      console.log(`filter Team = ${teamName}: rows`, names.length, [...new Set(names)]);
      expect([...new Set(names)]).toEqual([teamName]);
      await shot(omar, '06-filter-team');
      await omar.getByRole('button', { name: 'Clear filters' }).click();
    }

    // filter by date range: the oldest row's day, then a day with nothing (empty state)
    const oldestDay = before.rows.at(-1)!.occurredAt.slice(0, 10);
    await omar.locator('input[type=date]').nth(0).fill(oldestDay);
    await omar.locator('input[type=date]').nth(1).fill(oldestDay);
    await omar.waitForTimeout(900);
    const dayTimes = await omar.locator('.audit-row td[data-label="When"] time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime') ?? ''));
    const expectedDay = before.rows.filter((r) => r.occurredAt.slice(0, 10) === oldestDay).length;
    console.log(`date range ${oldestDay}..${oldestDay}: rows ${dayTimes.length} (API says ${expectedDay} for that UTC day), all on that day:`, dayTimes.every((t) => t.startsWith(oldestDay)));
    expect(dayTimes.length).toBeGreaterThan(0);
    await shot(omar, '07-filter-date-range');
    await omar.getByRole('button', { name: 'Clear filters' }).click();
    await omar.locator('input[type=date]').nth(0).fill('2001-01-01');
    await omar.locator('input[type=date]').nth(1).fill('2001-01-02');
    await expect(omar.getByTestId('audit-empty')).toBeVisible(T);
    console.log('empty state says:', (await omar.getByTestId('audit-empty').innerText()).replace(/\s+/g, ' '));
    await shot(omar, '08-filter-empty-state');
    await omar.getByRole('button', { name: 'Clear filters' }).click();
    await expect(omar.locator('.audit-row').first()).toBeVisible(T);

    // ---- (b) fresh events appear; rows are content-blind
    const started = new Date(Date.now() - 2000).toISOString();
    const anon = await pwRequest.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
    const bad = await anon.post('/api/auth/password/sign-in', { data: { email: BOGUS_EMAIL, password: CANARY_PW } });
    console.log('bogus sign-in answered:', bad.status());
    // a made-up address has no workspace to write to, so it leaves no row by design (identity-password sign-in route); a real person's wrong password does
    const wrong = await anon.post('/api/auth/password/sign-in', { data: { email: 'priya@kahf.example', password: CANARY_PW } });
    console.log('wrong-password sign-in for a real person answered:', wrong.status());
    await anon.dispose();
    const made = await omarApi.post(`/api/teams/${TEAM}/proposals`, {
      path: PROPOSAL_PATH,
      content: `# ${CANARY_BODY}\n\nA throwaway skill that a verification run proposes and withdraws.\n`,
      baseBlobSha: null,
      title: `${TAG} ${CANARY_TITLE}`,
      note: `${CANARY_BODY} note`,
    });
    console.log('proposal created:', made.status, made.text.slice(0, 160).replace(CANARY_BODY, '<body>'));
    expect(made.status, made.text.slice(0, 200)).toBe(201);
    const pid = (made.json as { proposal: { proposal: { id: string } } }).proposal.proposal.id;
    const w = await omarApi.post(`/api/teams/${TEAM}/proposals/${pid}/withdraw`);
    console.log('proposal withdrawn:', w.status);
    expect(w.status).toBeLessThan(300);
    const t0 = Date.now();
    let fresh: Row[] = [];
    let seenAt = -1;
    for (let i = 0; i < 40; i++) {
      fresh = (await allRows(omarApi, `from=${encodeURIComponent(started)}`)).rows;
      if (fresh.some((r) => r.action === 'sign_in.failed' && r.actor.name === 'Priya') && fresh.some((r) => r.action === 'proposal.created')) {
        seenAt = Math.round((Date.now() - t0) / 1000);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log(`fresh rows after ${seenAt} s (-1: not seen):`, fresh.map((r) => `${r.occurredAt} ${r.actor.kind}:${r.actor.name} ${r.action} ${r.target.kind}:${r.target.label} ${r.team?.name ?? '-'} ${r.outcome} ${r.reason ?? ''} src=${r.source}`));
    console.log('a withdraw row exists:', fresh.some((r) => /withdr/.test(r.action)), '(the catalog has no withdraw action)');
    console.log('a row for the made-up address exists:', fresh.some((r) => r.action === 'sign_in.failed' && r.actor.name !== 'Priya'));
    expect(seenAt).toBeGreaterThanOrEqual(0);
    await omar.reload();
    await expect(omar.locator('.audit-row').first()).toBeVisible(T);
    await omar.waitForTimeout(500);
    await shot(omar, '09-fresh-rows-at-the-top');
    // the canary strings in the whole log (all pages) and in the open page's text
    const everything = await allRows(omarApi);
    const pageText = await omar.locator('.audit-page').innerText();
    for (const [name, needle] of [['password', CANARY_PW], ['proposal body', CANARY_BODY], ['proposal title', CANARY_TITLE]] as const) {
      const inApi = everything.raw.includes(needle);
      const inUi = pageText.includes(needle);
      console.log(`canary ${name} in API json: ${inApi}, on screen: ${inUi}`);
      expect(inApi).toBe(false);
      expect(inUi).toBe(false);
    }
    console.log('the made-up email local part in rows:', everything.raw.includes(BOGUS_LOCAL), '| full address:', everything.raw.includes(BOGUS_EMAIL));
    console.log('"password" word in any reason:', everything.rows.filter((r) => /password/i.test(r.reason ?? '')).map((r) => r.reason).slice(0, 3));
    console.log('distinct reasons:', JSON.stringify([...new Set(everything.rows.map((r) => r.reason))].slice(0, 40)));

    // ---- (c) export, signature, tamper
    const exportStarted = Date.now();
    const [dl] = await Promise.all([omar.waitForEvent('download', { timeout: 60_000 }), omar.getByTestId('audit-export').click()]);
    const nd = join(work, 'audit.ndjson');
    await dl.saveAs(nd);
    console.log('export file name:', dl.suggestedFilename());
    await expect(omar.getByTestId('audit-export-done')).toBeVisible(T);
    const [dlSig] = await Promise.all([omar.waitForEvent('download', { timeout: 20_000 }), omar.getByRole('button', { name: 'Save signature' }).click()]);
    const sigPath = join(work, 'audit.ndjson.sig');
    await dlSig.saveAs(sigPath);
    const [dlKey] = await Promise.all([omar.waitForEvent('download', { timeout: 20_000 }), omar.getByRole('button', { name: 'Save public key' }).click()]);
    const keyPath = join(work, 'audit-key.pem');
    await dlKey.saveAs(keyPath);
    console.log('signature file name:', dlSig.suggestedFilename(), '| key file name:', dlKey.suggestedFilename());
    await omar.getByText('How to check the file').click();
    await shot(omar, '10-export-done-and-how-to-check');
    // the key from the route must equal the saved key
    const keyRoute = await omarApi.get('/api/admin/audit/signing-key');
    console.log('signing-key route:', keyRoute.status, JSON.stringify({ ...(keyRoute.json as object), publicKeyPem: '<pem>' }));
    expect(keyRoute.status).toBe(200);
    expect((keyRoute.json as { publicKeyPem: string }).publicKeyPem.trim()).toBe(readFileSync(keyPath, 'utf8').trim());
    // the exact commands of docs/plugins/audit.md
    execFileSync('bash', ['-c', 'base64 -d < audit.ndjson.sig > audit.ndjson.sig.bin'], { cwd: work });
    const verify = (file: string): string => {
      try {
        return execFileSync('openssl', ['pkeyutl', '-verify', '-pubin', '-inkey', 'audit-key.pem', '-rawin', '-in', file, '-sigfile', 'audit.ndjson.sig.bin'], { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        return `exit ${err.status}: ${(err.stdout ?? '').trim()} ${(err.stderr ?? '').trim()}`.trim();
      }
    };
    const good = verify('audit.ndjson');
    console.log('openssl on the untouched file:', good);
    expect(good).toContain('Signature Verified Successfully');
    const bytes = readFileSync(nd);
    const flipped = Buffer.from(bytes);
    const at = Math.floor(flipped.length / 2);
    flipped[at] = flipped[at]! ^ 0x01;
    writeFileSync(join(work, 'tampered.ndjson'), flipped);
    const tampered = verify('tampered.ndjson');
    console.log(`openssl after flipping one bit at byte ${at} of ${bytes.length}:`, tampered);
    expect(tampered).toContain('Signature Verification Failure');
    // one line dropped
    const lines = bytes.toString('utf8').split('\n').filter(Boolean);
    writeFileSync(join(work, 'dropped.ndjson'), `${lines.slice(0, -1).join('\n')}\n`);
    console.log('openssl with the last row dropped:', verify('dropped.ndjson'));
    const manifest = JSON.parse(lines[0]!) as Record<string, unknown>;
    console.log('manifest:', JSON.stringify(manifest));
    console.log('entry lines:', lines.length - 1, '| manifest rowCount:', manifest['rowCount'], '| API total before export:', everything.rows.length);
    expect(lines.length - 1).toBe(manifest['rowCount']);
    const canaryInFile = [CANARY_PW, CANARY_BODY, CANARY_TITLE].filter((c) => bytes.toString('utf8').includes(c));
    console.log('canaries in the export file:', canaryInFile);
    expect(canaryInFile).toEqual([]);

    // the export's own row
    let exported: Row | undefined;
    for (let i = 0; i < 30 && !exported; i++) {
      exported = (await allRows(omarApi, `from=${encodeURIComponent(new Date(exportStarted - 5000).toISOString())}`)).rows.find((r) => r.action === 'audit.exported');
      if (!exported) await new Promise((r) => setTimeout(r, 4000));
    }
    console.log('audit.exported row:', exported ? `${exported.occurredAt} ${exported.actor.name} ${exported.target.kind}:${exported.target.label} ${exported.outcome} ${exported.reason}` : 'NOT FOUND');
    expect(exported).toBeTruthy();
    await omar.reload();
    await expect(omar.locator('.audit-row').first()).toBeVisible(T);
    await omar.getByLabel('Did what').selectOption({ label: 'Exported the audit log' }).catch(async () => {
      console.log('label for audit.exported differs; options:', await omar.getByLabel('Did what').locator('option').allInnerTexts());
    });
    await omar.waitForTimeout(800);
    await shot(omar, '11-export-row');

    // ---- (d) Priya
    priya = await signIn(browser, 'priya');
    const priyaApi = apiOf(priya);
    await priya.goto('/settings/team/engineering/roster');
    await priya.waitForTimeout(1200);
    const priyaNav = (await priya.locator('body').innerText()).replace(/\s+/g, ' ');
    console.log('Priya sees an "Audit" nav item:', /\bAudit\b/.test(priyaNav), '| sees a Workspace group:', /\bSystem health\b/.test(priyaNav));
    expect(priyaNav).not.toMatch(/\bAudit\b/);
    await shot(priya, '12-priya-settings-no-audit-nav');
    await priya.goto('/settings/workspace/audit');
    await priya.waitForTimeout(1500);
    console.log('Priya on /settings/workspace/audit says:', (await priya.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 240));
    await shot(priya, '13-priya-audit-url-refused');
    const g = await priyaApi.get('/api/admin/audit');
    const p = await priyaApi.post('/api/admin/audit/export', {});
    const k = await priyaApi.get('/api/admin/audit/signing-key');
    console.log('Priya GET audit / POST export / GET signing-key:', g.status, p.status, k.status);
    expect([g.status, p.status, k.status]).toEqual([403, 403, 403]);

    // ---- (e) the phone
    phone = await signIn(browser, 'omar', true);
    await phone.goto('/settings/workspace/audit');
    await expect(phone.locator('.audit-row').first()).toBeVisible(T);
    const noScroll = await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
    console.log('phone no sideways scroll:', noScroll);
    const phoneDims = await phone.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      table: getComputedStyle(document.querySelector('.audit-row')!).display,
      overflowing: Array.from(document.querySelectorAll('.audit-page *')).filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1).length,
    }));
    console.log('phone dims:', JSON.stringify(phoneDims));
    await shot(phone, '14-phone-audit-top');
    await phone.locator('.audit-results').scrollIntoViewIfNeeded();
    await phone.evaluate(() => window.scrollBy(0, 0));
    await shot(phone, '15-phone-audit-cards');
    await phone.getByLabel('Outcome').selectOption({ label: 'Withheld' });
    await expect(phone.locator('.audit-row[data-outcome="withheld"]').first()).toBeVisible(T);
    await phone.waitForTimeout(800);
    await phone.locator('.audit-results').scrollIntoViewIfNeeded();
    await shot(phone, '16-phone-withheld-cards');
    await phone.getByLabel('Outcome').selectOption({ label: 'Refused' });
    await phone.waitForTimeout(1000);
    await phone.locator('.audit-results').scrollIntoViewIfNeeded();
    await shot(phone, '17-phone-refused-cards');
    await phone.getByLabel('Outcome').selectOption({ label: 'Any outcome' });
    await phone.waitForTimeout(800);
    await phone.getByTestId('audit-export').click();
    await expect(phone.getByTestId('audit-export-done')).toBeVisible({ timeout: 60_000 });
    await phone.getByText('How to check the file').click();
    const exportScroll = await phone.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
    console.log('phone after export, scrollWidth vs width:', JSON.stringify(exportScroll));
    await phone.getByTestId('audit-export-done').scrollIntoViewIfNeeded();
    await shot(phone, '18-phone-export-done');
    expect(noScroll).toBe(true);
    await phone.context().close();
    phone = null;
  } finally {
    console.log('withdrawn after:', await withdrawMine(omarApi).catch((e: unknown) => `cleanup failed: ${String(e)}`));
    rmSync(work, { recursive: true, force: true });
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
