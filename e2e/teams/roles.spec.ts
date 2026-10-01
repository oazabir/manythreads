import { expect, test, type APIRequestContext } from '@playwright/test';
import { SEED_EMAILS } from '../fixtures/seed.ts';
import { csrf, signedInContext, startStack, type Stack } from '../fixtures/stack.ts';

/**
 * PLAN P2 section 4, `teams/roles`: workspace roles and role tags. Settings do not exist below admin (404 for a member);
 * an admin manages member/guest/admin but never touches an owner; the last owner cannot be demoted; a role tag shows on the
 * Roles screen with the people who hold it. Runs on its own stack because it changes people's roles.
 */
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Role flows run on the desktop project');

let stack: Stack;
const ids: Record<string, string> = {};

test.beforeAll(async ({ playwright }) => {
  stack = await startStack();
  const omar = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const { members } = (await (await omar.get('/api/workspace/members')).json()) as { members: { personId: string; email: string }[] };
  for (const m of members) ids[m.email] = m.personId;
  await omar.dispose();
});

test.afterAll(async () => {
  await stack?.stop();
});

const patchRole = async (ctx: APIRequestContext, email: string, role: string) =>
  ctx.patch(`/api/workspace/members/${ids[email]}`, { data: { role }, headers: await csrf(ctx) });

test('an owner makes Priya an admin; settings appear for her, and disappear again when she is demoted', async ({ playwright, browser }) => {
  const omar = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const priya = await signedInContext(playwright, stack, SEED_EMAILS.priya);
  expect((await priya.get('/api/workspace/members')).status()).toBe(404);

  const promoted = await patchRole(omar, SEED_EMAILS.priya, 'admin');
  expect(promoted.status(), await promoted.text()).toBe(200);
  expect((await priya.get('/api/workspace/members')).status()).toBe(200);

  const page = await (await browser.newContext({ storageState: await omar.storageState() })).newPage();
  await page.goto(`${stack.origin}/settings/workspace/members`);
  await expect(page.getByRole('row', { name: /priya@kahf.example.*admin/ })).toBeVisible();

  expect((await patchRole(omar, SEED_EMAILS.priya, 'member')).status()).toBe(200);
  expect((await priya.get('/api/workspace/members')).status()).toBe(404);
  await page.context().close();
  await omar.dispose();
  await priya.dispose();
});

test('an admin cannot grant owner or touch one, and the last owner cannot be demoted', async ({ playwright }) => {
  const omar = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  expect((await patchRole(omar, SEED_EMAILS.priya, 'admin')).status()).toBe(200);
  const priya = await signedInContext(playwright, stack, SEED_EMAILS.priya);

  expect((await patchRole(priya, SEED_EMAILS.nadia, 'owner')).status()).toBe(403);
  expect((await patchRole(priya, SEED_EMAILS.omar, 'member')).status()).toBe(403);
  const lastOwner = await patchRole(omar, SEED_EMAILS.omar, 'admin');
  expect(lastOwner.status()).toBe(409);

  const { members } = (await (await omar.get('/api/workspace/members')).json()) as { members: { email: string; role: string }[] };
  expect(members.find((m) => m.email === SEED_EMAILS.omar)?.role).toBe('owner');
  expect(members.find((m) => m.email === SEED_EMAILS.nadia)?.role).toBe('member');
  await omar.dispose();
  await priya.dispose();
});

test('a role tag given in Engineering shows on the Roles screen with its holder; a plain member gets the 404 page', async ({ playwright, browser }) => {
  const omar = await signedInContext(playwright, stack, SEED_EMAILS.omar);
  const tagged = await omar.put(`/api/teams/engineering/members/${ids[SEED_EMAILS.priya]}/tags/${encodeURIComponent('role:on-call')}`, { headers: await csrf(omar) });
  expect(tagged.status(), await tagged.text()).toBe(200);

  const admin = await (await browser.newContext({ storageState: await omar.storageState() })).newPage();
  await admin.goto(`${stack.origin}/settings/workspace/roles`);
  await expect(admin.getByRole('row', { name: /role:on-call.*engineering.*Priya/ })).toBeVisible();
  await admin.context().close();

  const nadia = await signedInContext(playwright, stack, SEED_EMAILS.nadia);
  const member = await (await browser.newContext({ storageState: await nadia.storageState() })).newPage();
  await member.goto(`${stack.origin}/settings/workspace/roles`);
  await expect(member.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  expect((await nadia.get('/api/workspace/members')).status()).toBe(404);
  await member.context().close();
  await nadia.dispose();
  await omar.dispose();
});
