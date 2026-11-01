import { randomUUID } from 'node:crypto';
import { RESERVED_GROUP_HANDLES } from '@manythreads/shared';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * The `@` picker offers role groups (PLAN P14-03, docs/plugins/channels.md "mention-groups"): a role tag a team defines (`role:ops-x`) is a mention handle
 * (`@ops-x`) for the people who hold it. The picker asks `GET /api/channels/:id/mention-groups` after the first `@`, draws each group below the people with a
 * "Group" badge and "N people", picking one inserts `@handle `, and the posted message shows the handle as a mention chip while every holder (but the author)
 * is told. A word that a person, a bot or the reserved list already owns is never offered. The picker at 390 px stays on the screen.
 *
 * Starts its own stack (it defines role tags). Nadia writes; Priya and Rafi hold `role:ops-<run>` (2 people), Omar holds `role:solo-<run>` (1 person).
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

const T = { timeout: 15_000 };
const RUN = randomUUID().slice(0, 6);
const OPS = `ops-${RUN}`;
const SOLO = `solo-${RUN}`;
const tagOf = (handle: string): string => `role:${handle}`;

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;
let chan = { id: '', name: '' };
let teamId = '';
const ids: Record<string, string> = {};
/** Tags this spec defined, dropped again in afterAll (the stack goes away too, but a reused one stays clean). */
const made: string[] = [];

type Groups = { groups: Array<{ handle: string; tag: string; memberCount: number }> };
const groupsOf = (api: StackApi, channelId = chan.id): Promise<Groups['groups']> => api.get<Groups>(`/api/channels/${channelId}/mention-groups`).then((r) => r.groups);

async function putTag(tag: string, personId: string): Promise<number> {
  const res = await omar.ctx.put(`/api/teams/engineering/members/${personId}/tags/${encodeURIComponent(tag)}`, { headers: await omar.headers() });
  return res.status();
}

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  [omar, nadia, rafi] = (await Promise.all(['omar', 'nadia', 'rafi'].map((who) => apiOn(playwright, stack, who)))) as [StackApi, StackApi, StackApi];
  const priya = await apiOn(playwright, stack, 'priya');
  for (const [who, api] of Object.entries({ omar, nadia, rafi, priya })) ids[who] = (await api.get<{ person: { id: string } }>('/api/session')).person.id;
  await priya.ctx.dispose();
  teamId = (await stack.sql<{ id: string }>(`SELECT id FROM app.teams WHERE slug = 'engineering'`))[0]!.id;

  const name = `role-picker-${RUN}`;
  chan = { id: (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name })).channel.id, name };

  for (const who of ['priya', 'rafi']) expect(await putTag(tagOf(OPS), ids[who]!)).toBe(200);
  expect(await putTag(tagOf(SOLO), ids['omar']!)).toBe(200);
  made.push(tagOf(OPS), tagOf(SOLO));

  // Words that must never be offered: a person (Nadia's email part), a bot (the seeded coder) and a reserved word. The API refuses a new reserved tag, so
  // the reserved one is written the way an old team's tag would exist already: straight into the tables the route writes (as the database owner).
  expect(await putTag('role:nadia', ids['rafi']!)).toBe(200);
  expect(await putTag('role:coder', ids['rafi']!)).toBe(200);
  made.push('role:nadia', 'role:coder');
  await stack.sql(
    `WITH ws AS (SELECT workspace_id FROM app.teams WHERE id = $1),
          role AS (INSERT INTO app.roles (workspace_id, name) SELECT workspace_id, 'role:admin' FROM ws RETURNING id, workspace_id),
          tag AS (INSERT INTO app.team_role_tags (team_id, role_id, workspace_id) SELECT $1, id, workspace_id FROM role RETURNING role_id)
     INSERT INTO app.role_members (role_id, person_id, workspace_id) SELECT id, $2::uuid, workspace_id FROM role`,
    [teamId, ids['rafi']],
  );
  made.push('role:admin');
});
test.afterAll(async () => {
  for (const tag of made) {
    await omar?.ctx.delete(`/api/teams/engineering/tags/${encodeURIComponent(tag)}`, { headers: await omar.headers() }).catch(() => undefined);
  }
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose()]);
  await stack?.stop();
});

const boxOf = (page: Page): Locator => page.getByRole('textbox', { name: `Message #${chan.name}` });
const pickerOf = (page: Page): Locator => page.getByRole('listbox', { name: 'People' });
const groupRow = (page: Page, handle: string): Locator => pickerOf(page).locator(`[role="option"][data-group="${handle}"]`);

test('the server lists the team role groups of the channel with how many readers hold each, and leaves out words a person, a bot or the reserved list owns', async () => {
  const groups = await groupsOf(nadia);
  const byHandle = Object.fromEntries(groups.map((g) => [g.handle, g]));
  expect(byHandle[OPS]).toEqual({ handle: OPS, tag: tagOf(OPS), memberCount: 2 });
  expect(byHandle[SOLO]).toEqual({ handle: SOLO, tag: tagOf(SOLO), memberCount: 1 });
  for (const closed of ['nadia', 'coder', ...RESERVED_GROUP_HANDLES]) expect(byHandle[closed], `@${closed} must not be a group`).toBeUndefined();
  // the team's tag list says why each is closed (a lead reads it), and the reserved tag, when it could be written, is among them
  const tags = (await omar.get<{ tags: Array<{ name: string; closedBy?: string | null; mentionable?: boolean }> }>('/api/teams/engineering/tags')).tags;
  const closedBy = (name: string): string | null | undefined => tags.find((t) => t.name === name)?.closedBy;
  expect(closedBy('role:nadia')).toBe('person');
  expect(closedBy('role:coder')).toBe('bot');
  expect(tags.find((t) => t.name === tagOf(OPS))?.mentionable).toBe(true);
  expect(closedBy('role:admin')).toBe('reserved');
  // handle order
  expect(groups.map((g) => g.handle)).toEqual([...groups.map((g) => g.handle)].sort());
  // a new tag with a reserved word is refused with the plain sentence
  for (const word of ['admin', 'here', 'team']) {
    const res = await omar.ctx.put(`/api/teams/engineering/members/${ids['rafi']}/tags/${encodeURIComponent(tagOf(word))}`, { headers: await omar.headers() });
    expect(res.status(), `role:${word}`).toBe(400);
    expect(await res.text()).toContain('is kept for everyone-style mentions');
  }
});

test.describe('picker', () => {
  test('typing @ lists people first, then the role groups with a Group badge and the number of people', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      const box = boxOf(page);
      await expect(box).toBeVisible(T);
      const asked = page.waitForResponse((r) => r.url().includes(`/api/channels/${chan.id}/mention-groups`) && r.status() === 200);
      await box.pressSequentially('@');
      await asked;
      const list = pickerOf(page);
      await expect(list).toBeVisible();

      const ops = groupRow(page, OPS);
      const solo = groupRow(page, SOLO);
      await expect(ops).toBeVisible(T);
      await expect(solo).toBeVisible(T);
      await expect(ops).toContainText(`@${OPS}`);
      await expect(ops.locator('.pk-badge')).toHaveText('Group');
      await expect(ops.locator('.pk-hint')).toHaveText('2 people');
      await expect(solo.locator('.pk-hint')).toHaveText('1 person');
      // none of the closed words shows up as a group
      for (const closed of ['nadia', 'coder', 'admin']) await expect(groupRow(page, closed)).toHaveCount(0);

      // people come first: no person row after the first group row
      const kinds = await list.getByRole('option').evaluateAll((els) => els.map((el) => (el.hasAttribute('data-group') ? 'group' : 'person')));
      const firstGroup = kinds.indexOf('group');
      expect(firstGroup, 'at least one person row before the groups').toBeGreaterThan(0);
      expect(kinds.slice(firstGroup).every((k) => k === 'group')).toBe(true);
      expect(kinds.slice(0, firstGroup).length).toBeLessThanOrEqual(6);

      // typing narrows the groups by their handle
      await box.pressSequentially(OPS.slice(0, 6));
      await expect(groupRow(page, OPS)).toBeVisible();
      await expect(groupRow(page, SOLO)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('choosing a group inserts "@handle " and the posted message shows the handle as a mention; the holders are told, the author is not', async ({ browser, playwright }) => {
    const token = `deploy window ${RUN}`;
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      const box = boxOf(page);
      await expect(box).toBeVisible(T);
      await box.pressSequentially(`@${OPS.slice(0, 7)}`);
      const row = groupRow(page, OPS);
      await expect(row).toBeVisible(T);
      await row.click();
      await expect(box).toHaveValue(`@${OPS} `);
      await expect(pickerOf(page)).toHaveCount(0);

      await box.pressSequentially(`please watch the ${token}`);
      await page.keyboard.press('Enter');
      const message = page.locator('[data-testid="message"]').filter({ hasText: token });
      await expect(message).toHaveCount(1, T);
      const chip = message.locator(`span.m[data-mention="${OPS}"]`);
      await expect(chip).toHaveText(`@${OPS}`);
      await expect(box).toHaveValue('');

      // Rafi (a holder) has a notification for it; Nadia (the author) and Omar (holds another tag) have none
      await expect.poll(async () => JSON.stringify(await rafi.get('/api/notifications')), T).toContain(token);
      expect(JSON.stringify(await nadia.get('/api/notifications'))).not.toContain(token);
      expect(JSON.stringify(await omar.get('/api/notifications'))).not.toContain(token);
    } finally {
      await context.close();
    }
  });

  test('a reserved word, a person\'s word and a bot\'s word are never offered, whatever is typed', async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`);
    try {
      const box = boxOf(page);
      await expect(box).toBeVisible(T);
      const asked = page.waitForResponse((r) => r.url().includes(`/api/channels/${chan.id}/mention-groups`) && r.status() === 200);
      await box.pressSequentially('@');
      await asked;
      await expect(groupRow(page, OPS)).toBeVisible(T);
      for (const word of ['admin', 'coder', 'nadia']) {
        await box.fill('');
        await box.pressSequentially(`@${word}`);
        // whatever the picker shows (a person, a bot), no row is a group of that word
        await expect(page.locator(`[role="option"][data-group="${word}"]`)).toHaveCount(0);
        await expect(page.locator('[role="option"].pk-group').filter({ hasText: `@${word}` })).toHaveCount(0);
      }
    } finally {
      await context.close();
    }
  });
});

test('at 390 px the picker with its groups stays inside the screen and no row is clipped', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/c/${chan.name}`, { viewport: PHONE, mobile: true });
  try {
    const box = boxOf(page);
    await expect(box).toBeVisible(T);
    await box.click();
    await box.pressSequentially('@');
    const list = pickerOf(page);
    await expect(groupRow(page, OPS)).toBeVisible(T);
    await expect(groupRow(page, SOLO)).toBeVisible(T);

    const frame = (await list.boundingBox())!;
    expect(frame.x).toBeGreaterThanOrEqual(0);
    expect(frame.x + frame.width).toBeLessThanOrEqual(PHONE.width);
    expect(frame.y).toBeGreaterThanOrEqual(0);
    expect(frame.y + frame.height).toBeLessThanOrEqual(PHONE.height);
    expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await noSidewaysScroll(page)).toBe(true);

    const rows = list.getByRole('option');
    const count = await rows.count();
    expect(count).toBeGreaterThan(2);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const label = (await row.innerText()).replace(/\s+/g, ' ').trim();
      const rb = (await row.boundingBox())!;
      expect(rb.x, label).toBeGreaterThanOrEqual(0);
      expect(rb.x + rb.width, label).toBeLessThanOrEqual(PHONE.width);
      // tall enough for its one line of text (the @ picker's rows are about 30 px on the phone, people and groups alike)
      expect(rb.height, `${label}: row height`).toBeGreaterThanOrEqual(28);
      // the row does not scroll sideways, and every part of it (name, badge, count) sits inside the row and the screen
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${label}: row scrolls`).toBe(true);
      for (const part of ['.pk-name', '.pk-badge', '.pk-hint']) {
        const el = row.locator(part);
        if ((await el.count()) === 0) continue;
        const pb = (await el.first().boundingBox())!;
        expect(pb.x, `${label} ${part}`).toBeGreaterThanOrEqual(rb.x - 1);
        expect(pb.x + pb.width, `${label} ${part}`).toBeLessThanOrEqual(Math.min(rb.x + rb.width, PHONE.width) + 1);
        expect(await el.first().evaluate((n) => n.scrollWidth <= n.clientWidth + 1), `${label} ${part}: text cut`).toBe(true);
      }
    }
    // the group row says what it is and how many
    await expect(groupRow(page, OPS).locator('.pk-badge')).toBeVisible();
    await expect(groupRow(page, OPS).locator('.pk-hint')).toHaveText('2 people');

    // a tap picks the group
    await groupRow(page, OPS).tap();
    await expect(box).toHaveValue(`@${OPS} `);
  } finally {
    await context.close();
  }
});
