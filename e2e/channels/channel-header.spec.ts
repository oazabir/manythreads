import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { apiOn, messagesIn, noSidewaysScroll, openOn, PHONE, postAs, type StackApi } from '../support/stack-browser.ts';

/*
 * P21-06: the channel header. The channel's name is a button that opens the details menu (notifications, star, members, integrations, files,
 * Leave); a direct message offers notifications only and shows the other person's face with the presence dot, status and local time; the members
 * stack counts what the members route says; the search magnifier limits results to the conversation. Own stack on the `work` seed (Rafi has a
 * status and a time zone, Lena is a guest of #releases). Desktop and mobile-web both run; the 390 px checks are the point of the phone project.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;
let lena: StackApi;
let rafiId = '';
let first = { id: '', name: '' };
let second = { id: '', name: '' };
let dmId = '';

const T = { timeout: 15_000 };
const details = (page: Page) => page.getByTestId('channel-details');
const button = (page: Page) => page.getByTestId('channel-details-button');

/* every item is on the screen, inside the menu, and not covered or clipped by an ancestor (the element at its centre is the item itself) */
async function expectItemsFullyShown(page: Page, names: string[]): Promise<void> {
  const vp = page.viewportSize()!;
  const menuBox = (await details(page).boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width + 1);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height + 1);
  for (const name of names) {
    const item = details(page).getByRole('menuitem', { name });
    await expect(item, name).toBeVisible();
    const r = (await item.boundingBox())!;
    expect(r.height, `${name} height`).toBeGreaterThan(8);
    expect(r.x, `${name} left`).toBeGreaterThanOrEqual(menuBox.x - 1);
    expect(r.x + r.width, `${name} right`).toBeLessThanOrEqual(menuBox.x + menuBox.width + 1);
    expect(r.y, `${name} top`).toBeGreaterThanOrEqual(menuBox.y - 1);
    expect(r.y + r.height, `${name} bottom in menu`).toBeLessThanOrEqual(menuBox.y + menuBox.height + 1);
    expect(r.y + r.height, `${name} bottom on screen`).toBeLessThanOrEqual(vp.height + 1);
    const hit = await item.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const top = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return top !== null && (top === el || el.contains(top)) ? 'ok' : `${top?.tagName}.${top?.className}[${top?.textContent?.slice(0, 30)}] at ${Math.round(b.x + b.width / 2)},${Math.round(b.y + b.height / 2)}`;
    });
    expect(hit, `${name} is the element at its own centre (not clipped or covered)`).toBe('ok');
  }
}

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  [omar, nadia, rafi, lena] = (await Promise.all(['omar', 'nadia', 'rafi', 'lena'].map((who) => apiOn(playwright, stack, who)))) as [StackApi, StackApi, StackApi, StackApi];
  rafiId = (await rafi.get<{ person: { id: string } }>('/api/session')).person.id;
  const make = async (name: string): Promise<{ id: string; name: string }> => ({ id: (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name })).channel.id, name });
  first = await make('hdr-one');
  second = await make('hdr-two');
  for (const c of [first, second]) {
    await postAs(omar, c.id, `needle-${c.name} first note`);
    await postAs(omar, c.id, 'something else');
  }
  // a member list with a known size, and Rafi's presence facts for the DM header
  for (const c of [first, second]) {
    expect(await rafi.post(`/api/channels/${c.id}/join`)).toEqual({ joined: true });
    expect(await omar.post(`/api/channels/${c.id}/join`)).toEqual({ joined: true });
  }
  const patch = await rafi.ctx.patch('/api/presence/me', { data: { status: { emoji: '🍽️', text: 'Lunch', clearsAt: null }, timeZone: 'Asia/Karachi' }, headers: await rafi.headers() });
  expect(patch.status()).toBe(200);
  await rafi.post('/api/presence', { status: 'online' });
  dmId = (await nadia.post<{ dm: { channel: { id: string } } }>('/api/dms', { personIds: [rafiId] })).dm.channel.id;
  await postAs(nadia, dmId, 'dm-needle hello Rafi');
});
test.afterAll(async () => {
  await Promise.all([omar?.ctx.dispose(), nadia?.ctx.dispose(), rafi?.ctx.dispose(), lena?.ctx.dispose()]);
  await stack?.stop();
});

test('the name opens the details menu; Esc closes it and focus returns to the name button', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`);
  try {
    await expect(button(page)).toContainText(first.name, T);
    await expect(button(page)).toHaveAttribute('aria-haspopup', 'menu');
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
    await button(page).click();
    await expect(details(page)).toBeVisible();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'true');
    await expectItemsFullyShown(page, ['Notifications', 'Star', 'Members', 'Integrations', 'Files', 'Leave channel']);
    // focus moved into the menu
    await expect(details(page).getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);
    await expect(button(page)).toBeFocused();
    await expect(button(page)).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await context.close();
  }
});

test('switching channel closes the menu, and a half-done Leave does not carry to the other channel', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`);
  try {
    await button(page).click();
    await details(page).getByTestId('details-leave').click();
    await expect(details(page).getByTestId('details-leave-confirm')).toContainText(`Leave #${first.name}?`);
    // go to the other channel by the app's own navigation (no reload: the header component stays mounted)
    await page.locator('[data-landmark="sidebar"]').getByRole('link', { name: new RegExp(second.name) }).click();
    await expect(page).toHaveURL(new RegExp(`/c/${second.name}$`));
    await expect(button(page)).toContainText(second.name, T);
    await expect(details(page)).toHaveCount(0);
    await button(page).click();
    await expect(details(page).getByTestId('details-leave-confirm')).toHaveCount(0);
    await expect(details(page).getByTestId('details-leave')).toBeVisible();
    // and the confirm itself: the second press leaves the channel and goes to the team
    await details(page).getByTestId('details-leave').click();
    await details(page).getByTestId('details-leave-confirm').click();
    await expect(page).not.toHaveURL(new RegExp(`/c/${second.name}$`));
    // Omar left the second channel only: he is still in the first
    const left = async (id: string): Promise<boolean> => !(await rafi.get<{ members: Array<{ displayName: string }> }>(`/api/channels/${id}/members`)).members.some((m) => m.displayName === 'Omar');
    expect({ first: await left(first.id), second: await left(second.id) }).toEqual({ first: false, second: true });
  } finally {
    await context.close();
  }
});

test('a direct message offers Notifications only, with the person’s face, status and local time', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/dm/${dmId}`);
  try {
    await expect(button(page)).toContainText('Rafi', T);
    await button(page).click();
    await expect(details(page).getByRole('menuitem')).toHaveCount(1);
    await expect(details(page).getByRole('menuitem', { name: 'Notifications' })).toBeVisible();
    for (const id of ['channel-star', 'details-members', 'webhooks-open', 'details-files', 'details-leave']) await expect(details(page).getByTestId(id)).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(details(page)).toHaveCount(0);

    // the presence dot is on the avatar inside the name button; status and the time there sit beside it
    const dot = button(page).getByTestId('presence-dot');
    await expect(dot).toHaveCount(1, T);
    await expect(dot).toHaveAttribute('data-presence', 'online', T);
    await expect(page.getByTestId('dm-header-status')).toHaveText(/Lunch/, T);
    const time = page.getByTestId('dm-header-time');
    await expect(time).toHaveText(/^\d{1,2}:\d{2} (am|pm) there$/, T);
    // the clock is Karachi's, within two minutes of this process's reading of that zone
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const want = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
    const m = /^(\d{1,2}):(\d{2}) (am|pm)/.exec((await time.textContent()) ?? '')!;
    const got = (Number(m[1]) % 12) * 60 + Number(m[2]) + (m[3] === 'pm' ? 720 : 0);
    expect(Math.min(Math.abs(got - want), 1440 - Math.abs(got - want))).toBeLessThanOrEqual(2);
  } finally {
    await context.close();
  }
});

test('a guest has no Star, Files or Leave in the details menu', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'lena', '/');
  try {
    await expect(page).toHaveURL(/\/c\/releases$/, T);
    await button(page).click();
    await expect(details(page).getByRole('menuitem', { name: 'Notifications' })).toBeVisible();
    for (const id of ['channel-star', 'details-files', 'details-leave', 'details-leave-confirm', 'webhooks-open']) await expect(details(page).getByTestId(id)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the members stack counts what the members route says, and its popover stays on the screen', async ({ browser, playwright, isMobile }) => {
  const api = await rafi.get<{ members: Array<{ personId: string; displayName: string }> }>(`/api/channels/${first.id}/members`);
  expect(api.members.map((m) => m.displayName), `members of ${first.name}`).toHaveLength(2);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const stackBtn = page.getByTestId('members-stack');
    await expect(stackBtn).toHaveAttribute('data-count', String(api.members.length), T);
    await expect(stackBtn).toHaveAccessibleName(`Members (${api.members.length})`);
    expect(await stackBtn.locator('.av').count()).toBeLessThanOrEqual(3);
    await stackBtn.click();
    const menu = page.getByRole('menu', { name: 'Members' });
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('details-member-list').locator('li')).toHaveCount(api.members.length);
    const box = (await menu.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
    expect(await noSidewaysScroll(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the header search is limited to the conversation and stays on the screen at 390 px', async ({ browser, playwright, isMobile }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(messagesIn(page).first()).toBeVisible(T);
    // every header button, the notifications bell included, is inside the screen
    const vpw = page.viewportSize()!.width;
    for (const b of await page.locator('[data-landmark="header"] button:visible').all()) {
      const r = (await b.boundingBox())!;
      expect(r.x + r.width, `${(await b.getAttribute('aria-label')) ?? (await b.textContent())} right edge`).toBeLessThanOrEqual(vpw);
    }
    await page.getByRole('button', { name: 'Search this conversation' }).click();
    const box = page.getByRole('searchbox', { name: 'Search this conversation' });
    await expect(box).toBeFocused();
    const rect = (await box.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(rect.x).toBeGreaterThanOrEqual(0);
    expect(rect.x + rect.width).toBeLessThanOrEqual(vp.width);
    // "needle" is in both channels; only this one's hit may come back
    await box.fill('needle');
    await box.press('Enter');
    const results = page.getByTestId('search-results');
    await expect(results).toContainText('in this conversation', T);
    await expect(results.getByTestId('search-hit')).toHaveCount(1, T);
    await expect(results).toContainText(`needle-${first.name}`);
    await expect(results).not.toContainText(`needle-${second.name}`);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a channel that has just started opens with its intro card: "This is the very beginning of #name" and the day it was created', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`);
  try {
    const start = page.getByTestId('channel-start');
    await expect(start.locator('.start-title')).toHaveText(`This is the very beginning of #${first.name}.`, T);
    // a day, a short month and a year; the channel was made by this run, so the year is this year
    await expect(page.getByTestId('channel-created')).toHaveText(new RegExp(`^Created on \\d{1,2} [A-Z][a-z]{2} ${new Date().getFullYear()}$`));
  } finally {
    await context.close();
  }
});

test('the channel name keeps its whole width with the right panel open', async ({ browser, playwright, isMobile }) => {
  const longName = 'hdr-long-channel-name';
  const id = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: longName })).channel.id;
  const root = await postAs(omar, id, 'a root with a thread');
  await postAs(omar, id, 'a reply', root.id);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${longName}?panel=thread:${root.id}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(page.locator('[data-panel-entry]')).toBeVisible(T);
    await expect(button(page)).toContainText(longName, T);
    const title = page.locator('[data-landmark="header"] .chead-title');
    // nothing is clipped: the text is fully in the box, and the box is inside the screen
    const fit = await button(page).evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth + 1, text: el.textContent ?? '' }));
    expect(fit.clipped).toBe(false);
    expect(fit.text).toContain(longName);
    const box = (await title.boundingBox())!;
    expect(box.width).toBeGreaterThan(longName.length * 5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  } finally {
    await context.close();
  }
});

test('at 390 px the details menu shows every item fully, and a 44-character name keeps every header button on the screen', async ({ browser, playwright }) => {
  const longName = 'hdr-' + 'x'.repeat(40);
  expect(longName).toHaveLength(44);
  const longId = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: longName })).channel.id;
  expect(await rafi.post(`/api/channels/${longId}/join`)).toEqual({ joined: true });
  expect(await omar.post(`/api/channels/${longId}/join`)).toEqual({ joined: true });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${longName}`, { viewport: PHONE, mobile: true });
  try {
    await expect(button(page)).toBeVisible(T);
    expect(page.viewportSize()!.width).toBe(390);
    const vpw = 390;
    // wait for the late tools (members stack, bell) so none is missed by the count below
    await expect(page.getByTestId('members-stack')).toBeVisible(T);
    await expect(page.locator('[data-landmark="header"]').getByRole('button', { name: /^Notifications/ })).toBeVisible(T);
    const buttons = page.locator('[data-landmark="header"]').getByRole('button').filter({ visible: true });
    const labels: string[] = [];
    for (const b of await buttons.all()) {
      const r = (await b.boundingBox())!;
      const label = (await b.getAttribute('aria-label')) ?? (await b.textContent()) ?? '';
      labels.push(label);
      expect(r.x, `${label} left`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${label} right`).toBeLessThanOrEqual(vpw);
    }
    expect(labels.join('|')).toMatch(/Search/i);
    expect(labels.join('|')).toMatch(/Notification/i);
    expect(labels.join('|')).toMatch(/Members/i);
    expect(labels.join('|')).toMatch(/hdr-x/);
    const name = page.locator('[data-landmark="header"] .chd-name');
    // P21-23 (B13): on a phone the name wraps (at most two lines) and is never cut with an ellipsis
    const shape = await name.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight) }));
    expect(shape.scroll, 'the long name is not cut').toBeLessThanOrEqual(shape.client + 1);
    // (a 44-character name with no space in it may take a third line: the bottom-bar spec holds the two-line rule for a 38-character name)
    expect(shape.height, 'the long name takes three lines at the most').toBeLessThanOrEqual(shape.line * 3 + 2);
    await expect(name).toHaveText(`#${longName}`);
    expect(await noSidewaysScroll(page)).toBe(true);
    await button(page).click();
    await expect(details(page)).toBeVisible();
    await expectItemsFullyShown(page, ['Notifications', 'Star', 'Members', 'Integrations', 'Files', 'Leave channel']);
  } finally {
    await context.close();
  }
});
