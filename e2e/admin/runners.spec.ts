import { expect, test, type Page } from '@playwright/test';
import { startFakeHermesGateway, type FakeHermesGateway } from '../../tools/fake-hermes-gateway/src/server.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn } from '../support/stack-browser.ts';

/*
 * Workspace → Runners (PLAN P19-04) end to end. A workspace admin adds a Hermes gateway runner (the stand-in gateway of tools/fake-hermes-gateway answers as a
 * Hermes does), tests it and reads the three fixed sentences, shares it with teams, makes it the default and switches it off. The team Hermes pod that
 * a team lead connected the old way is adopted, and the delete of a runner a bot still runs on is refused in plain words. A plain member cannot reach the
 * page or the routes. The page is read at 390 px and driven by keyboard where a dialog opens.
 *
 * One stack for the file (the specs write to it, in order). The outbound guard is told the stand-in's loopback address is allowed, the way an operator
 * would list a host of their own (MANYTHREADS_HERMES_ALLOWED_HOSTS); every other rule of the guard still runs.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone width is read by its own test with an explicit viewport');
test.describe.configure({ mode: 'serial' });

const KEY = 'gateway-key-0123456789abcdef';
const OTHER_KEY = 'another-key-0123456789abcdef';
const PATH = '/settings/workspace/runners';

let stack: Stack;
let gateway: FakeHermesGateway;

const row = (page: Page, name: string) => page.locator(`[data-testid="runner-row"][data-runner="${name}"]`);

/** The admin's view of the runners straight from the API, to compare with what the page says. */
async function runnersByApi(playwright: Parameters<typeof apiOn>[0]): Promise<Array<{ name: string; allTeams: boolean; isDefault: boolean; enabled: boolean; teams: Array<{ slug: string }>; hasKey: boolean }>> {
  const omar = await apiOn(playwright, stack, 'omar');
  try {
    return (await omar.get<{ items: Array<{ name: string; allTeams: boolean; isDefault: boolean; enabled: boolean; teams: Array<{ slug: string }>; hasKey: boolean }> }>('/api/admin/bot-runners')).items;
  } finally {
    await omar.ctx.dispose();
  }
}

test.beforeAll(async () => {
  gateway = await startFakeHermesGateway({ profiles: { probe: { apiKey: KEY } } });
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'repo', MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1' });
  // The old way: Engineering's lead connected the team's own pod, and its bot `coder` is placed through that connection.
  await stack.sql(
    `INSERT INTO app.hermes_connections (workspace_id, team_id, name, kind, agent, base_url, secret_id, status)
     SELECT t.workspace_id, t.id, 'managed', 'managed', 'hermes', 'http://pod.internal:8642', NULL, 'ok' FROM app.teams t WHERE t.slug = 'engineering'`,
  );
  for (let i = 0; i < 150; i += 1) {
    const found = await stack.sql("SELECT 1 FROM app.bots WHERE slug = 'coder' AND status = 'active'");
    if (found.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await stack.sql(`UPDATE app.bots SET placement = '{"gateway":{"connection":"managed"}}'::jsonb WHERE slug = 'coder'`);
});
test.afterAll(async () => {
  await stack?.stop();
  await gateway?.close();
});

test('the page starts empty with three steps; the chooser offers the kinds, keeps Claude Code and Codex shut, and a keyboard works the dialog', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/');
  try {
    // the entry is in the Workspace group of the settings menu, next to LLM
    await page.goto(PATH);
    await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Runners', exact: true })).toBeVisible();
    await expect(page.getByTestId('runner-empty')).toContainText('No runner yet');
    await expect(page.getByTestId('runner-empty').locator('li')).toHaveCount(3);
    // the status line is a live region from the start, so a change is announced
    await expect(page.getByTestId('runner-status')).toHaveAttribute('role', 'status');
    // the old connection of Engineering waits in its own section
    await expect(page.getByTestId('runner-old')).toContainText('Team-owned (old)');
    await expect(page.getByTestId('runner-old-row')).toHaveCount(1);
    await expect(page.getByTestId('runner-old-row')).toContainText('Engineering');

    // open the chooser from the keyboard: focus lands inside, Tab stays inside, Esc closes and focus returns to the button
    const add = page.getByTestId('runner-add');
    await add.focus();
    await page.keyboard.press('Enter');
    const chooser = page.getByRole('dialog', { name: 'Add a runner' });
    await expect(chooser).toBeVisible();
    await expect(chooser.locator(':focus')).toHaveCount(1);
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press('Tab');
      await expect(chooser.locator(':focus')).toHaveCount(1);
    }
    for (const kind of ['hermes_gateway', 'hermes_pod', 'claude_cli', 'codex_cli', 'llm_gateway']) await expect(chooser.getByTestId(`runner-kind-${kind}`)).toBeVisible();
    await expect(chooser.getByTestId('runner-kind-claude_cli')).toContainText('Needs a Claude sign-in; coming with the Claude pod.');
    await expect(chooser.getByTestId('runner-kind-codex_cli')).toContainText('Needs a Codex sign-in; coming with the Claude pod.');
    await expect(chooser.getByTestId('runner-kind-claude_cli')).toHaveAttribute('aria-disabled', 'true');
    // pressing a shut card does nothing: still the chooser
    await chooser.getByTestId('runner-kind-claude_cli').click({ force: true }); // Playwright treats aria-disabled as not clickable; force presses it anyway
    await expect(page.getByRole('dialog', { name: 'Add a runner' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Add a runner: / })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(add).toBeFocused();

    // the LLM gateway form takes a model name from the LLM page's own list
    await add.click();
    await page.getByTestId('runner-kind-llm_gateway').click();
    await expect(page.getByRole('dialog', { name: 'Add a runner: LLM gateway' })).toBeVisible();
    await expect(page.getByTestId('runner-alias')).toBeVisible();
    await expect(page.getByRole('dialog')).toContainText('LLM page');
    // nothing chosen: the form says what is missing and sends nothing
    await page.getByLabel('Display name').fill('Plain answers');
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByRole('dialog')).toContainText('Choose a model name.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect(await runnersByApi(playwright)).toEqual([]);
});

test('an admin adds a Hermes gateway, tests it (the three fixed sentences) and the key is never shown', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    await page.getByTestId('runner-add').click();
    await page.getByTestId('runner-kind-hermes_gateway').click();
    const form = page.getByRole('dialog', { name: 'Add a runner: Hermes gateway' });
    await expect(form).toBeVisible();

    // wrong input is named field by field, in plain words, and nothing is sent
    await page.getByTestId('runner-add-submit').click();
    await expect(form).toContainText('Give the runner a name people can read');
    await expect(form).toContainText('http or https address');
    await expect(form).toContainText('Type the gateway’s key.');

    await page.getByLabel('Display name').fill('Office Hermes');
    await expect(page.getByLabel('Short name')).toHaveValue('office-hermes');
    await page.getByLabel('Address', { exact: true }).fill(gateway.url);
    await page.getByLabel('Key', { exact: true }).fill(KEY);
    await expect(page.getByLabel('Profile name rule')).toHaveValue('{bot}');
    await page.getByTestId('runner-teams-one').check();
    await page.getByTestId('runner-teams-select').selectOption({ label: 'Engineering' });
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const office = row(page, 'office-hermes');
    await expect(office).toBeVisible();
    await expect(page.getByTestId('runner-status')).toContainText('Office Hermes was added');
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'not_set_up');
    await expect(office.getByTestId('runner-state')).toContainText('Not set up');
    await expect(office.getByTestId('runner-teams')).toContainText('Engineering');
    await expect(office.getByTestId('runner-bots')).toHaveText('No bots');
    await expect(office).toContainText('A key is set');
    await expect(office).toContainText(gateway.url);
    // the key is in no part of the page, and not in anything the list returned
    expect(await page.content()).not.toContain(KEY);
    expect(JSON.stringify(await runnersByApi(playwright))).not.toContain(KEY);

    // a second runner with the same short name is refused with the server's sentence, inside the dialog
    await page.getByTestId('runner-add').click();
    await page.getByTestId('runner-kind-hermes_gateway').click();
    await page.getByLabel('Display name').fill('Office Hermes');
    await page.getByLabel('Address', { exact: true }).fill(gateway.url);
    await page.getByLabel('Key', { exact: true }).fill(KEY);
    await page.getByTestId('runner-teams-all').check();
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByTestId('runner-form-error')).toContainText(/already exists|name/i);
    // a failed send does not keep the key: the field is empty again (and so is the state behind it)
    await expect(page.getByLabel('Key', { exact: true })).toHaveValue('');
    expect(await page.content()).not.toContain(KEY);
    await page.getByRole('button', { name: 'Back' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // a runner added with no team ticked says so: it is not open to any team, and its row says nobody can use it yet
    await page.getByTestId('runner-add').click();
    await page.getByTestId('runner-kind-hermes_pod').click();
    await page.getByLabel('Display name').fill('Spare pods');
    await page.getByTestId('runner-add-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('runner-status')).toContainText('It is not open to any team yet');
    const spare = row(page, 'spare-pods');
    await expect(spare.getByTestId('runner-teams')).toHaveText('No team can use it yet');
    // a pod has nothing to edit but its name: with the name unchanged the dialog offers Close, not Save
    await spare.getByRole('button', { name: 'Change Spare pods' }).click();
    await expect(page.getByTestId('runner-edit-submit')).toHaveCount(0);
    await page.getByTestId('runner-edit-close').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await spare.getByRole('button', { name: 'Delete Spare pods' }).click();
    await page.getByTestId('runner-delete-confirm').click();
    await expect(spare).toHaveCount(0);

    // Test: no profile named, and this gateway has no default profile
    await office.getByTestId('runner-test').click();
    const test1 = page.getByRole('dialog', { name: 'Test Office Hermes' });
    await expect(test1).toBeVisible();
    await test1.getByTestId('runner-test-run').click();
    await expect(test1.getByTestId('runner-test-result')).toContainText('The gateway did not answer as a Hermes gateway for that profile.');
    await expect(test1.getByTestId('runner-test-result')).toHaveAttribute('data-ok', 'false');
    // the profile that exists answers
    await test1.getByLabel('Profile to ask for (optional)').fill('probe');
    await test1.getByTestId('runner-test-run').click();
    await expect(test1.getByTestId('runner-test-result')).toContainText('The gateway answered. This runner is ready.');
    await expect(test1.getByTestId('runner-test-result')).toHaveAttribute('data-ok', 'true');
    await test1.getByRole('button', { name: 'Close' }).click();
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('runner-status')).toContainText('Office Hermes answered');

    // a wrong key: the gateway refuses it; the sentence is the fixed one and the new key is not echoed anywhere
    await office.getByRole('button', { name: 'Change Office Hermes' }).click();
    const edit = page.getByRole('dialog', { name: 'Change Office Hermes' });
    await edit.getByLabel('New key').fill(OTHER_KEY);
    await edit.getByTestId('runner-edit-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('runner-status')).toContainText('Run Test again');
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'not_set_up');
    await office.getByTestId('runner-test').click();
    await page.getByLabel('Profile to ask for (optional)').fill('probe');
    await page.getByTestId('runner-test-run').click();
    await expect(page.getByTestId('runner-test-result')).toContainText('The gateway refused the API key.');
    await page.getByRole('button', { name: 'Close' }).click();
    expect(await page.content()).not.toContain(OTHER_KEY);

    // an address nothing answers on
    await office.getByRole('button', { name: 'Change Office Hermes' }).click();
    await page.getByLabel('New key').fill(KEY);
    await page.getByLabel('Address', { exact: true }).fill('http://127.0.0.1:9');
    await page.getByTestId('runner-edit-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await office.getByTestId('runner-test').click();
    await page.getByLabel('Profile to ask for (optional)').fill('probe');
    await page.getByTestId('runner-test-run').click();
    await expect(page.getByTestId('runner-test-result')).toContainText('The gateway did not answer. Check the address');
    await page.getByRole('button', { name: 'Close' }).click();

    // back to the working address and key: ready again
    await office.getByRole('button', { name: 'Change Office Hermes' }).click();
    await page.getByLabel('Address', { exact: true }).fill(gateway.url);
    await page.getByTestId('runner-edit-submit').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await office.getByTestId('runner-test').click();
    await page.getByLabel('Profile to ask for (optional)').fill('probe');
    await page.getByTestId('runner-test-run').click();
    await expect(page.getByTestId('runner-test-result')).toHaveAttribute('data-ok', 'true');
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'ready');
  } finally {
    await context.close();
  }
  const [made] = await runnersByApi(playwright);
  expect(made).toMatchObject({ name: 'office-hermes', hasKey: true, allTeams: false });
});

test('the teams control (one team, several, every team), the default star and the on/off switch', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const office = row(page, 'office-hermes');
    await expect(office.getByTestId('runner-teams')).toContainText('Engineering');

    // several: tick a second team
    await office.getByRole('button', { name: 'Teams for Office Hermes' }).click();
    const teams = page.getByRole('dialog', { name: 'Teams that can use Office Hermes' });
    await expect(teams.getByTestId('runner-teams-one')).toBeChecked();
    await teams.getByTestId('runner-teams-several').check();
    await teams.getByRole('checkbox', { name: 'Marketing' }).check();
    await teams.getByTestId('runner-teams-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(office.getByTestId('runner-teams')).toContainText('Engineering');
    await expect(office.getByTestId('runner-teams')).toContainText('Marketing');
    await expect(page.getByTestId('runner-status')).toContainText('Office Hermes is open to');
    const several = (await runnersByApi(playwright))[0]!;
    expect(several.teams.map((t) => t.slug).sort()).toEqual(['engineering', 'marketing']);

    // this team only, with no team chosen: refused before it is sent
    await office.getByRole('button', { name: 'Teams for Office Hermes' }).click();
    const again = page.getByRole('dialog', { name: 'Teams that can use Office Hermes' });
    await again.getByTestId('runner-teams-one').check();
    await again.getByTestId('runner-teams-select').selectOption({ label: 'Choose a team' });
    await again.getByTestId('runner-teams-save').click();
    await expect(again).toContainText('Choose the team.');
    // every team
    await again.getByTestId('runner-teams-all').check();
    await again.getByTestId('runner-teams-save').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(office.getByTestId('runner-teams')).toHaveText('Teams: Every team');
    expect((await runnersByApi(playwright))[0]).toMatchObject({ allTeams: true });

    // the default star
    const star = office.getByTestId('runner-default');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('runner-status')).toContainText('Office Hermes is now the default runner.');
    // the default cannot be switched off: the switch is shut and the row says why
    // (aria-disabled, not disabled: the switch stays in the Tab order and points at the reason)
    const locked = office.getByRole('switch', { name: 'Use Office Hermes' });
    await expect(locked).toHaveAttribute('aria-disabled', 'true');
    await expect(locked).toHaveAttribute('aria-describedby', /rn-stuck-/);
    await locked.focus();
    await expect(locked).toBeFocused();
    await locked.click({ force: true });
    await expect(locked).toHaveAttribute('aria-checked', 'true');
    await expect(office).toContainText('Make another runner the default first');
    expect((await runnersByApi(playwright))[0]).toMatchObject({ isDefault: true });
    await star.click();
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('runner-status')).toContainText('There is no default runner now.');

    // off and on again
    const toggle = office.getByRole('switch', { name: 'Use Office Hermes' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'off');
    await expect(office.getByTestId('runner-state')).toContainText('Off');
    await expect(page.getByTestId('runner-status')).toContainText('Office Hermes is switched off.');
    // an Off runner cannot be made the default
    await expect(star).toHaveAttribute('aria-disabled', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(office.getByTestId('runner-state')).toHaveAttribute('data-state', 'ready');
    expect((await runnersByApi(playwright))[0]).toMatchObject({ enabled: true, isDefault: false });
  } finally {
    await context.close();
  }
});

test('an old team connection is adopted; a runner a bot still runs on cannot be deleted, and the sentence says how many and where', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH);
  try {
    const old = page.getByTestId('runner-old-row');
    await expect(old).toHaveCount(1);
    await expect(old).toContainText('1 bot');
    await old.getByTestId('runner-adopt').click();
    const dialog = page.getByRole('dialog', { name: 'Adopt managed of Engineering' });
    await expect(dialog).toContainText('Nothing changes for its bots.');
    await dialog.getByTestId('runner-adopt-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const pod = row(page, 'team-pod');
    await expect(pod).toBeVisible();
    await expect(pod).toContainText('Team Hermes pod');
    await expect(pod.getByTestId('runner-teams')).toContainText('Engineering');
    await expect(pod.getByTestId('runner-bots')).toHaveText('1 bot');
    await expect(page.getByTestId('runner-old-none')).toBeVisible();
    await expect(page.getByTestId('runner-status')).toContainText('Team Hermes pod is now a runner.');
    // focus is somewhere sensible after the Adopt button disappeared
    await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeFocused();

    // delete: the dialog warns up front, and the server's refusal names the count and the team
    await pod.getByRole('button', { name: 'Delete Team Hermes pod' }).click();
    const del = page.getByRole('dialog', { name: 'Delete Team Hermes pod?' });
    await expect(del.getByTestId('runner-delete-warning')).toContainText('1 bot still runs on Team Hermes pod.');
    await del.getByTestId('runner-delete-confirm').click();
    await expect(del.getByTestId('runner-form-error')).toContainText('1 bot is still placed on "Team Hermes pod" (teams: Engineering). Move them to another runner first.');
    await expect(pod).toBeVisible();
    await del.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await runnersByApi(playwright)).map((r) => r.name).sort()).toEqual(['office-hermes', 'team-pod']);

    // the bot moves away; the same delete now goes through
    await stack.sql(`UPDATE app.bots SET placement = '{}'::jsonb WHERE slug = 'coder'`);
    await pod.getByRole('button', { name: 'Delete Team Hermes pod' }).click();
    await page.getByTestId('runner-delete-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(pod).toHaveCount(0);
    await expect(page.getByTestId('runner-status')).toContainText('Team Hermes pod was deleted.');
    await expect(page.getByRole('heading', { level: 1, name: 'Runners' })).toBeFocused();
    expect((await runnersByApi(playwright)).map((r) => r.name)).toEqual(['office-hermes']);
    // the pod's own connection is still the team's; it is simply old again
    await expect(page.getByTestId('runner-old-row')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

test('a plain member cannot reach the page or the routes', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', PATH);
  try {
    await expect(page.getByText('Page not found')).toBeVisible();
    await expect(page.getByTestId('runner-list')).toHaveCount(0);
    await expect(page.getByTestId('runner-add')).toHaveCount(0);
    // no menu entry for her either
    await page.goto('/teams');
    await expect(page.getByRole('link', { name: 'Runners', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    expect([403, 404]).toContain(await nadia.status('GET', '/api/admin/bot-runners'));
    expect([403, 404]).toContain(await nadia.status('GET', '/api/admin/bot-runners/old-connections'));
    expect([403, 404]).toContain(await nadia.status('POST', '/api/admin/bot-runners', { name: 'sneaky', label: 'Sneaky', kind: 'hermes_pod' }));
  } finally {
    await nadia.ctx.dispose();
  }
  expect((await runnersByApi(playwright)).map((r) => r.name)).toEqual(['office-hermes']);
});

test('at 390 px nothing scrolls sideways, on the list, in the chooser and in a form', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', PATH, { viewport: PHONE, mobile: true });
  try {
    await expect(row(page, 'office-hermes')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    for (const r of await page.getByTestId('runner-row').all()) {
      const box = await r.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
    }
    // the old-connections section sits under the list and also fits
    await expect(page.getByTestId('runner-old')).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);

    await page.getByTestId('runner-add').click();
    await expect(page.getByRole('dialog', { name: 'Add a runner' })).toBeVisible();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.getByTestId('runner-kind-hermes_gateway').click();
    await page.getByTestId('runner-teams-several').check();
    expect(await noSidewaysScroll(page)).toBe(true);
    const dialogBox = await page.getByRole('dialog').boundingBox();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(PHONE.width);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await row(page, 'office-hermes').getByRole('button', { name: 'Teams for Office Hermes' }).click();
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
});
