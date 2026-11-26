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

/*
 * P34-05 (owner decision e, 2026-11-19): on a phone the header is the channel's name and the bell; search, the voice room, Members, Add a link (and Bot
 * Board, Schedule a room) are items of the details menu. The Members panel opens from the header icon on a wide screen and from "Members (n)" in the menu on a phone.
 */
async function openMembers(page: Page, isMobile: boolean): Promise<void> {
  if (!isMobile) {
    await page.getByTestId('members-open').click();
    return;
  }
  await expect(page.getByTestId('members-open')).toBeHidden();
  await button(page).click();
  await details(page).getByTestId('details-members-open').click();
  await expect(details(page)).toHaveCount(0);
}

/* every item is on the screen, inside the menu, and not covered or clipped by an ancestor (the element at its centre is the item itself) */
async function expectItemsFullyShown(page: Page, names: (string | RegExp)[]): Promise<void> {
  const vp = page.viewportSize()!;
  const menuBox = (await details(page).boundingBox())!;
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(vp.width + 1);
  expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(vp.height + 1);
  for (const name of names) {
    const item = details(page).getByRole('menuitem', { name });
    await expect(item, String(name)).toBeVisible();
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

test('a direct message offers Notifications, its pinned messages and Summarise only, with the person’s face, status and local time', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', `/t/engineering/dm/${dmId}`);
  try {
    await expect(button(page)).toContainText('Rafi', T);
    await button(page).click();
    // Notifications, the pinned messages of the conversation (P31-07: a DM can pin too) and Brain's private summary of it (P18-05: Summarise is offered on a DM too)
    await expect(details(page).getByRole('menuitem')).toHaveCount(3);
    await expect(details(page).getByRole('menuitem', { name: 'Notifications' })).toBeVisible();
    await expect(details(page).getByTestId('details-pins')).toBeVisible();
    await expect(details(page).getByTestId('details-summarise')).toBeVisible();
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

test('the Members button counts what the members route says and opens the panel: the channel on top, the team members who are not in it below with Add for a lead', async ({ browser, playwright, isMobile }) => {
  const api = await rafi.get<{ members: Array<{ personId: string; displayName: string }> }>(`/api/channels/${first.id}/members`);
  expect(api.members.map((m) => m.displayName), `members of ${first.name}`).toHaveLength(2);
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    const open = page.getByTestId('members-open');
    await expect(open).toHaveAttribute('data-count', String(api.members.length), T);
    await expect(open).toHaveAccessibleName(`Members (${api.members.length})`);
    // one icon, no avatars in the header any more
    expect(await open.locator('.av').count()).toBe(0);
    if (isMobile) {
      // the phone's menu item says the same count
      await button(page).click();
      await expect(details(page).getByTestId('details-members-open')).toHaveText(`Members (${api.members.length})`);
      await button(page).click();
    }
    await openMembers(page, isMobile);
    const panel = page.getByTestId('members-panel');
    await expect(panel).toBeVisible(T);
    await expect(page.getByTestId('panel-title')).toHaveText(`Members of #${first.name}`);
    await expect(page.getByTestId('members-in').getByTestId('member-row')).toHaveCount(api.members.length);
    // Omar leads the team: every person outside has an Add, and the heading counts them
    const outside = page.getByTestId('members-out').getByTestId('member-row');
    expect(await outside.count()).toBeGreaterThan(0);
    await expect(page.getByTestId('members-out').getByTestId('member-add')).toHaveCount(await outside.count());
    const box = (await panel.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
    expect(await noSidewaysScroll(page)).toBe(true);
    // the filter narrows both lists
    await page.getByTestId('members-filter').fill('zzzz-nobody');
    await expect(page.getByTestId('member-row')).toHaveCount(0);
    await page.getByTestId('members-filter').fill('');
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a lead adds a team member to the channel from the Members panel: the row moves up, the count follows, and a plain member sees no Add', async ({ browser, playwright, isMobile }) => {
  const name = `hdr-add-${isMobile ? 'm' : 'd'}`;
  const id = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name })).channel.id;
  const before = (await omar.get<{ members: Array<{ personId: string }> }>(`/api/channels/${id}/members`)).members.length;
  const lead = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${name}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await expect(lead.page.getByTestId('members-open')).toHaveAttribute('data-count', String(before), T);
    await openMembers(lead.page, isMobile);
    const add = lead.page.getByTestId('members-out').getByTestId('member-add').first();
    await expect(add).toBeVisible(T);
    const who = (await add.getAttribute('aria-label'))!.replace(/^Add (.*) to #.*$/, '$1');
    await add.click();
    await expect(lead.page.getByTestId('members-said')).toHaveText(`Added ${who} to #${name}`, T);
    // the row is gone: the keyboard is on the next Add button, or on the list's heading when there is none
    const left = lead.page.getByTestId('members-out').getByTestId('member-add');
    if ((await left.count()) > 0) await expect(left.first()).toBeFocused(T);
    else await expect(lead.page.getByTestId('members-in-head')).toBeFocused(T);
    await expect(lead.page.getByTestId('members-in').getByTestId('member-row').filter({ hasText: who })).toHaveCount(1);
    await expect(lead.page.getByTestId('members-out').getByTestId('member-row').filter({ hasText: who })).toHaveCount(0);
    await expect(lead.page.getByTestId('members-open')).toHaveAttribute('data-count', String(before + 1), T);
    expect((await omar.get<{ members: Array<{ displayName: string }> }>(`/api/channels/${id}/members`)).members.map((m) => m.displayName)).toContain(who);
  } finally {
    await lead.context.close();
  }
  // Rafi is a plain member of the team: he reads the lists, but cannot add
  expect(await rafi.post(`/api/channels/${id}/join`)).toEqual({ joined: true });
  const member = await openOn(browser, playwright, stack, 'rafi', `/t/engineering/c/${name}`, isMobile ? { viewport: PHONE, mobile: true } : {});
  try {
    await openMembers(member.page, isMobile);
    await expect(member.page.getByTestId('members-panel')).toBeVisible(T);
    await expect(member.page.getByTestId('member-add')).toHaveCount(0);
  } finally {
    await member.context.close();
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
    // a wide screen has the search bar always open; on a phone the details menu's "Search this conversation" opens the box in the header (P34-05)
    if (isMobile) {
      await expect(page.getByRole('button', { name: 'Search this conversation' })).toBeHidden();
      await button(page).click();
      await details(page).getByRole('menuitem', { name: 'Search this conversation' }).click();
    }
    const box = page.getByRole('searchbox', { name: 'Search this conversation' });
    if (isMobile) {
      await expect(box).toBeFocused();
      // Escape folds the box, and the keyboard goes back to the channel's name (the magnifier it came from is not on a phone's header)
      await box.press('Escape');
      await expect(box).toHaveCount(0);
      await expect(button(page)).toBeFocused();
      await button(page).click();
      await details(page).getByRole('menuitem', { name: 'Search this conversation' }).click();
      await expect(box).toBeFocused();
    } else await expect(box).toHaveAttribute('placeholder', `Search #${first.name}`);
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
    // nothing is clipped: the text is fully in the box, and the box is inside the screen (on a phone the header is the name and the bell, P34-05, so a
    // 21-character name has the row to itself)
    const fit = await button(page).evaluate((el) => ({ clipped: el.scrollWidth > el.clientWidth + 1 || (el.querySelector('.chd-name')?.scrollWidth ?? 0) > (el.querySelector('.chd-name')?.clientWidth ?? 0) + 1, text: el.textContent ?? '' }));
    expect(fit.clipped).toBe(false);
    expect(fit.text).toContain(longName);
    const box = (await title.boundingBox())!;
    expect(box.width).toBeGreaterThan(longName.length * 5);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  } finally {
    await context.close();
  }
});

test('at 390 px the header is one row, the name and the bell; a 44-character name ends in an ellipsis; the details menu has the header tools first and shows every item fully', async ({ browser, playwright }) => {
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
    const header = page.locator('[data-landmark="header"]');
    await expect(header).toHaveAttribute('data-room', 'phone');
    await expect(header.getByRole('button', { name: /^Notifications/ })).toBeVisible(T);
    // the tools are drawn (hidden) once their data is in: wait for the Members count, so the menu below has it
    await expect(page.getByTestId('members-open')).toHaveAttribute('data-count', /^\d+$/, T);
    // P34-05 (owner decision e, 2026-11-19): the header is the menu button, the name and the bell; no other tool is drawn there
    const buttons = header.getByRole('button').filter({ visible: true });
    const labels: string[] = [];
    const centres: number[] = [];
    for (const b of await buttons.all()) {
      const r = (await b.boundingBox())!;
      const label = (await b.getAttribute('aria-label')) ?? (await b.textContent()) ?? '';
      labels.push(label);
      centres.push(r.y + r.height / 2);
      expect(r.x, `${label} left`).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, `${label} right`).toBeLessThanOrEqual(vpw);
    }
    expect(labels.join('|')).toMatch(/Notification/i);
    expect(labels.join('|')).toMatch(/hdr-x/);
    expect(labels.join('|')).not.toMatch(/Search|Members|Audio call|bookmark|Schedule/i);
    for (const tool of ['members-open', 'call-start', 'bookmark-add', 'conversation-search-open', 'schedule-open']) await expect(page.getByTestId(tool), tool).toBeHidden();
    // one row: the buttons share a line and the header is as tall as one
    expect(Math.max(...centres) - Math.min(...centres), 'the buttons are on one row').toBeLessThanOrEqual(4);
    expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60);
    // the name gives way with an ellipsis (it was two or three lines tall before, P21-23 B13); the whole name is still the button's text
    const name = header.locator('.chd-name');
    const shape = await name.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth, height: el.getBoundingClientRect().height, line: parseFloat(getComputedStyle(el).lineHeight), overflow: getComputedStyle(el).textOverflow }));
    expect(shape.overflow).toBe('ellipsis');
    expect(shape.scroll, 'the long name is cut at the end').toBeGreaterThan(shape.client);
    expect(shape.height, 'the name takes one line').toBeLessThanOrEqual(shape.line + 2);
    await expect(name).toHaveText(`#${longName}`);
    expect(await noSidewaysScroll(page)).toBe(true);
    await button(page).click();
    await expect(details(page)).toBeVisible();
    // the header's tools first, in the header's order, then the menu as it was (the list view of Members steps aside: its twin above opens the panel)
    const items = await details(page).getByRole('menuitem').filter({ visible: true }).allTextContents();
    expect(items.slice(0, 4).map((t) => t.trim())).toEqual(['Search this conversation', 'Audio call', expect.stringMatching(/^Members \(\d+\)$/), 'Add a link']);
    await expectItemsFullyShown(page, ['Search this conversation', 'Audio call', /^Members \(\d+\)$/, 'Add a link', 'Notifications', /^Star$/, 'Schedule a room', 'Integrations', 'Files', 'Leave channel']);
    // the keyboard starts on the first item
    await expect(details(page).getByRole('menuitem', { name: 'Search this conversation' })).toBeFocused();
  } finally {
    await context.close();
  }
});

test('at 390 px each tool moved into the details menu does what its header button does, and the keyboard comes back to the channel name', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', `/t/engineering/c/${first.name}`, { viewport: PHONE, mobile: true });
  try {
    await expect(messagesIn(page).first()).toBeVisible(T);
    await expect(page.getByTestId('members-open')).toHaveAttribute('data-count', /^\d+$/, T);
    // Add a link opens the link dialog; closing it gives the keyboard back to the name
    await button(page).click();
    await details(page).getByTestId('details-bookmark-add').click();
    await expect(details(page)).toHaveCount(0);
    await expect(page.getByTestId('bookmark-dialog')).toBeVisible(T);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('bookmark-dialog')).toHaveCount(0);
    await expect(button(page)).toBeFocused();
    // Schedule a room opens its dialog (it was a menu item on a phone already, P33-08)
    await button(page).click();
    await expect(details(page).getByTestId('details-schedule')).toBeVisible();
    await page.keyboard.press('Escape');
    // Members opens the Members panel
    await openMembers(page, true);
    await expect(page.getByTestId('members-panel')).toBeVisible(T);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('members-panel')).toHaveCount(0);
    expect(await noSidewaysScroll(page)).toBe(true);
  } finally {
    await context.close();
  }
});
