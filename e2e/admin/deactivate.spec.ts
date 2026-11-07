import { expect, test } from '@playwright/test';
import { personas } from '../fixtures/seed.ts';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PERSONA_PASSWORD, personaEmail } from '../support/env.ts';
import { openOn } from '../support/stack-browser.ts';
import { STACK_ENV } from '../files/support.ts';
import { apiOn, openPersonal, openSpaceOf, rowAt, statusOf, treeOf, uploadAs, type StackApi } from '../files/personal-support.ts';

/*
 * P20-13: Members > Deactivate / Reactivate. A deactivated person cannot sign in and every browser they were signed in on is signed out; their Personal
 * space is kept for 30 days (an admin can still open it) and Reactivate gives everything back. Only an owner touches an owner; you do not deactivate
 * yourself; the workspace always keeps one active owner. Own stack, in order, desktop.
 */
test.skip(({ isMobile }) => isMobile, 'desktop layout');
test.describe.configure({ mode: 'serial' });

const { omar, rafi, tariq, priya, sameera } = personas;
const MEMBERS = '/settings/workspace/members';
const LAST_OWNER = 'A workspace must keep at least one owner who is active; make someone else an owner first';

let stack: Stack;
test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ ...STACK_ENV });
  const api = await apiOn(playwright, stack, 'rafi');
  await uploadAs(api, 'Notes', 'oncall.md', '# On-call\n\nRafi keeps this rota.\n');
  await api.ctx.dispose();
});
test.afterAll(async () => {
  await stack?.stop();
});

const personRow = async (id: string) => (await stack.sql<{ status: string; suspended_at: Date | null }>('SELECT status, suspended_at FROM app.people WHERE id = $1', [id]))[0];
const patch = async (api: StackApi, personId: string, body: unknown): Promise<{ status: number; message: string }> => {
  const res = await api.ctx.patch(`/api/workspace/members/${personId}`, { data: body, headers: await api.headers() });
  const text = await res.text();
  return { status: res.status(), message: text };
};

test('Deactivate says what it does first; Cancel changes nothing; confirming deactivates, signs them out and marks the row', async ({ browser, playwright }) => {
  const rafiOld = await apiOn(playwright, stack, 'rafi');
  expect(await statusOf(rafiOld, 'GET', '/api/me/files/tree')).toBe(200);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    const dialog = page.getByTestId('deactivate-dialog');
    await expect(dialog).toContainText('Deactivate Rafi?');
    await expect(dialog).toContainText('Rafi will not be able to sign in, and every browser they are signed in on is signed out now.');
    await expect(dialog).toContainText('Their Personal space is deleted 30 days from now. Until then you can open it, download it, or reactivate them to keep it.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect((await personRow(rafi.personId))?.status).toBe('active');
    expect(await statusOf(rafiOld, 'GET', '/api/me/files/tree')).toBe(200);

    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    await page.getByTestId('deactivate-confirm').click();
    await expect(page.getByTestId('deactivate-dialog')).toHaveCount(0);
    await expect(page.getByTestId('member-note')).toHaveText('Rafi is deactivated.');
    const row = page.getByTestId('member-row').filter({ hasText: personaEmail('rafi') });
    await expect(row.getByTestId('member-deactivated')).toHaveText('Deactivated');
    // the menu now offers the way back, and not the way out
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await expect(page.getByRole('menuitem')).toHaveText(['Change role', 'Send a password reset', 'Open Personal space', 'Reactivate']);
    await page.keyboard.press('Escape');

    const after = await personRow(rafi.personId);
    expect(after?.status).toBe('suspended');
    expect(after?.suspended_at).not.toBeNull();
    // the browser he was signed in on is signed out now
    expect([401, 403, 404]).toContain(await statusOf(rafiOld, 'GET', '/api/me/files/tree'));
    expect([401, 403, 404]).toContain(await statusOf(rafiOld, 'GET', '/api/me/files/usage'));
    // and a password does not let him back in
    const fresh = await playwright.request.newContext({ baseURL: stack.origin });
    try {
      const res = await fresh.post('/api/auth/password/sign-in', { data: { email: personaEmail('rafi'), password: PERSONA_PASSWORD } });
      expect(res.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await fresh.dispose();
    }
  } finally {
    await context.close();
    await rafiOld.ctx.dispose();
  }
});

test('a deactivated person\'s Personal space is kept: an admin can still open and read it', async ({ browser, playwright }) => {
  const api = await apiOn(playwright, stack, 'omar');
  try {
    expect((await openSpaceOf(api, rafi.personId, 'Rafi has left; collecting the on-call rota')).status).toBe(200);
  } finally {
    await api.ctx.dispose();
  }
  const { page, close } = await openPersonal(browser, playwright, stack, 'omar', '?path=Notes', { path: `/files/person/${rafi.personId}` });
  try {
    await expect(page.getByTestId('admin-view-note')).toContainText('You are reading Rafi’s Personal space.');
    await expect(rowAt(page, 'Notes/oncall.md')).toBeVisible();
  } finally {
    await close();
  }
});

test('Reactivate gives it all back: they can sign in, the files are there, the 30 day clock is off', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await page.getByRole('menuitem', { name: 'Reactivate' }).click();
    await expect(page.getByTestId('member-note')).toHaveText('Rafi can sign in again.');
    const row = page.getByTestId('member-row').filter({ hasText: personaEmail('rafi') });
    await expect(row.getByTestId('member-deactivated')).toHaveCount(0);
    await page.getByRole('button', { name: 'Options for Rafi' }).click();
    await expect(page.getByRole('menuitem', { name: 'Deactivate' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Reactivate' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await context.close();
  }
  const after = await personRow(rafi.personId);
  expect(after?.status).toBe('active');
  expect(after?.suspended_at).toBeNull();
  const api = await apiOn(playwright, stack, 'rafi');
  try {
    expect((await treeOf(api, 'Notes')).map((e) => e.name)).toEqual(['oncall.md']);
  } finally {
    await api.ctx.dispose();
  }
});

test('who may deactivate whom: not yourself, not an owner unless you are one, and an admin may deactivate a member', async ({ browser, playwright }) => {
  const owner = await apiOn(playwright, stack, 'omar');
  try {
    // your own account: 400, with words
    const self = await patch(owner, omar.personId, { status: 'suspended' });
    expect(self.status).toBe(400);
    expect(self.message).toContain('You cannot deactivate your own account');
    expect((await personRow(omar.personId))?.status).toBe('active');
    // Omar's own menu has no Deactivate and no Open Personal space
    const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
    try {
      await page.getByRole('button', { name: 'Options for Omar' }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['Send a password reset']);
    } finally {
      await context.close();
    }

    // Priya becomes an admin: she may deactivate a member, and not the owner
    expect((await patch(owner, priya.personId, { role: 'admin' })).status).toBe(200);
    const admin = await apiOn(playwright, stack, 'priya');
    try {
      const onOwner = await patch(admin, omar.personId, { status: 'suspended' });
      expect(onOwner.status).toBe(403);
      expect(onOwner.message).toContain('Only an owner can change an owner');
      expect((await personRow(omar.personId))?.status).toBe('active');
      expect((await patch(admin, omar.personId, { role: 'member' })).status).toBe(403);
      expect((await patch(admin, sameera.personId, { status: 'suspended' })).status).toBe(200);
      expect((await personRow(sameera.personId))?.status).toBe('suspended');
      expect((await patch(admin, sameera.personId, { status: 'active' })).status).toBe(200);
      // her Members menu hides the owner's Deactivate
      const view = await openOn(browser, playwright, stack, 'priya', MEMBERS);
      try {
        await view.page.getByRole('button', { name: 'Options for Omar' }).click();
        await expect(view.page.getByRole('menuitem', { name: 'Deactivate' })).toHaveCount(0);
        await view.page.keyboard.press('Escape');
        await view.page.getByRole('button', { name: 'Options for Sameera' }).click();
        await expect(view.page.getByRole('menuitem', { name: 'Deactivate' })).toBeVisible();
      } finally {
        await view.context.close();
      }
    } finally {
      await admin.ctx.dispose();
    }
    // a plain member gets nothing from the route
    const member = await apiOn(playwright, stack, 'nadia');
    try {
      expect((await patch(member, rafi.personId, { status: 'suspended' })).status).toBe(404);
    } finally {
      await member.ctx.dispose();
    }
  } finally {
    await owner.ctx.dispose();
  }
});

test('the last active owner stays: the server says so with a 409, and the dialog shows the sentence and stays open', async ({ browser, playwright }) => {
  const owner = await apiOn(playwright, stack, 'omar');
  try {
    // two owners: Omar may deactivate Tariq (Omar stays)
    expect((await patch(owner, tariq.personId, { role: 'owner' })).status).toBe(200);
    expect((await patch(owner, tariq.personId, { status: 'suspended' })).status).toBe(200);
    // Omar is now the only active owner: stepping down is refused, and nothing changed
    const stepDown = await patch(owner, omar.personId, { role: 'admin' });
    expect(stepDown.status).toBe(409);
    expect(stepDown.message).toContain(LAST_OWNER);
    const role = await stack.sql<{ role: string }>('SELECT role FROM app.workspace_members WHERE person_id = $1', [omar.personId]);
    expect(role[0]?.role).toBe('owner');
    // Tariq comes back
    expect((await patch(owner, tariq.personId, { status: 'active' })).status).toBe(200);
  } finally {
    await owner.ctx.dispose();
  }

  // On the screen the same refusal is a sentence in the dialog. The only way to reach it with real data is two owners acting in the same moment, so the
  // answer of the server is put in place by hand here.
  const { page, context } = await openOn(browser, playwright, stack, 'omar', MEMBERS);
  try {
    await page.route('**/api/workspace/members/*', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'conflict', message: LAST_OWNER } }) });
    });
    await page.getByRole('button', { name: 'Options for Tariq' }).click();
    await page.getByRole('menuitem', { name: 'Deactivate' }).click();
    const dialog = page.getByTestId('deactivate-dialog');
    await dialog.getByTestId('deactivate-confirm').click();
    await expect(dialog.getByRole('alert')).toContainText(LAST_OWNER);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('deactivate-confirm')).toBeEnabled();
    await expect(page.getByTestId('member-note')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect((await personRow(tariq.personId))?.status).toBe('active');
});
