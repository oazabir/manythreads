import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import { STACK_ENV } from '../files/support.ts';
import { REFUSED, apiOn, openPersonal, openSpaceOf, rowAt, statusOf, textOf, uploadAs, type PersonalFileJson, type TreeEntryJson } from '../files/personal-support.ts';

/*
 * P20-06 / P20-07: an owner or admin opens someone's Personal space. A reason is required and is shown to the person; the space is read-only for an hour;
 * the person sees every open in Account > Security. Before an open, and after the hour, the space is closed to the admin too. Own stack, in order, desktop.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone view of the banner is in files/personal-mobile.spec.ts');
test.describe.configure({ mode: 'serial' });

const { nadia, omar, rafi } = personas;
const REASON = 'Nadia is away and we need the handover notes';
const MEMBERS = '/settings/workspace/members';
const SPACE = `/files/person/${nadia.personId}`;

let stack: Stack;
let handover: PersonalFileJson;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  const api = await apiOn(playwright, stack, 'nadia');
  handover = await uploadAs(api, 'Notes', 'handover.md', '# Handover\n\nFirst text of the handover.\n');
  await uploadAs(api, 'Notes', 'figures.csv', 'a,b\n1,2\n', { type: 'text/csv' });
  await api.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('before an open the space is closed to the admin: the screen says to open it first, and the API refuses', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '', { path: SPACE });
  try {
    const closed = page.getByTestId('admin-view-closed');
    await expect(closed).toContainText('Open this Personal space first.');
    await expect(closed).toContainText('with a reason the person can see');
    await expect(closed.getByRole('link', { name: 'Go to Members' })).toHaveAttribute('href', MEMBERS);
    await expect(page.getByTestId('file-row')).toHaveCount(0);
  } finally {
    await close();
  }
  const api = await apiOn(playwright, stack, 'omar');
  try {
    const res = await api.ctx.get(`/api/people/${nadia.personId}/files/tree`);
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain('handover');
    // the file itself is no more readable than the list
    expect(REFUSED).toContain(await statusOf(api, 'GET', `/api/files/${handover.id}/content`));
  } finally {
    await api.ctx.dispose();
  }
});

test('Open Personal space needs a reason: the button waits, the count follows the typing, Cancel opens nothing', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await page.getByRole('button', { name: 'Options for Nadia' }).click();
    await page.getByRole('menuitem', { name: 'Open Personal space' }).click();
    const dialog = page.getByTestId('open-space-dialog');
    await expect(dialog).toContainText('Open Nadia’s Personal space');
    await expect(dialog).toContainText('You will be able to read Nadia’s files for 60 minutes. You cannot change anything.');
    await expect(dialog).toContainText('Nadia will see that you opened it, when, and the reason you give here.');
    const submit = dialog.getByTestId('open-space-submit');
    const reason = dialog.getByTestId('open-space-reason');
    await expect(reason).toBeFocused();
    await expect(submit).toBeDisabled();
    await expect(dialog.getByTestId('open-space-count')).toHaveText('0 of 300 characters');
    // spaces are not a reason
    await reason.fill('   ');
    await expect(dialog.getByTestId('open-space-count')).toHaveText('3 of 300 characters');
    await expect(submit).toBeDisabled();
    await reason.fill(REASON);
    await expect(dialog.getByTestId('open-space-count')).toHaveText(`${REASON.length} of 300 characters`);
    await expect(submit).toBeEnabled();
    // Cancel leaves everything as it was
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${MEMBERS}$`));
    const nadiaApi = await apiOn(playwright, stack, 'nadia');
    try {
      expect((await nadiaApi.get<{ items: unknown[] }>('/api/me/personal-space/opens')).items).toHaveLength(0);
    } finally {
      await nadiaApi.ctx.dispose();
    }

    // and now with a reason: the space opens at /files/person/<id>
    await page.getByRole('button', { name: 'Options for Nadia' }).click();
    await page.getByRole('menuitem', { name: 'Open Personal space' }).click();
    await page.getByTestId('open-space-reason').fill(REASON);
    await page.getByTestId('open-space-submit').click();
    await expect(page).toHaveURL(new RegExp(`${SPACE}$`));
    await expect(page.getByTestId('admin-view-note')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the open space is a read-only look: a banner with the end of the hour, the files, and nothing that changes them', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '', { path: SPACE });
  try {
    const note = page.getByTestId('admin-view-note');
    await expect(note).toContainText('You are reading Nadia’s Personal space.');
    await expect(note).toContainText('It is read-only, and Nadia can see that you opened it.');
    await expect(note).toContainText(/Your access ends at \d{2}:\d{2}\./);
    await expect(page.getByRole('heading', { level: 1, name: 'Files' })).toBeVisible();
    await expect(page.locator('body')).toContainText('Reading Nadia’s Personal space');

    // only her Personal root, no teams; her seven folders
    await expect(page.getByTestId('tree-root')).toHaveCount(1);
    await expect(page.getByTestId('tree-root')).toHaveAttribute('data-root', 'personal');
    await expect(page.locator('[data-testid="file-row"][data-kind="folder"]')).toHaveCount(7);
    // nothing to add: no Upload, New note, New folder, and no allowance line
    await expect(page.getByTestId('files-actions')).toHaveCount(0);
    await expect(page.getByTestId('upload')).toHaveCount(0);
    await expect(page.getByTestId('quota')).toHaveCount(0);

    await rowAt(page, 'Notes').click();
    await expect(rowAt(page, 'Notes/handover.md')).toBeVisible();
    await expect(rowAt(page, 'Notes/figures.csv')).toBeVisible();
    // each file wears the lock, and says what it means
    await rowAt(page, 'Notes/handover.md').getByTestId('why-readonly').click();
    await expect(page.getByTestId('why-readonly-pop')).toContainText('Read-only view');
    await expect(page.getByTestId('why-readonly-pop')).toContainText('Nothing here can be changed, and they can see that you opened it.');
    await page.keyboard.press('Escape');
    // the row menu has Download and no way to change or send the file; the right-click menu is the same
    await rowAt(page, 'Notes/handover.md').getByTestId('row-menu').click();
    await expect(page.getByTestId('row-action-download')).toBeVisible();
    for (const id of ['rename', 'move', 'delete', 'share', 'history']) await expect(page.getByTestId(`row-action-${id}`)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await rowAt(page, 'Notes/handover.md').click({ button: 'right' });
    await expect(page.getByTestId('context-menu').getByRole('menuitem')).toHaveText(['Preview', 'Download']);
    await page.keyboard.press('Escape');
    // no hover buttons for Rename or Send to a team
    await rowAt(page, 'Notes/handover.md').hover();
    await expect(rowAt(page, 'Notes/handover.md').getByTestId('hover-rename')).toHaveCount(0);
    await expect(rowAt(page, 'Notes/handover.md').getByTestId('hover-share')).toHaveCount(0);
    // F2 and Delete do nothing (the right click selected the row; Escape on the row clears that)
    await rowAt(page, 'Notes/handover.md').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('F2');
    await page.keyboard.press('Delete');
    await expect(page.getByTestId('dialog-rename')).toHaveCount(0);
    await expect(page.getByTestId('dialog-delete')).toHaveCount(0);
    // the selection bar has nothing to move or delete
    await rowAt(page, 'Notes/handover.md').getByTestId('row-check').click();
    await expect(page.getByTestId('selection-bar')).toContainText('1 selected');
    await expect(page.getByTestId('selection-move')).toHaveCount(0);
    await expect(page.getByTestId('selection-delete')).toHaveCount(0);
    await page.getByTestId('selection-clear').click();

    // the text can be read, in the middle (an admin's look has no right panel), and cannot be saved or put through History
    await rowAt(page, 'Notes/handover.md').click();
    const view = page.getByTestId('file-view');
    await expect(view).toContainText('First text of the handover.');
    await expect(view.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(view.getByTestId('open-history')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('nothing changes through the API either: the file stays as Nadia wrote it, and the admin tree says every row is read-only', async ({ playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  const owner = await apiOn(playwright, stack, 'nadia');
  try {
    for (const [method, path, data] of [
      ['PATCH', `/api/me/files/${handover.id}`, { name: 'taken.md' }],
      ['DELETE', `/api/me/files/${handover.id}`, undefined],
      ['POST', `/api/me/files/${handover.id}/copy-to-team`, { teamSlug: 'engineering', path: 'pages/taken.md' }],
    ] as const) {
      expect(REFUSED, `${method} ${path}`).toContain(await statusOf(api, method, path, data));
    }
    expect(await statusOf(api, 'DELETE', `/api/files/${handover.id}`)).toBeGreaterThanOrEqual(400);
    expect(await textOf(owner, handover.id)).toBe('# Handover\n\nFirst text of the handover.\n');

    const tree = await api.get<{ entries: TreeEntryJson[]; displayName: string; validUntil: string }>(`/api/people/${nadia.personId}/files/tree?path=Notes`);
    expect(tree.displayName).toBe('Nadia');
    expect(tree.entries.map((e) => e.name).sort()).toEqual(['figures.csv', 'handover.md']);
    expect(tree.entries.every((e) => e.readOnly && e.readOnlyReason === 'admin_view')).toBe(true);
    const minutes = (Date.parse(tree.validUntil) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(50);
    expect(minutes).toBeLessThanOrEqual(60);
    // an admin reads the content during the hour
    expect(await textOf(api, handover.id)).toContain('First text');
  } finally {
    await api.ctx.dispose();
    await owner.ctx.dispose();
  }
});

test('Download as zip: a zip named after the person, with her files inside; Close goes back to Members', async ({ browser, playwright }) => {
  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '', { path: SPACE });
  try {
    // the browser's own "save as" window does not exist in a test: the page falls back to a plain download
    await page.evaluate(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }));
    const download = page.waitForEvent('download');
    await page.getByTestId('admin-view-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('Nadia-files.zip');
    const bytes = readFileSync(await file.path());
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes.includes(Buffer.from('handover.md'))).toBe(true);
    await expect(page.getByTestId('admin-view-export')).toBeEnabled();

    await page.getByTestId('admin-view-close').click();
    await expect(page).toHaveURL(new RegExp(`${MEMBERS}$`));
  } finally {
    await close();
  }
});

test('the person sees the open in Account: who, why and "open now"; nobody else sees it', async ({ browser, playwright }) => {
  const nadiaView = await openOn(browser, playwright, stack, 'nadia', '/account/security');
  try {
    const card = nadiaView.page.getByTestId('personal-opens');
    await expect(card.getByRole('heading', { name: 'Who opened your Personal space' })).toBeVisible();
    const opens = card.getByTestId('personal-open');
    await expect(opens).toHaveCount(1);
    await expect(opens.first()).toContainText('Omar (open now)');
    await expect(opens.first()).toContainText(REASON);
    await expect(opens.first()).toContainText('Opened');
    await expect(opens.first()).toHaveAttribute('data-active', 'true');
    await expect(card.getByTestId('personal-opens-none')).toHaveCount(0);
  } finally {
    await nadiaView.context.close();
  }
  // Rafi's space was never opened: the card says so in words
  const rafiView = await openOn(browser, playwright, stack, 'rafi', '/account/security');
  try {
    await expect(rafiView.page.getByTestId('personal-opens-none')).toContainText('No one has opened your Personal space.');
    await expect(rafiView.page.getByTestId('personal-open')).toHaveCount(0);
  } finally {
    await rafiView.context.close();
  }
  // a member who types the admin's address gets the standard not-found page, and the tab says so
  const memberView = await openOn(browser, playwright, stack, 'nadia', `/files/person/${personas.rafi.personId}`);
  try {
    await expect(memberView.page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await expect(memberView.page).toHaveTitle(/Page not found/);
  } finally {
    await memberView.context.close();
  }
  // a guest has no Personal space and so no card
  const lenaView = await openOn(browser, playwright, stack, 'lena', '/account/security');
  try {
    await expect(lenaView.page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(lenaView.page.getByTestId('personal-opens')).toHaveCount(0);
  } finally {
    await lenaView.context.close();
  }
  // the list is the person's own: Rafi's call returns his, which is empty
  const rafi = await apiOn(playwright, stack, 'rafi');
  try {
    expect((await rafi.get<{ items: unknown[] }>('/api/me/personal-space/opens')).items).toHaveLength(0);
  } finally {
    await rafi.ctx.dispose();
  }
});

test('the API asks for a reason, will not open your own space, and is for owners and admins only', async ({ playwright }) => {
  const admin = await apiOn(playwright, stack, 'omar');
  const member = await apiOn(playwright, stack, 'nadia');
  const guest = await apiOn(playwright, stack, 'lena');
  try {
    for (const bad of [undefined, '', '   ', 'x'.repeat(301)]) {
      expect((await openSpaceOf(admin, rafi.personId, bad)).status, `reason ${JSON.stringify(bad)?.slice(0, 20)}`).toBe(400);
    }
    // your own space is open to you already
    expect((await openSpaceOf(admin, omar.personId, 'Looking at my own')).status).toBe(400);
    // nobody by that id in this workspace
    expect((await openSpaceOf(admin, '00000000-0000-4000-8000-000000000999', 'A person who is not here')).status).toBe(404);
    // a member or a guest cannot open anybody's
    expect((await openSpaceOf(member, rafi.personId, 'I want to read his notes')).status).toBe(403);
    expect((await openSpaceOf(guest, rafi.personId, 'I want to read his notes')).status).toBe(403);
    // none of those left an open behind
    const rafiApi = await apiOn(playwright, stack, 'rafi');
    try {
      expect((await rafiApi.get<{ items: unknown[] }>('/api/me/personal-space/opens')).items).toHaveLength(0);
    } finally {
      await rafiApi.ctx.dispose();
    }
    // a valid one is answered with when it ends
    const ok = await openSpaceOf(admin, rafi.personId, 'Checking the on-call notes');
    expect(ok.status).toBe(200);
    expect(Date.parse(ok.body.validUntil ?? '')).toBeGreaterThan(Date.now());
  } finally {
    await admin.ctx.dispose();
    await member.ctx.dispose();
    await guest.ctx.dispose();
  }
});

test('Members: the menu offers Open Personal space for a member, not for a guest and not for yourself', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await expect(page.getByTestId('member-row')).toHaveCount(7);
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Change role', 'Send a password reset', 'Open Personal space', 'Deactivate']);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Options for Lena' }).click();
    await expect(page.getByRole('menuitem', { name: 'Open Personal space' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Deactivate' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Options for Omar' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Send a password reset']);
  } finally {
    await context.close();
  }
});

test('when the hour lapses the space closes again, for the screen and the API, and the open stops saying "open now"', async ({ browser, playwright }) => {
  await stack.sql("UPDATE app.personal_space_access SET opened_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'");
  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '', { path: SPACE });
  try {
    await expect(page.getByTestId('admin-view-closed')).toBeVisible();
    await expect(page.getByTestId('admin-view-note')).toHaveCount(0);
  } finally {
    await close();
  }
  const api = await apiOn(playwright, stack, 'omar');
  try {
    expect(await statusOf(api, 'GET', `/api/people/${nadia.personId}/files/tree`)).toBe(403);
    expect(REFUSED).toContain(await statusOf(api, 'GET', `/api/files/${handover.id}/content`));
    expect((await statusOf(api, 'POST', `/api/people/${nadia.personId}/personal-space/export`))).toBe(403);
  } finally {
    await api.ctx.dispose();
  }
  const nadiaView = await openOn(browser, playwright, stack, 'nadia', '/account/security');
  try {
    const first = nadiaView.page.getByTestId('personal-open').filter({ hasText: 'Omar' }).first();
    await expect(first).toContainText(REASON);
    await expect(first).not.toContainText('(open now)');
    await expect(first).not.toHaveAttribute('data-active', /.*/);
  } finally {
    await nadiaView.context.close();
  }
  // opening again is a new open: it shows first and is the one that is open now
  const again = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await again.page.getByRole('button', { name: 'Options for Nadia' }).click();
    await again.page.getByRole('menuitem', { name: 'Open Personal space' }).click();
    await again.page.getByTestId('open-space-reason').fill('Second look, for the figures');
    await again.page.getByTestId('open-space-submit').click();
    await expect(again.page.getByTestId('admin-view-note')).toBeVisible();
  } finally {
    await again.context.close();
  }
  const nadiaAgain = await openOn(browser, playwright, stack, 'nadia', '/account/security');
  try {
    const opens = nadiaAgain.page.getByTestId('personal-open');
    await expect(opens).toHaveCount(2);
    await expect(opens.first()).toContainText('Second look, for the figures');
    await expect(opens.first()).toHaveAttribute('data-active', 'true');
    await expect(opens.last()).toContainText(REASON);
    await expect(opens.last()).not.toHaveAttribute('data-active', /.*/);
  } finally {
    await nadiaAgain.context.close();
  }
});
