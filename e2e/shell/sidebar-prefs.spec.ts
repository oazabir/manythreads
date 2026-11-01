import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, openOn, postAs, type StackApi } from '../support/stack-browser.ts';

/**
 * A person's own sidebar (PLAN P14-15): star channels, sort by recent activity or name, hide channels idle for 30 days, and put the channel groups
 * in their own order. Everything is the person's alone and is kept on the server (sidebar-prefs), so each step reloads the page to prove it.
 *
 * One stack of its own with the seed's channels. Engineering has one group, "Channels"; the spec adds a second, "Operations", and gives every channel
 * a last-message time of its own (straight in the database, which is how a channel gets 45 days quiet without waiting for them):
 *
 *   Channels:   general 5 min · dev 60 min · eng-leads 10 d · load-test 50 d · releases 40 d · standup 45 d
 *   Operations: incidents 30 min · alerts 45 d (but Nadia has an unread message in it)
 *
 * The default order of channels inside a group is the team's own order (what the server lists); "Recent activity" and "Name" are the person's choice.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop sidebar; the phone drawer is checked at the end of this file at 390 px');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let lena: StackApi;
let ids: Record<string, string>;
let opsGroup: string;
let mainGroup: string;

const MINUTE = 60_000;
const DAY = 86_400_000;
const AGES: Record<string, number> = {
  general: 5 * MINUTE,
  dev: 60 * MINUTE,
  'eng-leads': 10 * DAY,
  'load-test': 50 * DAY,
  releases: 40 * DAY,
  standup: 45 * DAY,
  incidents: 30 * MINUTE,
  alerts: 45 * DAY,
};
const PREFS_URL = '/api/teams/engineering/sidebar-prefs';
/** What a person who never changed anything has; read from the server before the spec changes anything (the default sort is the server's to name). */
let DEFAULTS: { starred: string[]; sort: string; hideIdle: boolean; groupOrder: string[] };
const RECENT = ['general', 'dev', 'eng-leads', 'releases', 'standup', 'load-test']; // main group, newest message first
const BY_NAME = ['dev', 'eng-leads', 'general', 'load-test', 'releases', 'standup'];

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  lena = await apiOn(playwright, stack, 'lena');
  DEFAULTS = await omar.get(PREFS_URL);
  expect(DEFAULTS).toMatchObject({ starred: [], hideIdle: false, groupOrder: [] });
  ids = await channelsOf(omar);
  for (const name of Object.keys(AGES)) expect(ids[name], `seeded channel #${name}`).toBeTruthy();

  mainGroup = (await stack.sql<{ id: string }>(`SELECT id FROM app.channel_groups WHERE team_id = (SELECT id FROM app.teams WHERE slug = 'engineering') AND name = 'Channels'`))[0]!.id;
  opsGroup = (
    await stack.sql<{ id: string }>(
      `INSERT INTO app.channel_groups (workspace_id, team_id, name, position) SELECT workspace_id, id, 'Operations', 1 FROM app.teams WHERE slug = 'engineering' RETURNING id`,
    )
  )[0]!.id;
  await stack.sql(`UPDATE app.channels SET group_id = $1 WHERE id = ANY($2::uuid[])`, [opsGroup, [ids['incidents'], ids['alerts']]]);

  // Nadia has a new, unread message in #alerts; then every channel gets the age above (the message that counts is the newest by id).
  await postAs(omar, ids['alerts']!, 'something to read');
  // the row's trigger keeps a message's time fixed for every caller but the system role: the owner lifts it for these statements
  await stack.sql(`ALTER TABLE app.messages DISABLE TRIGGER messages_before_update`);
  try {
    for (const [name, age] of Object.entries(AGES)) {
      await stack.sql(`UPDATE app.messages SET created_at = now() - ($2::bigint * interval '1 millisecond') WHERE channel_id = $1`, [ids[name], age]);
    }
  } finally {
    await stack.sql(`ALTER TABLE app.messages ENABLE TRIGGER messages_before_update`);
  }
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), lena?.ctx.dispose()]);
  await stack?.stop();
});

async function putPrefs(api: StackApi, body: unknown): Promise<number> {
  return (await api.ctx.put(PREFS_URL, { data: body, headers: await api.headers() })).status();
}
async function prefsOf(api: StackApi): Promise<{ starred: string[]; sort: string; hideIdle: boolean; groupOrder: string[] }> {
  return api.get(PREFS_URL);
}
/** Every test starts from a person who never changed anything. */
async function reset(api: StackApi): Promise<void> {
  const have = (await prefsOf(api)).starred;
  expect(await putPrefs(api, { ...(have.length ? { starRemove: have } : {}), sort: DEFAULTS.sort, hideIdle: false, groupOrder: [] })).toBe(200);
}

/** The channels of each group in the order the team's directory gives them (the default order of the sidebar), by group id. */
async function teamOrder(api: StackApi): Promise<Record<string, string[]>> {
  const dir = await api.get<{ groups: Array<{ id: string; channels: Array<{ name: string }> }> }>('/api/teams/engineering/channels');
  return Object.fromEntries(dir.groups.map((g) => [g.id, g.channels.map((c) => c.name.replace(/^#/, ''))]));
}
/** Replaces the person's starred list (one place to change if the writes become single stars). */
async function setStarred(api: StackApi, channelIds: string[]): Promise<void> {
  const have = (await prefsOf(api)).starred;
  const body = { starAdd: channelIds.filter((id) => !have.includes(id)), starRemove: have.filter((id) => !channelIds.includes(id)) };
  expect(await putPrefs(api, { ...(body.starAdd.length ? { starAdd: body.starAdd } : {}), ...(body.starRemove.length ? { starRemove: body.starRemove } : {}), sort: (await prefsOf(api)).sort })).toBe(200);
}
const sidebar = (page: Page): Locator => page.locator('[data-landmark="sidebar"]');
const groups = (page: Page): Locator => sidebar(page).locator('.channel-groups .group');
const group = (page: Page, id: string): Locator => sidebar(page).locator(`.channel-groups .group[data-group="${id}"]`);
/** The names of the channels listed (not the folded ones) in a group, top to bottom. */
const listed = (group: Locator): Promise<string[]> => group.locator('a.it .it-label').allTextContents();
const heading = (page: Page): Promise<string[]> => groups(page).locator('button.grp').allTextContents().then((t) => t.map((s) => s.trim()));
const row = (page: Page, name: string): Locator => sidebar(page).locator(`a.it[href$="/c/${name}"]`);
const waitForList = async (page: Page): Promise<void> => {
  await expect(groups(page).first()).toBeVisible();
  await expect(row(page, 'dev')).toBeVisible();
};

async function openOptions(page: Page): Promise<Locator> {
  await sidebar(page).getByTestId('sidebar-options').click();
  const menu = page.getByTestId('sidebar-options-menu');
  await expect(menu).toBeVisible();
  return menu;
}
async function rowMenu(page: Page, name: string): Promise<Locator> {
  await row(page, name).hover();
  await row(page, name).locator('xpath=..').getByTestId('channel-row-menu').click();
  const menu = page.getByRole('menu', { name: `Options for #${name}` });
  await expect(menu).toBeVisible();
  return menu;
}

test('starring from the row menu lists the channel once, in a Starred group at the top, and the star is kept on the server', async ({ browser, playwright }) => {
  await reset(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await waitForList(page);
    await expect(group(page, 'starred')).toHaveCount(0);
    expect(await heading(page)).toEqual(['Channels', 'Operations']);

    await (await rowMenu(page, 'dev')).getByTestId('channel-row-star').click();
    const starred = group(page, 'starred');
    await expect(starred).toBeVisible();
    await expect(groups(page).first()).toHaveAttribute('data-group', 'starred');
    expect(await heading(page)).toEqual(['Starred', 'Channels', 'Operations']);
    expect(await listed(starred)).toEqual(['dev']);
    // not twice: it left its own group
    await expect(row(page, 'dev')).toHaveCount(1);
    expect(await listed(group(page, mainGroup))).not.toContain('dev');
    // the list options are one button above the groups, whatever the groups are
    await expect(sidebar(page).locator('.channel-groups > .sb-opts-pin').getByTestId('sidebar-options')).toBeVisible();
    await expect(sidebar(page).getByTestId('sidebar-options')).toHaveCount(1);
    await expect(sidebar(page).locator('.group').getByTestId('sidebar-options')).toHaveCount(0);
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([ids['dev']]);

    // kept: a new page load, and the second device (a fresh context) sees the same
    await page.reload();
    await waitForList(page);
    expect(await listed(group(page, 'starred'))).toEqual(['dev']);
    await expect(row(page, 'dev')).toHaveCount(1);

    // unstar from the same menu
    const menu = await rowMenu(page, 'dev');
    await expect(menu.getByTestId('channel-row-star')).toHaveText(/Remove star/);
    await menu.getByTestId('channel-row-star').click();
    await expect(group(page, 'starred')).toHaveCount(0);
    expect(await listed(group(page, mainGroup))).toContain('dev');
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([]);
    await page.reload();
    await waitForList(page);
    await expect(group(page, 'starred')).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the star in the channel header does the same as the row menu', async ({ browser, playwright }) => {
  await reset(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/standup');
  try {
    await waitForList(page);
    const star = page.getByTestId('channel-star');
    await expect(star).toBeVisible();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(star).toHaveAccessibleName('Remove the star from #standup');
    expect(await listed(group(page, 'starred'))).toEqual(['standup']);
    await expect(row(page, 'standup')).toHaveCount(1);
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([ids['standup']]);
    // the row menu shows the same state
    await expect((await rowMenu(page, 'standup')).getByTestId('channel-row-star')).toHaveText(/Remove star/);
    await page.keyboard.press('Escape');

    await page.reload();
    await waitForList(page);
    await expect(page.getByTestId('channel-star')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('channel-star').click();
    await expect(page.getByTestId('channel-star')).toHaveAttribute('aria-pressed', 'false');
    await expect(group(page, 'starred')).toHaveCount(0);
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([]);
  } finally {
    await context.close();
  }
});

test('channels keep the team\'s order until the person picks Recent activity or Name; the choice reaches every group and survives a reload', async ({ browser, playwright }) => {
  await reset(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await waitForList(page);
    const order = await teamOrder(nadia);
    const main = group(page, mainGroup);
    const ops = group(page, opsGroup);
    // the default is the server's order, whichever it is
    expect(await listed(main)).toEqual(order[mainGroup]);
    expect(await listed(ops)).toEqual(order[opsGroup]);
    expect(new Set(order[mainGroup])).toEqual(new Set(RECENT));
    expect(DEFAULTS.sort).toBe('team');

    let menu = await openOptions(page);
    await expect(menu.getByTestId(`sort-${DEFAULTS.sort}`)).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByTestId('sort-recent')).toHaveAttribute('aria-checked', 'false');
    await menu.getByTestId('sort-recent').click();
    await expect(menu).toBeHidden();
    await expect.poll(() => listed(main)).toEqual(RECENT);
    expect(await listed(ops)).toEqual(['incidents', 'alerts']);
    await expect.poll(async () => (await prefsOf(nadia)).sort).toBe('recent');

    await page.reload();
    await waitForList(page);
    expect(await listed(group(page, mainGroup))).toEqual(RECENT);
    menu = await openOptions(page);
    await expect(menu.getByTestId('sort-recent')).toHaveAttribute('aria-checked', 'true');

    await menu.getByTestId('sort-name').click();
    await expect.poll(() => listed(group(page, mainGroup))).toEqual(BY_NAME);
    expect(await listed(group(page, opsGroup))).toEqual(['alerts', 'incidents']);
    await expect.poll(async () => (await prefsOf(nadia)).sort).toBe('name');
    await page.reload();
    await waitForList(page);
    expect(await listed(group(page, mainGroup))).toEqual(BY_NAME);

    // the starred channels are sorted the same way
    await setStarred(nadia, [ids['standup']!, ids['dev']!, ids['general']!]);
    await page.reload();
    await waitForList(page);
    expect(await listed(group(page, 'starred'))).toEqual(['dev', 'general', 'standup']);
    await (await openOptions(page)).getByTestId('sort-recent').click();
    await expect.poll(() => listed(group(page, 'starred'))).toEqual(['general', 'dev', 'standup']);

    // and back to the team's order
    await (await openOptions(page)).getByTestId(`sort-${DEFAULTS.sort}`).click();
    await expect.poll(() => listed(group(page, mainGroup))).toEqual(order[mainGroup]!.filter((n) => !['standup', 'dev', 'general'].includes(n)));
    await expect.poll(async () => (await prefsOf(nadia)).sort).toBe(DEFAULTS.sort);
  } finally {
    await context.close();
    await reset(nadia);
  }
});

test('"Hide channels idle for 30 days" folds quiet channels into an "N hidden" row that opens; unread, open and starred channels stay', async ({ browser, playwright }) => {
  await reset(nadia);
  // #releases (40 days quiet) is starred: it stays visible, in Starred. #alerts is quiet but has something unread for Nadia. #standup is the open one.
  await setStarred(nadia, [ids['releases']!]);
  const order = await teamOrder(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await waitForList(page);
    await expect(row(page, 'alerts')).toHaveClass(/unread/);
    await expect(sidebar(page).getByTestId('hidden-channels')).toHaveCount(0);

    await (await openOptions(page)).getByTestId('hide-idle').click();
    const main = group(page, mainGroup);
    await expect(main.getByTestId('hidden-channels')).toHaveText(/\b2\b.*hidden/);
    expect(await listed(main)).toEqual(order[mainGroup]!.filter((n) => ['general', 'dev', 'eng-leads'].includes(n)));
    expect(await listed(group(page, 'starred'))).toEqual(['releases']);
    // the unread quiet channel is still in its group; that group folds nothing
    expect((await listed(group(page, opsGroup))).sort()).toEqual(['alerts', 'incidents']);
    await expect(group(page, opsGroup).getByTestId('hidden-channels')).toHaveCount(0);
    await expect(row(page, 'standup')).toHaveCount(0);
    await expect(row(page, 'load-test')).toHaveCount(0);
    await expect.poll(async () => (await prefsOf(nadia)).hideIdle).toBe(true);

    // it opens and closes
    const hidden = main.getByTestId('hidden-channels');
    await expect(hidden).toHaveAttribute('aria-expanded', 'false');
    await hidden.click();
    await expect(hidden).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'standup')).toBeVisible();
    await expect(row(page, 'load-test')).toBeVisible();
    await hidden.click();
    await expect(row(page, 'standup')).toHaveCount(0);

    // kept
    await page.reload();
    await waitForList(page);
    await expect(group(page, mainGroup).getByTestId('hidden-channels')).toHaveText(/\b2\b.*hidden/);
    await expect(row(page, 'standup')).toHaveCount(0);
    await expect(await openOptions(page).then((m) => m.getByTestId('hide-idle'))).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // the channel that is open stays, even though it has been quiet for 45 days
    await page.goto('/t/engineering/c/standup');
    await waitForList(page);
    await expect(row(page, 'standup')).toBeVisible();
    await expect(row(page, 'standup')).toHaveClass(/\bon\b/);
    await expect(group(page, mainGroup).getByTestId('hidden-channels')).toHaveText(/\b1\b.*hidden/);
    await expect(row(page, 'load-test')).toHaveCount(0);

    // turning it off shows everything again
    await (await openOptions(page)).getByTestId('hide-idle').click();
    await expect(sidebar(page).getByTestId('hidden-channels')).toHaveCount(0);
    await expect(row(page, 'load-test')).toBeVisible();
    await expect.poll(async () => (await prefsOf(nadia)).hideIdle).toBe(false);
  } finally {
    await context.close();
    await reset(nadia);
  }
});

test('groups move up and down with the menu buttons and with Alt + arrow, and the order is kept', async ({ browser, playwright }) => {
  await reset(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await waitForList(page);
    expect(await heading(page)).toEqual(['Channels', 'Operations']);
    const menu = await openOptions(page);
    // the first group cannot go up, the last cannot go down
    await expect(menu.getByTestId('group-up-0')).toBeDisabled();
    await expect(menu.getByTestId('group-down-1')).toBeDisabled();
    await menu.getByTestId('group-down-0').click();
    await expect.poll(() => heading(page)).toEqual(['Operations', 'Channels']);
    await expect.poll(async () => (await prefsOf(nadia)).groupOrder).toEqual([opsGroup, mainGroup]);
    // the options button stays where it is
    await expect(sidebar(page).getByTestId('sidebar-options')).toHaveCount(1);

    await page.reload();
    await waitForList(page);
    expect(await heading(page)).toEqual(['Operations', 'Channels']);

    // Alt + arrow on a heading
    const channelsHeading = group(page, mainGroup).locator('button.grp');
    await channelsHeading.focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => heading(page)).toEqual(['Channels', 'Operations']);
    await expect.poll(async () => (await prefsOf(nadia)).groupOrder).toEqual([mainGroup, opsGroup]);
    await expect(channelsHeading).toBeFocused();
    // the keys did not fold the group
    await expect(channelsHeading).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Alt+ArrowUp'); // already first: nothing changes
    expect(await heading(page)).toEqual(['Channels', 'Operations']);
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(() => heading(page)).toEqual(['Operations', 'Channels']);

    await page.reload();
    await waitForList(page);
    expect(await heading(page)).toEqual(['Operations', 'Channels']);
    await expect.poll(async () => (await prefsOf(nadia)).groupOrder).toEqual([opsGroup, mainGroup]);

    // the Starred group is not one of them: it stays first whatever the order
    await setStarred(nadia, [ids['dev']!]);
    await page.reload();
    await waitForList(page);
    expect(await heading(page)).toEqual(['Starred', 'Operations', 'Channels']);
    await expect(group(page, 'starred').locator('button.grp')).toBeVisible();
    await group(page, 'starred').locator('button.grp').focus();
    await page.keyboard.press('Alt+ArrowDown'); // Starred has no place to move
    expect(await heading(page)).toEqual(['Starred', 'Operations', 'Channels']);
    await expect.poll(async () => (await prefsOf(nadia)).groupOrder).toEqual([opsGroup, mainGroup]);
  } finally {
    await context.close();
    await reset(nadia);
  }
});

test('it is per person: what Nadia arranged is not Omar\'s sidebar, nor his saved settings', async ({ browser, playwright }) => {
  expect(await putPrefs(nadia, { starAdd: [ids['dev']], sort: 'name', hideIdle: true, groupOrder: [opsGroup, mainGroup] })).toBe(200);
  const mine = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  const his = await openOn(browser, playwright, stack, 'omar', '/t/engineering/threads');
  try {
    await waitForList(mine.page);
    await waitForList(his.page);
    expect(await heading(mine.page)).toEqual(['Starred', 'Operations', 'Channels']);
    expect(await heading(his.page)).toEqual(['Channels', 'Operations']);
    await expect(group(his.page, 'starred')).toHaveCount(0);
    expect(await listed(group(his.page, mainGroup))).toEqual((await teamOrder(omar))[mainGroup]);
    await expect(his.page.getByTestId('hidden-channels')).toHaveCount(0);
    expect(await prefsOf(omar)).toEqual(DEFAULTS);
    // and his change is not hers
    await (await rowMenu(his.page, 'general')).getByTestId('channel-row-star').click();
    await expect.poll(async () => (await prefsOf(omar)).starred).toEqual([ids['general']]);
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([ids['dev']]);
  } finally {
    await Promise.all([mine.context.close(), his.context.close()]);
    await Promise.all([reset(nadia), reset(omar)]);
  }
});

test('a guest has no personal controls, and the server gives her no sidebar settings', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(groups(page).first()).toBeVisible();
    await expect(row(page, 'releases')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(sidebar(page).getByTestId('sidebar-options')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('channel-row-menu')).toHaveCount(0);
    await row(page, 'releases').hover();
    await row(page, 'releases').click({ button: 'right' });
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(page.getByTestId('channel-star')).toHaveCount(0);
    await expect(sidebar(page).getByTestId('new-channel')).toHaveCount(0);
  } finally {
    await context.close();
  }
  // not a person of the team: no read, no write
  expect((await lena.ctx.get(PREFS_URL)).status()).toBe(403);
  expect(await putPrefs(lena, { sort: 'name' })).toBe(403);
});

test('when the server refuses a change, the old value comes back and one plain line says so; the next change that works clears it', async ({ browser, playwright }) => {
  await reset(nadia);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads');
  try {
    await waitForList(page);
    let fail = true;
    await page.route('**/api/teams/engineering/sidebar-prefs', async (route) => {
      if (route.request().method() === 'PUT' && fail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) });
      return route.continue();
    });
    const problem = page.getByTestId('sidebar-problem');
    const before = await listed(group(page, mainGroup));

    // a star: it shows at once, then goes back
    await (await rowMenu(page, 'dev')).getByTestId('channel-row-star').click();
    await expect(problem).toHaveText('Could not save your sidebar. Try again.');
    await expect(problem).toHaveAttribute('role', 'alert');
    await expect(group(page, 'starred')).toHaveCount(0);
    expect(await listed(group(page, mainGroup))).toContain('dev');
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([]);

    // a sort
    await (await openOptions(page)).getByTestId('sort-name').click();
    await expect(problem).toBeVisible();
    await expect.poll(() => listed(group(page, mainGroup))).toEqual(before);
    await expect(await openOptions(page).then((m) => m.getByTestId(`sort-${DEFAULTS.sort}`))).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await prefsOf(nadia)).sort).toBe(DEFAULTS.sort);

    // a group move
    await (await openOptions(page)).getByTestId('group-down-0').click();
    await expect(problem).toBeVisible();
    await expect.poll(() => heading(page)).toEqual(['Channels', 'Operations']);
    await page.keyboard.press('Escape');

    // the header star says it beside the star
    await page.goto('/t/engineering/c/dev');
    await waitForList(page);
    await page.getByTestId('channel-star').click();
    await expect(page.locator('.sb-star-problem')).toHaveText('Could not save your sidebar. Try again.');
    await expect(page.getByTestId('channel-star')).toHaveAttribute('aria-pressed', 'false');

    // when it works again the same step succeeds and the line is gone
    fail = false;
    await (await rowMenu(page, 'dev')).getByTestId('channel-row-star').click();
    await expect(problem).toHaveCount(0);
    await expect(group(page, 'starred')).toBeVisible();
    await expect.poll(async () => (await prefsOf(nadia)).starred).toEqual([ids['dev']]);
  } finally {
    await context.close();
    await reset(nadia);
  }
});

test('at 390 px the options button and the row menu fit in the drawer and can be used by touch', async ({ browser, playwright }) => {
  await reset(nadia);
  await setStarred(nadia, [ids['dev']!]);
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/threads', { viewport: PHONE, mobile: true });
  try {
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.locator('.frame')).toHaveAttribute('data-drawer', 'open');
    const rail = page.locator('#shell-rail');
    await expect(rail.locator('.channel-groups .group').first()).toBeVisible();
    const noSideways = (): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
    expect(await noSideways()).toBe(true);

    const inside = async (loc: Locator): Promise<void> => {
      const box = (await loc.boundingBox())!;
      const rb = (await rail.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(22);
      expect(box.height).toBeGreaterThanOrEqual(22);
      expect(box.x).toBeGreaterThanOrEqual(rb.x - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(rb.x + rb.width + 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    };
    // one options button above the groups
    const options = rail.getByTestId('sidebar-options');
    await expect(options).toBeVisible();
    await inside(options);
    // the row menu button needs no hover on a touch screen, and the label does not run under it
    const more = rail.locator('.sb-row').filter({ has: page.locator('a[href$="/c/general"]') }).getByTestId('channel-row-menu');
    await expect(more).toBeVisible();
    await expect(more).toHaveCSS('opacity', '1');
    await inside(more);
    const link = rail.locator('a.it[href$="/c/general"]');
    const lb = (await link.locator('.it-label').boundingBox())!;
    const mb = (await more.boundingBox())!;
    expect(lb.x + lb.width).toBeLessThanOrEqual(mb.x + 0.5);

    // the options menu opens inside the screen and its choices can be tapped
    await options.tap();
    const menu = page.getByTestId('sidebar-options-menu');
    await expect(menu).toBeVisible();
    const m = (await menu.boundingBox())!;
    expect(m.x).toBeGreaterThanOrEqual(0);
    expect(m.x + m.width).toBeLessThanOrEqual(PHONE.width);
    expect(await noSideways()).toBe(true);
    await menu.getByTestId('sort-name').tap();
    await expect(menu).toBeHidden();
    await expect.poll(async () => (await prefsOf(nadia)).sort).toBe('name');

    // the row menu: tap, choose to star
    await more.tap();
    const rowMenuBox = (await page.getByRole('menu', { name: 'Options for #general' }).boundingBox())!;
    expect(rowMenuBox.x).toBeGreaterThanOrEqual(0);
    expect(rowMenuBox.x + rowMenuBox.width).toBeLessThanOrEqual(PHONE.width);
    await page.getByRole('menu', { name: 'Options for #general' }).getByTestId('channel-row-star').tap();
    await expect.poll(async () => (await prefsOf(nadia)).starred.length).toBe(2);
    expect(await noSideways()).toBe(true);

    // the header star is left out on a phone (the title needs the room); the row menu offers the same
    await page.goto('/t/engineering/c/dev');
    await expect(page.getByTestId('channel-view')).toBeVisible();
    await expect(page.getByTestId('channel-star')).toBeHidden();
    expect(await noSideways()).toBe(true);
  } finally {
    await context.close();
    await reset(nadia);
  }
});
