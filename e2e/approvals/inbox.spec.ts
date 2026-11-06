import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, postAs } from '../support/stack-browser.ts';
import { APPROVALS_STACK_ENV, arrangeApprovals, rowOfApproval, type ArrangedApproval } from './support.ts';

/*
 * The Approvals inbox and the card in a thread (PLAN P5-20, SPEC §7.3). Four approvals wait in Engineering for `coder`'s `pages.write`; the people named
 * to decide are the holders of `role:on-call` (Rafi). Nadia asked for three of them and holds a different tag; Rafi asked for the fourth. What the spec
 * pins: the sidebar count and the inbox agree; the person who asked sees a sentence where the buttons would be, in the inbox and in the thread; a person
 * outside the approver scope sees who may decide; the routes refuse with 403 whatever the screen shows; approving makes the stopped call once, as the
 * bot, and the card says so; denying makes nothing; a second decision is refused.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let approve: ArrangedApproval;
let deny: ArrangedApproval;
let inThread: ArrangedApproval;
let own: ArrangedApproval;
let rootId = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...APPROVALS_STACK_ENV });
  // a real thread for the card: a message in #dev with a reply
  const nadia = await apiOn(playwright, stack, 'nadia');
  const dev = (await channelsOf(nadia))['dev']!;
  rootId = (await postAs(nadia, dev, 'Please publish the release notes page.')).id;
  await postAs(nadia, dev, 'The bot will ask first.', rootId);
  [approve, deny, inThread, own] = await arrangeApprovals(stack, [
    { path: 'pages/e2e-approved.md', requester: 'nadia' },
    { path: 'pages/e2e-denied.md', requester: 'nadia' },
    { path: 'pages/e2e-in-thread.md', requester: 'nadia', channelId: dev, threadRootId: rootId },
    { path: 'pages/e2e-own.md', requester: 'rafi' },
  ]) as [ArrangedApproval, ArrangedApproval, ArrangedApproval, ArrangedApproval];
  await nadia.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

const card = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-testid="approval-card"][data-approval="${id}"]`);

test('the sidebar counts what waits and the Approvals entry opens the inbox with the same number', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/');
  try {
    const entry = page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Approvals/ });
    await expect(entry).toContainText('4');
    await entry.click();
    await expect(page).toHaveURL(/\/t\/engineering\/approvals/);
    await expect(page.getByTestId('approvals-inbox')).toBeVisible();
    await expect(page.getByTestId('approvals-count')).toHaveText('4 waiting');
    await expect(page.getByTestId('approval-row')).toHaveCount(4);
    // a plain list (buttons inside listbox options were unreachable): a named list of items, no listbox
    await expect(page.getByRole('list', { name: 'Waiting approvals' }).getByRole('listitem')).toHaveCount(4);
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(page.getByRole('option')).toHaveCount(0);
    // oldest first, each row says in one sentence who asked and what for
    await expect(page.getByTestId('approval-row').first()).toContainText(/Nadia asked .+ to create the page pages\/e2e-approved\.md/);
    await expect(page.getByTestId('approval-row').first().getByTestId('approval-row-approve')).toHaveCount(1);
    await expect(page.getByTestId('approval-row').nth(3)).toContainText(/Rafi asked .+ to create the page pages\/e2e-own\.md/);
    // Rafi asked for the last one, so no buttons on it
    await expect(page.getByTestId('approval-row').nth(3).getByTestId('approval-row-approve')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("a waiting row shows the asker's picture, one sentence and a risk tag", async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals');
  try {
    const row = page.locator(`[data-testid="approval-row"][data-approval="${approve.id}"]`);
    await expect(row).toBeVisible();
    // the picture of the person who asked (initials here: the seeded personas have no photo) is the first thing in the row
    await expect(row.locator('.av').first()).toBeVisible();
    await expect(row.getByTestId('approval-row-sentence')).toContainText('Nadia asked');
    // a tool flagged needs-approval is amber and says so in words
    await expect(row.getByTestId('approval-row-risk')).toHaveText('Needs approval');
    await expect(row.getByTestId('approval-row-risk')).toHaveClass(/warn/);
    // a request under a day old has a plain, not amber, age pill
    await expect(row.getByTestId('approval-age')).toContainText('Waiting');
    await expect(row.getByTestId('approval-age')).toHaveAttribute('data-overdue', 'false');
    // the detail says the same in its header
    const open = row.locator('.apr-trow');
    // on a wide screen the first request is already open: open another one first, so the mark has to move
    await page.locator(`[data-testid="approval-row"]:not([data-approval="${approve.id}"]) .apr-trow`).first().click();
    await expect(open).not.toHaveAttribute('aria-current', 'true');
    await open.click();
    // the open row is marked for a screen reader, and only that one
    await expect(open).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('[data-testid="approval-row"] [aria-current="true"]')).toHaveCount(1);
    const c = card(page, approve.id);
    await expect(c.getByTestId('approval-sentence')).toContainText('Nadia asked');
    await expect(c.getByTestId('approval-source')).toHaveText('Needs approval');
    await expect(c.locator('.apr-head').getByTestId('approval-approve')).toBeVisible();
    await expect(c.locator('.apr-head').getByTestId('approval-deny')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the person who asked cannot approve their own, even in the thread; someone outside the scope sees who can', async ({ browser, playwright }) => {
  // Rafi asked for the last one: the buttons are gone and the sentence says why
  const rafi = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/approvals?approval=${own.id}`);
  try {
    await expect(card(rafi.page, own.id)).toBeVisible();
    await expect(card(rafi.page, own.id).getByTestId('approval-requester')).toHaveText('Rafi');
    await expect(card(rafi.page, own.id).getByTestId('approval-blocked')).toHaveText('You asked for this, so someone else has to decide it.');
    await expect(card(rafi.page, own.id).getByTestId('approval-approve')).toHaveCount(0);
    await expect(card(rafi.page, own.id).getByTestId('approval-deny')).toHaveCount(0);
  } finally {
    await rafi.context.close();
  }
  // Nadia asked for the first three: the same, whatever tag she holds
  const nadia = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/approvals?approval=${approve.id}`);
  try {
    await expect(card(nadia.page, approve.id).getByTestId('approval-blocked')).toHaveAttribute('data-reason', 'requester');
    await expect(card(nadia.page, approve.id).getByTestId('approval-approve')).toHaveCount(0);
  } finally {
    await nadia.context.close();
  }
  // Priya is on the team but not an approver: she sees who may decide
  const priya = await openOn(browser, playwright, stack, 'priya', `/t/engineering/approvals?approval=${approve.id}`);
  try {
    await expect(card(priya.page, approve.id).getByTestId('approval-blocked')).toHaveText('Waiting for role:on-call.');
    await expect(card(priya.page, approve.id).getByTestId('approval-blocked')).toHaveAttribute('data-reason', 'not_approver');
    await expect(card(priya.page, approve.id).getByTestId('approval-approve')).toHaveCount(0);
  } finally {
    await priya.context.close();
  }
  // The routes refuse whatever the screen offers
  const refusals: Array<[Parameters<typeof apiOn>[2], string]> = [['rafi', own.id], ['nadia', approve.id], ['priya', approve.id], ['omar', approve.id]];
  for (const [who, id] of refusals) {
    const api = await apiOn(playwright, stack, who);
    for (const verb of ['approve', 'deny']) {
      expect(await api.status('POST', `/api/teams/engineering/approvals/${id}/${verb}`, { note: '' }), `${who} ${verb}`).toBe(403);
    }
    await api.ctx.dispose();
  }
  expect((await rowOfApproval(stack, own.id))?.status).toBe('pending');
  expect((await rowOfApproval(stack, approve.id))?.status).toBe('pending');
});

test('approving runs the stopped call once, as the bot, and the card says what happened', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/approvals?approval=${approve.id}`);
  try {
    const c = card(page, approve.id);
    await expect(c.getByTestId('approval-summary')).toHaveText('pages.write · pages/e2e-approved.md');
    await expect(c.getByTestId('approval-requester')).toHaveText('Nadia');
    await expect(c.getByTestId('approval-preview')).toContainText('pages/e2e-approved.md');
    await c.getByTestId('approval-note').fill('release notes are fine');
    await c.getByTestId('approval-approve').click();

    await expect(c.getByTestId('approval-state')).toContainText('Approved by Rafi');
    await expect(c.getByTestId('approval-state')).toContainText('release notes are fine');
    await expect(c.getByTestId('approval-outcome')).toContainText('The call ran once, as the bot', { timeout: 30_000 });
    await expect(c).toHaveAttribute('data-outcome', 'ran');

    // the page exists, written by the bot, once
    const api = await apiOn(playwright, stack, 'omar');
    const blob = await api.get<{ content: string }>('/api/teams/engineering/repo/blob?path=pages%2Fe2e-approved.md');
    expect(blob.content).toBe('Written after approval: pages/e2e-approved.md');
    const commits = await stack.sql<{ author_id: string | null; paths: string[] }>(`SELECT author_id, paths FROM app.repo_commits WHERE 'pages/e2e-approved.md' = ANY (paths)`);
    expect(commits).toHaveLength(1);
    const botActor = (await stack.sql<{ id: string }>(`SELECT a.id FROM app.actors a JOIN app.bots b ON b.id = a.ref_id AND a.kind = 'bot' WHERE b.slug = 'coder'`))[0]!.id;
    expect(commits[0]!.author_id).toBe(botActor);
    // final: the second decision, either way, is refused
    const rafi = await apiOn(playwright, stack, 'rafi');
    expect(await rafi.status('POST', `/api/teams/engineering/approvals/${approve.id}/deny`, { note: '' })).toBe(409);
    await rafi.ctx.dispose();
    await api.ctx.dispose();

    // the count went down, and the settled one is in the history
    await expect(page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Approvals/ })).toContainText('3');
    await page.getByTestId('approvals-tab-decided').click();
    await expect(page.getByTestId('approval-row')).toHaveCount(1);
    await expect(page.getByTestId('approval-row').first()).toContainText('approved by Rafi');
  } finally {
    await context.close();
  }
});

test('denying settles it with a note and makes nothing', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/approvals?approval=${deny.id}`);
  try {
    const c = card(page, deny.id);
    await c.getByTestId('approval-note').fill('not this week');
    await c.getByTestId('approval-deny').click();
    await expect(c.getByTestId('approval-state')).toContainText('Denied by Rafi');
    await expect(c.getByTestId('approval-state')).toContainText('not this week');
    await expect(c.getByTestId('approval-outcome')).toContainText('The call was not made');
    expect(await rowOfApproval(stack, deny.id)).toMatchObject({ status: 'denied', outcome: 'none' });
    // no call was queued behind the denial: the row says so (outcome none) and the page was never written
    const api = await apiOn(playwright, stack, 'omar');
    expect(await api.status('GET', '/api/teams/engineering/repo/blob?path=pages%2Fe2e-denied.md')).toBe(404);
    await api.ctx.dispose();
    await page.getByTestId('approvals-tab-decided').click();
    await expect(page.getByTestId('approval-row')).toHaveCount(2);
  } finally {
    await context.close();
  }
});

test('the card sits in the thread the run answered in: the asker reads the question, an approver answers it there', async ({ browser, playwright }) => {
  const asker = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/threads?thread=${rootId}`);
  try {
    const c = card(asker.page, inThread.id);
    await expect(asker.page.getByTestId('thread-approvals')).toBeVisible();
    await expect(c.getByTestId('approval-summary')).toHaveText('pages.write · pages/e2e-in-thread.md');
    await expect(c.getByTestId('approval-blocked')).toContainText('You asked for this');
  } finally {
    await asker.context.close();
  }
  const approver = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/threads?thread=${rootId}`);
  try {
    const c = card(approver.page, inThread.id);
    await expect(c.getByTestId('approval-approve')).toBeVisible();
    await c.getByTestId('approval-approve').click();
    await expect(c.getByTestId('approval-state')).toContainText('Approved by Rafi');
    await expect(c.getByTestId('approval-outcome')).toContainText('The call ran once, as the bot', { timeout: 30_000 });
  } finally {
    await approver.context.close();
  }
  // a person who is not on the team sees no card in a thread they cannot read
  const outsider = await apiOn(playwright, stack, 'sameera');
  const res = await outsider.ctx.get(`/api/threads/${rootId}/approvals`);
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { items: unknown[] }).items).toEqual([]);
  await outsider.ctx.dispose();
});

test('a call too long for its preview says so, and cannot be approved before the whole call has been opened', async ({ browser, playwright }) => {
  const [long] = await arrangeApprovals(stack, [{ path: 'pages/e2e-long.md', requester: 'nadia', longContent: true }]);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/approvals?approval=${long!.id}`);
  try {
    const c = card(page, long!.id);
    await expect(c.getByTestId('approval-truncated')).toContainText('cut short');
    await expect(c.getByTestId('approval-approve')).toBeDisabled();
    await expect(c.getByTestId('approval-preview')).not.toContainText('END-OF-PAGE');
    await c.getByTestId('approval-open-full').click();
    await expect(c.getByTestId('approval-full')).toContainText('END-OF-PAGE');
    await expect(c.getByTestId('approval-approve')).toBeEnabled();
    // the requester cannot open the full call
    const nadia = await apiOn(playwright, stack, 'nadia');
    expect(await nadia.status('GET', `/api/teams/engineering/approvals/${long!.id}/args`)).toBe(403);
    await nadia.ctx.dispose();
    await c.getByTestId('approval-deny').click();
    await expect(c.getByTestId('approval-state')).toContainText('Denied by Rafi');
  } finally {
    await context.close();
  }
});

const rowOf = (page: import('@playwright/test').Page, id: string) => page.locator(`[data-testid="approval-row"][data-approval="${id}"]`);

test('approve from the row without opening it', async ({ browser, playwright }) => {
  const [fresh] = await arrangeApprovals(stack, [{ path: 'pages/e2e-from-row.md', requester: 'nadia' }]);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals');
  try {
    const row = rowOf(page, fresh!.id);
    const actions = row.getByRole('group', { name: 'Decide' });
    // at rest the buttons are drawn but transparent; the pointer on the row or focus inside it shows them
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(row.getByTestId('approval-row-approve')).toBeVisible();
    await expect(row.getByTestId('approval-row-deny')).toBeVisible();
    // each button names the request it decides, not only "Approve"
    await expect(row.getByTestId('approval-row-approve')).toHaveAttribute('aria-label', /^Approve: Nadia asked .+ pages\/e2e-from-row\.md$/);
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS('opacity', '0');
    await row.locator('.apr-trow').focus();
    await expect(actions).toHaveCSS('opacity', '1');
    await row.hover();
    await row.getByTestId('approval-row-approve').click();
    // it leaves Waiting and the stopped call is made, once, as the bot
    await expect(rowOf(page, fresh!.id)).toHaveCount(0);
    await expect.poll(async () => (await rowOfApproval(stack, fresh!.id))?.status).toBe('approved');
    await expect.poll(async () => (await rowOfApproval(stack, fresh!.id))?.outcome, { timeout: 30_000 }).toBe('ran');
  } finally {
    await context.close();
  }
});

test('a request older than a day has an amber age pill and the sidebar badge turns amber', async ({ browser, playwright }) => {
  const [old] = await arrangeApprovals(stack, [{ path: 'pages/e2e-old.md', requester: 'nadia' }]);
  const [young] = await arrangeApprovals(stack, [{ path: 'pages/e2e-young.md', requester: 'nadia' }]);
  const sidebarBadge = (page: import('@playwright/test').Page) => page.locator('[data-landmark="sidebar"]').getByRole('link', { name: /Approvals/ }).locator('.pill');
  // before anything is old, the badge is the quiet grey one
  const before = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals');
  try {
    await expect(rowOf(before.page, young!.id)).toBeVisible();
    await expect(sidebarBadge(before.page)).not.toHaveClass(/attention/);
  } finally {
    await before.context.close();
  }
  await stack.sql(`UPDATE app.approvals SET created_at = now() - interval '30 hours' WHERE id = $1`, [old!.id]);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals');
  try {
    const pill = rowOf(page, old!.id).getByTestId('approval-age');
    await expect(pill).toHaveText('Waiting 1 day');
    await expect(pill).toHaveAttribute('data-overdue', 'true');
    await expect(pill).toHaveClass(/overdue/);
    await expect(rowOf(page, young!.id).getByTestId('approval-age')).toHaveAttribute('data-overdue', 'false');
    // the oldest waits at the top
    await expect(page.getByTestId('approval-row').first()).toHaveAttribute('data-approval', old!.id);
    // the badge keeps its number, turns amber and says why in words for a screen reader
    await expect(sidebarBadge(page)).toHaveClass(/attention/);
    await expect(sidebarBadge(page)).toContainText('some have waited over a day');
    // deciding the old one turns the badge back
    await rowOf(page, old!.id).hover();
    await rowOf(page, old!.id).getByTestId('approval-row-deny').click();
    await expect(sidebarBadge(page)).not.toHaveClass(/attention/);
  } finally {
    await context.close();
  }
  const api = await apiOn(playwright, stack, 'rafi');
  expect(await api.status('POST', `/api/teams/engineering/approvals/${young!.id}/deny`, { note: '' })).toBe(200);
  await api.ctx.dispose();
});

test('a cut-short request offers Open instead of Approve on the row', async ({ browser, playwright }) => {
  const [long] = await arrangeApprovals(stack, [{ path: 'pages/e2e-long-row.md', requester: 'nadia', longContent: true }]);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals');
  try {
    const row = rowOf(page, long!.id);
    await row.hover();
    await expect(row.getByTestId('approval-row-open')).toBeVisible();
    await expect(row.getByTestId('approval-row-approve')).toHaveCount(0);
    await expect(row.getByTestId('approval-row-deny')).toHaveCount(0);
    await row.getByTestId('approval-row-open').click();
    await expect(card(page, long!.id)).toBeVisible();
    await expect(card(page, long!.id).getByTestId('approval-approve')).toBeDisabled();
    await card(page, long!.id).getByTestId('approval-deny').click();
    await expect(card(page, long!.id).getByTestId('approval-state')).toContainText('Denied by Rafi');
  } finally {
    await context.close();
  }
});

test('on a phone the buttons are always on the row, 44 px high, and the detail header buttons are as large', async ({ browser, playwright }) => {
  // runs on the desktop project at 390 px with touch (a context made here does not take the project's size); the mobile-web project skips this file
  const [phoneRow, phoneOpen] = await arrangeApprovals(stack, [
    { path: 'pages/e2e-phone-row.md', requester: 'nadia' },
    { path: 'pages/e2e-phone-open.md', requester: 'nadia' },
  ]);
  const { page, context } = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/approvals', { viewport: PHONE, mobile: true });
  try {
    const row = rowOf(page, phoneRow!.id);
    await expect(row).toBeVisible();
    // no hover on a touch screen: the group is opaque and its buttons are tall enough to press
    await expect(row.getByRole('group', { name: 'Decide' })).toHaveCSS('opacity', '1');
    for (const id of ['approval-row-approve', 'approval-row-deny']) {
      const box = (await row.getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.width, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(PHONE.width);
    }
    expect(await noSidewaysScroll(page)).toBe(true);

    // the detail header: Approve and Deny are full-height touch targets and stay on the screen
    await rowOf(page, phoneOpen!.id).locator('.apr-trow').click();
    const c = card(page, phoneOpen!.id);
    for (const id of ['approval-approve', 'approval-deny']) {
      const box = (await c.locator('.apr-head').getByTestId(id).boundingBox())!;
      expect(box.height, id).toBeGreaterThanOrEqual(44);
      expect(box.x + box.width, id).toBeLessThanOrEqual(PHONE.width);
    }
    expect(await noSidewaysScroll(page)).toBe(true);
    await c.getByTestId('approval-deny').click();
    await expect(c.getByTestId('approval-state')).toContainText('Denied by Rafi');

    // back on the list, Deny on the row settles the other one by touch
    await page.getByRole('button', { name: 'Approvals', exact: true }).click();
    await rowOf(page, phoneRow!.id).getByTestId('approval-row-deny').tap();
    await expect(rowOf(page, phoneRow!.id)).toHaveCount(0);
    await expect.poll(async () => (await rowOfApproval(stack, phoneRow!.id))?.status).toBe('denied');
  } finally {
    await context.close();
  }
});
