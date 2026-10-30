import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';

/**
 * P7-01 (Proposals) on the live site. Everything written is a throwaway: a bot `verify-p7-01` that Omar (workspace admin) adds through a proposal, changes
 * through the bot editor and removes again, plus a few open proposals whose title starts with "[verify P7-01]". None of the real bots is touched. The
 * run sweeps what an aborted run left (first and last): open proposals are withdrawn or declined and the scratch bot is removed by a proposal.
 * Applied proposals stay on record (that is the point of the feature), and so do their commits in the team repo.
 * Omar: roster, Files (read-only, the dialog), the bot editor -> Save as proposal -> Proposals -> Apply, a BOT.md that does not load, a stale proposal.
 * Priya (a member who does not lead Engineering): the same direct write is refused and she sees why; she can propose but not apply.
 * Output: <MANYTHREADS_TASK_SHOTS_DIR>/p7-01-*.png (default temp/screenshots).
 */
const BASE = (process.env['MANYTHREADS_LIVE_URL'] ?? 'https://manythreads.kahf.to').replace(/\/+$/, '');
const PASSWORD = process.env['MANYTHREADS_LIVE_PASSWORD'] ?? '';
const OUT = process.env['MANYTHREADS_TASK_SHOTS_DIR'] ?? join(import.meta.dirname, '..', '..', 'temp', 'screenshots');
const T = { timeout: 20_000 };
const TAG = '[verify P7-01]';
const TEAM = 'engineering';
const SLUG = 'verify-p7-01';
const BOT_PATH = `bots/${SLUG}/BOT.md`;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const GOOD_BOT = [
  '---',
  'schema: 1',
  `name: "${TAG} scratch"`,
  'role: A throwaway bot that a verification run adds and removes again.',
  'kind: agent',
  'runtime: hermes',
  'visibility: team',
  '---',
  '',
  `# ${TAG} scratch`,
  '',
  'You do nothing. This bot exists for one verification run and is removed in the same run.',
  '',
].join('\n');
const BROKEN_BOT = '---\nname: Broken\n---\n';

type Api = {
  get: (path: string) => Promise<{ status: number; text: string; json: unknown }>;
  post: (path: string, data?: unknown) => Promise<{ status: number; text: string; json: unknown }>;
};

async function signIn(browser: Browser, who: string, phone = false): Promise<Page> {
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
  await page.goto(`/t/${TEAM}/threads`);
  await expect(page.getByTestId('app-frame')).toBeVisible(T);
  return page;
}

function apiOf(page: Page): Api {
  const call = async (method: 'GET' | 'POST', path: string, data?: unknown): Promise<{ status: number; text: string; json: unknown }> => {
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

type Brief = { id: string; status: string; title: string; path: string; authorName: string };
type DetailJson = { proposal: { proposal: Brief & { checks: { name: string; ok: boolean; message: string }[] }; stale: boolean; canApply: boolean; cannotApplyReason: string | null } };

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, `p7-01-${name}.png`), animations: 'disabled' });
}

async function openProposals(api: Api): Promise<Brief[]> {
  const res = await api.get(`/api/teams/${TEAM}/proposals?status=open&limit=200`);
  return ((res.json as { proposals?: Brief[] } | null)?.proposals ?? []).filter((p) => p.title.startsWith(TAG) || p.path.includes(SLUG));
}

async function blobOf(api: Api, path: string): Promise<{ content: string; blobSha: string } | null> {
  const res = await api.get(`/api/teams/${TEAM}/repo/blob?path=${encodeURIComponent(path)}`);
  return res.status === 200 ? (res.json as { content: string; blobSha: string }) : null;
}

async function botStatus(api: Api, slug: string): Promise<string | null> {
  const res = await api.get(`/api/teams/${TEAM}/bots`);
  const bots = (res.json as { bots?: { slug: string; status: string }[] } | null)?.bots ?? [];
  return bots.find((b) => b.slug === slug)?.status ?? null;
}

/** Withdraws or declines every open proposal of the run, and removes the scratch bot by a proposal if it is still in the repo. */
async function sweep(api: Api): Promise<string> {
  const notes: string[] = [];
  for (const p of await openProposals(api)) {
    let r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/withdraw`);
    if (r.status >= 400) r = await api.post(`/api/teams/${TEAM}/proposals/${p.id}/reject`, { note: 'verification run cleanup' });
    notes.push(`${p.id.slice(0, 8)} -> ${r.status}`);
  }
  if (await blobOf(api, BOT_PATH)) {
    const r = await api.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, op: 'delete', title: `${TAG} remove the scratch bot`, applyNow: true });
    notes.push(`remove scratch bot -> ${r.status}`);
  }
  return notes.join('; ') || 'nothing to sweep';
}

async function waitForBot(api: Api, present: boolean): Promise<string | null> {
  let s: string | null = null;
  for (let i = 0; i < 40; i++) {
    s = await botStatus(api, SLUG);
    if (present ? s === 'active' : s === null) return s;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
}

test.describe.configure({ retries: 0, mode: 'serial' });
test.setTimeout(420_000);

test('Omar and Priya: propose, check, apply, refuse, stale, read-only, phone', async ({ browser }) => {
  const omar = await signIn(browser, 'omar');
  const omarApi = apiOf(omar);
  let priya: Page | null = null;
  let phone: Page | null = null;
  console.log('swept before:', await sweep(omarApi));
  try {
    // ---- health: the roster of both teams has every bot loaded
    for (const team of ['engineering', 'delivery']) {
      const res = await omarApi.get(`/api/teams/${team}/bots`);
      const bots = (res.json as { bots?: { slug: string; status: string }[] } | null)?.bots ?? [];
      console.log(`${team} bots:`, res.status, bots.map((b) => `${b.slug}=${b.status}`).join(', '));
    }

    // ---- (a) the roster with the proposals link, Files read-only and the dialog
    await omar.goto(`/t/${TEAM}/bots`);
    await expect(omar.getByTestId('roster-proposals')).toBeVisible(T);
    console.log('roster link:', await omar.getByTestId('roster-proposals').innerText());
    await shot(omar, '01-roster-proposals-link');

    await omar.goto(`/t/${TEAM}/files?path=bots`);
    await expect(omar.getByTestId('read-only-note')).toContainText('Change by proposal', T);
    await shot(omar, '02-files-bots-read-only');
    await omar.goto(`/t/${TEAM}/files?open=TEAM.md`);
    const teamView = omar.getByTestId('file-view');
    await expect(teamView.getByTestId('read-only-note')).toContainText('Change by proposal', T);
    await expect(teamView.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await shot(omar, '03-team-md-read-only');
    await teamView.getByTestId('change-by-pr').click();
    const teamDlg = omar.getByTestId('dialog-propose');
    await expect(teamDlg).toBeVisible(T);
    const teamText = teamDlg.getByTestId('propose-text');
    await expect(teamText).not.toHaveValue('');
    await teamText.fill(`${(await teamText.inputValue()).trimEnd()}\n\n<!-- ${TAG} nothing is sent -->\n`);
    await expect(teamDlg.getByTestId('propose-preview')).toContainText('added');
    await shot(omar, '04-propose-dialog-team-md-preview');
    await teamDlg.getByRole('button', { name: 'Cancel' }).click();
    await expect(teamDlg).toHaveCount(0);

    // a direct write is refused for everybody, a lead and admin included
    const direct = await omarApi.post(`/api/teams/${TEAM}/repo/commit`, { changes: [{ op: 'put', path: BOT_PATH, content: GOOD_BOT, encoding: 'utf8' }], message: `${TAG} direct` });
    console.log('omar direct write:', direct.status, direct.text.slice(0, 240));
    expect(direct.status).toBe(403);
    expect(await blobOf(omarApi, BOT_PATH)).toBeNull();

    // the throwaway bot is added by a proposal (Propose a file, then Propose and apply: an admin adds a bot)
    await omar.goto(`/t/${TEAM}/files?path=bots`);
    await omar.getByTestId('propose-new-file').click();
    const newDlg = omar.getByTestId('dialog-propose');
    await newDlg.getByTestId('propose-path').fill(BOT_PATH);
    await newDlg.getByTestId('propose-text').fill(GOOD_BOT);
    await newDlg.getByTestId('propose-title').fill(`${TAG} add the scratch bot`);
    await expect(newDlg.getByTestId('propose-preview')).toContainText('added', T);
    await shot(omar, '05-propose-a-file-new-bot');
    await newDlg.getByTestId('propose-apply').click();
    await expect(omar.getByTestId('propose-done-text')).toContainText('proposal', T);
    await shot(omar, '06-new-bot-applied-checks');
    await omar.getByRole('button', { name: 'Done' }).click();
    console.log('scratch bot after add:', await waitForBot(omarApi, true));
    await omar.goto(`/t/${TEAM}/bots`);
    await expect(omar.locator(`[data-testid="bot-row"][data-bot="${SLUG}"]`)).toBeVisible(T);
    await shot(omar, '07-roster-with-scratch-bot');

    // the bot editor: change the behaviour, Save as proposal, read it on the Proposals page, Apply
    await omar.goto(`/t/${TEAM}/bots/${SLUG}`);
    await expect(omar.getByTestId('bot-page')).toBeVisible(T);
    await omar.getByTestId('tab-behaviour').click();
    const body = omar.getByTestId('bot-body');
    await body.fill(`${(await body.inputValue()).trimEnd()}\n\n<!-- ${TAG} a trailing comment line -->\n`);
    await shot(omar, '08-bot-editor-edited');
    await omar.getByTestId('propose-bot').click();
    await expect(omar.getByTestId('save-notice')).toContainText('Proposal saved', T);
    await shot(omar, '09-bot-editor-saved-as-proposal');
    await omar.goto(`/t/${TEAM}/bots`);
    await expect(omar.getByTestId('roster-proposals')).toContainText('1 waiting', T);
    console.log('roster link with a proposal waiting:', await omar.getByTestId('roster-proposals').innerText());
    await shot(omar, '09b-roster-proposals-count');
    await omar.locator(`[data-testid="bot-row"][data-bot="${SLUG}"]`).scrollIntoViewIfNeeded();
    await shot(omar, '09c-roster-scratch-bot-row');
    console.log('orchestrator BOT.md in repo:', (await blobOf(omarApi, 'bots/orchestrator/BOT.md')) !== null);
    await omar.goto(`/t/${TEAM}/proposals`);
    await expect(omar.getByTestId('proposal-row').filter({ hasText: SLUG }).first()).toBeVisible(T);
    await shot(omar, '10-proposals-list-waiting');
    await omar.getByTestId('proposal-row').filter({ hasText: SLUG }).first().click();
    await expect(omar.getByTestId('proposal-diff')).toContainText('a trailing comment line', T);
    await expect(omar.getByTestId('proposal-checks')).toContainText('BOT.md loads');
    await shot(omar, '11-proposal-diff-and-checks');
    await omar.getByTestId('proposal-apply').click();
    await expect(omar.getByTestId('proposal-status')).toHaveAttribute('data-status', 'applied', T);
    await shot(omar, '12-proposal-applied');
    const afterApply = await blobOf(omarApi, BOT_PATH);
    expect(afterApply?.content).toContain('a trailing comment line');
    console.log('scratch bot after apply:', await waitForBot(omarApi, true));

    // ---- (b) a BOT.md that does not parse: the loader's text, no Apply
    await omar.goto(`/t/${TEAM}/files?open=${encodeURIComponent(BOT_PATH)}`);
    const botView = omar.getByTestId('file-view');
    await expect(botView.getByTestId('read-only-note')).toContainText('Change by proposal', T);
    await botView.getByTestId('change-by-pr').click();
    const brokenDlg = omar.getByTestId('dialog-propose');
    await brokenDlg.getByTestId('propose-text').fill(BROKEN_BOT);
    await brokenDlg.getByTestId('propose-title').fill(`${TAG} a BOT.md that does not parse`);
    await brokenDlg.getByTestId('propose-save').click();
    await expect(omar.getByTestId('propose-done-text')).toBeVisible(T);
    await shot(omar, '13-broken-bot-md-checks-in-dialog');
    await omar.getByTestId('propose-open').click();
    await expect(omar.getByTestId('proposal-check-failed')).toBeVisible(T);
    await expect(omar.getByTestId('proposal-apply')).toHaveCount(0);
    console.log('broken checks:', (await omar.getByTestId('proposal-checks').innerText()).replace(/\s+/g, ' ').slice(0, 400));
    await shot(omar, '14-broken-bot-md-cannot-apply');
    const brokenId = omar.url().split('/').pop() ?? '';
    const brokenApply = await omarApi.post(`/api/teams/${TEAM}/proposals/${brokenId}/approve`, {});
    console.log('broken approve:', brokenApply.status, brokenApply.text.slice(0, 300));
    expect(brokenApply.status).toBe(422);
    expect(brokenApply.text).toContain('BOT.md loads');
    expect((await blobOf(omarApi, BOT_PATH))?.blobSha).toBe(afterApply?.blobSha);
    await omar.getByTestId('proposal-withdraw').click();
    await expect(omar.getByTestId('proposal-status')).toHaveAttribute('data-status', 'withdrawn', T);
    await shot(omar, '15-broken-proposal-withdrawn');

    // ---- (d) a stale proposal: the file changes between creating and applying
    const base = await blobOf(omarApi, BOT_PATH);
    if (!base) throw new Error('the scratch bot file is missing');
    const first = await omarApi.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, content: `${base.content.trimEnd()}\n\n<!-- ${TAG} proposed first -->\n`, baseBlobSha: base.blobSha, title: `${TAG} will go stale` });
    expect(first.status, first.text).toBe(201);
    const staleId = (first.json as DetailJson).proposal.proposal.id;
    const moved = await omarApi.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, content: `${base.content.trimEnd()}\n\n<!-- ${TAG} the file moved -->\n`, baseBlobSha: base.blobSha, title: `${TAG} moves the file`, applyNow: true });
    expect(moved.status, moved.text).toBe(201);
    await omar.goto(`/t/${TEAM}/proposals/${staleId}`);
    await expect(omar.getByTestId('proposal-stale')).toBeVisible(T);
    await expect(omar.getByTestId('proposal-apply')).toHaveCount(0);
    console.log('stale reason:', await omar.getByTestId('proposal-stale').innerText());
    await shot(omar, '16-stale-proposal-refused');
    const staleApply = await omarApi.post(`/api/teams/${TEAM}/proposals/${staleId}/approve`, {});
    console.log('stale approve:', staleApply.status, staleApply.text.slice(0, 300));
    expect(staleApply.status).toBe(409);
    const afterMove = await blobOf(omarApi, BOT_PATH);
    expect(afterMove?.content).toContain('the file moved');
    expect(afterMove?.content).not.toContain('proposed first');
    await omar.getByTestId('proposal-withdraw').click();
    await expect(omar.getByTestId('proposal-status')).toHaveAttribute('data-status', 'withdrawn', T);

    // ---- (e) Priya: a member who does not lead Engineering
    priya = await signIn(browser, 'priya');
    const priyaApi = apiOf(priya);
    await priya.goto(`/t/${TEAM}/files?path=bots/${SLUG}`);
    await expect(priya.getByTestId('read-only-note')).toContainText('Change by proposal', T);
    await shot(priya, '17-priya-bots-folder-read-only');
    const priyaDirect = await priyaApi.post(`/api/teams/${TEAM}/repo/commit`, { changes: [{ op: 'put', path: BOT_PATH, content: GOOD_BOT, encoding: 'utf8' }], message: `${TAG} direct from a member` });
    console.log('priya direct write:', priyaDirect.status, priyaDirect.text.slice(0, 240));
    expect(priyaDirect.status).toBe(403);
    await priya.goto(`/t/${TEAM}/files?open=${encodeURIComponent(BOT_PATH)}`);
    const pView = priya.getByTestId('file-view');
    await expect(pView.getByTestId('read-only-note')).toContainText('Change by proposal', T);
    await expect(pView.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await shot(priya, '18-priya-bot-md-read-only');
    await pView.getByTestId('change-by-pr').click();
    const pDlg = priya.getByTestId('dialog-propose');
    await expect(pDlg.getByTestId('propose-apply')).toHaveCount(0);
    const pText = pDlg.getByTestId('propose-text');
    await expect(pText).not.toHaveValue('');
    await pText.fill(`${(await pText.inputValue()).trimEnd()}\n\n<!-- ${TAG} from a member -->\n`);
    await pDlg.getByTestId('propose-title').fill(`${TAG} proposed by a member`);
    await shot(priya, '19-priya-propose-dialog-save-only');
    await pDlg.getByTestId('propose-save').click();
    await expect(priya.getByTestId('propose-done-text')).toContainText('Nothing changes until then', T);
    await priya.getByTestId('propose-open').click();
    await expect(priya.getByTestId('proposal-diff')).toContainText('from a member', T);
    await expect(priya.getByTestId('proposal-apply')).toHaveCount(0);
    console.log('priya cannot apply:', await priya.getByTestId('proposal-cannot-apply').innerText().catch(() => '(no reason shown)'));
    await shot(priya, '20-priya-proposal-cannot-apply');
    const priyaId = priya.url().split('/').pop() ?? '';
    const priyaApply = await priyaApi.post(`/api/teams/${TEAM}/proposals/${priyaId}/approve`, {});
    console.log('priya approve:', priyaApply.status, priyaApply.text.slice(0, 240));
    expect(priyaApply.status).toBe(403);
    const lead = await priyaApi.get(`/api/teams/${TEAM}/proposals/${priyaId}`);
    console.log('priya canApply:', (lead.json as { proposal?: { canApply?: boolean } } | null)?.proposal?.canApply);

    // ---- the phone: the Proposals page with Priya's proposal waiting
    phone = await signIn(browser, 'omar', true);
    await phone.goto(`/t/${TEAM}/proposals`);
    await expect(phone.getByTestId('proposal-row').first()).toBeVisible(T);
    await shot(phone, '21-phone-proposals-list');
    await phone.getByTestId('proposal-row').filter({ hasText: 'proposed by a member' }).first().click();
    await expect(phone.getByTestId('proposal-diff')).toBeVisible(T);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await shot(phone, '22-phone-proposal');
    await phone.context().close();
    phone = null;

    // ---- cleanup: Omar declines Priya's proposal, the scratch bot goes by a proposal Omar applies
    await omar.goto(`/t/${TEAM}/proposals/${priyaId}`);
    await omar.getByTestId('proposal-reject').click();
    await expect(omar.getByTestId('proposal-status')).toHaveAttribute('data-status', 'rejected', T);
    const del = await omarApi.post(`/api/teams/${TEAM}/proposals`, { path: BOT_PATH, op: 'delete', title: `${TAG} remove the scratch bot` });
    expect(del.status, del.text).toBe(201);
    const delId = (del.json as DetailJson).proposal.proposal.id;
    await omar.goto(`/t/${TEAM}/proposals/${delId}`);
    await expect(omar.getByTestId('proposal-apply')).toBeVisible(T);
    await shot(omar, '23-remove-scratch-bot-proposal');
    await omar.getByTestId('proposal-apply').click();
    await expect(omar.getByTestId('proposal-status')).toHaveAttribute('data-status', 'applied', T);
    console.log('scratch bot after removal:', await waitForBot(omarApi, false));
    await omar.goto(`/t/${TEAM}/bots`);
    await expect(omar.locator(`[data-testid="bot-row"][data-bot="${SLUG}"]`)).toHaveCount(0);
    await shot(omar, '24-roster-after-cleanup');
    await omar.goto(`/t/${TEAM}/proposals`);
    await omar.getByTestId('proposals-filter-all').click();
    await shot(omar, '25-proposals-all-after-cleanup');
  } finally {
    console.log('swept after:', await sweep(omarApi).catch((e: unknown) => `sweep failed: ${String(e)}`));
    console.log('open proposals left:', (await openProposals(omarApi).catch(() => [])).length, '| scratch file left:', (await blobOf(omarApi, BOT_PATH).catch(() => null)) !== null);
    await phone?.context().close();
    await priya?.context().close();
    await omar.context().close();
  }
});
