import { expect, test, type Page } from '@playwright/test';
import { apiAs, createChannel, messages, openAs, postMessage, type Api } from './support.ts';

/**
 * Composer parity (PLAN P14-02, docs/plugins/channels.md): custom emoji, `@here` and `@channel` with a confirmation above 20 people, drafts kept on the
 * server, and three small follow-ups (`/topic` right after a channel opens, `/status :coffee:`). The seeded workspace has seven people, so the
 * "more than 20" screen is driven by answering the reach route with a bigger number; the server's own refusal of an unconfirmed message in a room of 24 is
 * tested against the database in packages/plugins/channels/test/broadcast.test.ts. The reminder sender's "System" badge needs a delivered reminder (a
 * minute job) and is covered by clients/web/test/custom-emoji.test.ts.
 */
test.use({ actionTimeout: 10_000 });
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'the desktop layout');

const T = { timeout: 15_000 };
// a 1x1 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let omar: Api;
let rafi: Api;
let room = { id: '', name: '' };
let emojiName = '';
let emojiId = '';

const box = (page: Page) => page.getByRole('textbox', { name: /^Message/ });

test.beforeAll(async () => {
  omar = await apiAs('omar');
  rafi = await apiAs('rafi');
  room = await createChannel(omar, 'parity');
  emojiName = `parrot_${Date.now().toString(36)}`;
});
test.afterAll(async () => {
  if (emojiId) await omar.ctx.delete(`/api/custom-emoji/${emojiId}`, { headers: await omar.headers() });
  await omar?.ctx.dispose();
  await rafi?.ctx.dispose();
});

test('an admin adds a custom emoji; it shows in the picker, in a message and in a reaction; a member cannot add one', async ({ browser }) => {
  const denied = await rafi.ctx.post('/api/custom-emoji', { data: { name: emojiName, contentType: 'image/png', data: PNG }, headers: await rafi.headers() });
  expect(denied.status()).toBe(403);
  const added = (await omar.post('/api/custom-emoji', { name: emojiName, contentType: 'image/png', data: PNG })) as { id: string };
  emojiId = added.id;
  const posted = await postMessage(rafi, room.id, `ship it :${emojiName}:`);

  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    const row = messages(page).filter({ hasText: 'ship it' });
    await expect(row.locator(`img.cemoji[alt=":${emojiName}:"]`)).toBeVisible(T);
    await expect(row).not.toContainText(`:${emojiName}:`);

    // the picker lists it under Custom, and picking it writes :name: (with a space) into the box
    await box(page).click();
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    const custom = page.getByTestId('emoji-custom');
    await expect(custom).toBeVisible(T);
    await custom.getByRole('button', { name: `:${emojiName}:` }).click();
    await expect(box(page)).toHaveValue(`:${emojiName}: `);
    await box(page).fill('');

    // as a reaction it is drawn as the picture
    await rafi.post(`/api/channels/${room.id}/messages/${posted.id}/reactions`, { emoji: `:${emojiName}:` });
    await page.reload();
    await expect(messages(page).filter({ hasText: 'ship it' }).locator('.rx img.cemoji')).toBeVisible(T);
  } finally {
    await context.close();
  }
});

test('an admin sees the Add form in the picker, a member does not', async ({ browser }) => {
  const asMember = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  const asAdmin = await openAs(browser, 'omar', `/t/engineering/c/${room.name}`);
  try {
    for (const [who, wantAdd] of [[asMember, false], [asAdmin, true]] as const) {
      await box(who.page).click();
      await who.page.getByRole('button', { name: 'Emoji', exact: true }).click();
      const custom = who.page.getByTestId('emoji-custom');
      await expect(custom).toBeVisible(T);
      await expect(custom.getByRole('button', { name: 'Add', exact: true })).toHaveCount(wantAdd ? 1 : 0);
    }
    await asAdmin.page.getByTestId('emoji-custom').getByRole('button', { name: 'Add', exact: true }).click();
    await expect(asAdmin.page.getByRole('form', { name: 'Add a custom emoji' })).toBeVisible(T);
  } finally {
    await asMember.context.close();
    await asAdmin.context.close();
  }
});

test('@channel in a small room is sent at once; in a big room the writer is asked first, and Cancel keeps the text', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    await box(page).click();
    await box(page).pressSequentially('Standup in five @channel');
    await page.keyboard.press('Enter');
    await expect(messages(page).filter({ hasText: 'Standup in five' })).toHaveCount(1, T);
    await expect(page.getByTestId('broadcast-confirm')).toHaveCount(0);

    // the room "grows": the reach route now says 30 people
    await page.route(`**/api/channels/${room.id}/broadcast-reach`, (route) => route.fulfill({ json: { channel: 30, here: 4, confirmAbove: 20 } }));
    await box(page).pressSequentially('All hands now @channel');
    await page.keyboard.press('Enter');
    const ask = page.getByTestId('broadcast-confirm');
    await expect(ask).toContainText('@channel will notify 30 people.', T);
    await expect(messages(page).filter({ hasText: 'All hands now' })).toHaveCount(0);
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await expect(box(page)).toHaveValue('All hands now @channel');

    // @here counts the people online: 4 is under the limit, so it goes at once
    await box(page).fill('A quick look @here');
    await page.keyboard.press('Enter');
    await expect(messages(page).filter({ hasText: 'A quick look' })).toHaveCount(1, T);

    // confirmed: the message goes out and carries the confirmation
    let sent: unknown = null;
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/api/channels/${room.id}/messages`)) sent = r.postDataJSON();
    });
    await box(page).fill('All hands now @channel');
    await page.keyboard.press('Enter');
    await ask.getByRole('button', { name: 'Send anyway' }).click();
    await expect(messages(page).filter({ hasText: 'All hands now' })).toHaveCount(1, T);
    expect(sent).toMatchObject({ confirmBroadcast: true });
    await expect(box(page)).toHaveValue('');
  } finally {
    await context.close();
  }
});

test('@channel in "Send later" asks the same question in a big room, and the agreement goes with the schedule', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    await page.route(`**/api/channels/${room.id}/broadcast-reach`, (route) => route.fulfill({ json: { channel: 30, here: 4, confirmAbove: 20 } }));
    const posts: unknown[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith(`/api/channels/${room.id}/scheduled-messages`)) posts.push(r.postDataJSON());
    });
    await box(page).click();
    await box(page).fill('Release notes tomorrow @channel');
    await page.getByTestId('send-later').click();
    await page.getByTestId('send-later-in60').click();
    const ask = page.getByTestId('broadcast-confirm');
    await expect(ask).toContainText('@channel will notify 30 people.', T);
    // nothing is scheduled until the writer agrees
    expect(posts).toHaveLength(0);
    await expect(box(page)).toHaveValue('Release notes tomorrow @channel');
    await ask.getByRole('button', { name: 'Send anyway' }).click();
    await expect(page.getByTestId('scheduled-count')).toContainText('scheduled', T);
    await expect(box(page)).toHaveValue('');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ body: 'Release notes tomorrow @channel', confirmBroadcast: true });
  } finally {
    await context.close();
  }
});

test('the room grew after the page counted: the refused send stays as Not sent with a Send anyway button, and Discard asks first', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    const bodies: Array<Record<string, unknown>> = [];
    let refusals = 0;
    await page.route(`**/api/channels/${room.id}/messages`, (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON() as Record<string, unknown>);
      if (refusals++ === 0) {
        return route.fulfill({ status: 409, json: { error: { code: 'broadcast_needs_confirmation', message: '@channel will notify 52 people. Confirm to send it.' } } });
      }
      return route.continue();
    });
    await box(page).click();
    await box(page).fill('Late news @channel');
    await page.keyboard.press('Enter');
    const pending = page.getByTestId('pending-message');
    await expect(pending).toContainText('@channel will notify 52 people.', T);
    await expect(pending.getByRole('button', { name: 'Send anyway' })).toBeVisible();
    await expect(pending.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    // Discard loses the text, so it asks; Keep it brings the buttons back
    await pending.getByRole('button', { name: 'Discard' }).click();
    await expect(pending).toContainText('Its text is lost');
    await pending.getByRole('button', { name: 'Keep it' }).click();
    await expect(pending.getByRole('button', { name: 'Send anyway' })).toBeVisible();
    await pending.getByRole('button', { name: 'Send anyway' }).click();
    await expect(messages(page).filter({ hasText: 'Late news' })).toHaveCount(1, T);
    expect(bodies[0]).not.toHaveProperty('confirmBroadcast');
    expect(bodies[1]).toMatchObject({ confirmBroadcast: true });
  } finally {
    await context.close();
  }
});

test('the count is taken again before "Send anyway": a room that grew shows the new number first', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    let people = 30;
    await page.route(`**/api/channels/${room.id}/broadcast-reach`, (route) => route.fulfill({ json: { channel: people, here: 2, confirmAbove: 20 } }));
    await box(page).click();
    await box(page).fill('Recount please @channel');
    await page.keyboard.press('Enter');
    const ask = page.getByTestId('broadcast-confirm');
    await expect(ask).toContainText('@channel will notify 30 people.', T);
    people = 44;
    await ask.getByRole('button', { name: 'Send anyway' }).click();
    // not sent: the new number is on the screen and a second press agrees to it
    await expect(ask).toContainText('@channel will notify 44 people.', T);
    await expect(messages(page).filter({ hasText: 'Recount please' })).toHaveCount(0);
    await ask.getByRole('button', { name: 'Send anyway' }).click();
    await expect(messages(page).filter({ hasText: 'Recount please' })).toHaveCount(1, T);
  } finally {
    await context.close();
  }
});

test('a draft typed on one device is there on another, and sending removes it', async ({ browser }) => {
  const draftsOf = async (): Promise<string[]> => ((await rafi.get(`/api/channels/${room.id}/drafts`)) as { items: { body: string }[] }).items.map((d) => d.body);
  const first = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    await box(first.page).click();
    await box(first.page).pressSequentially('half a thought from my laptop');
    // saved on the server a moment after typing stops
    await expect.poll(draftsOf, { timeout: 15_000 }).toEqual(['half a thought from my laptop']);
  } finally {
    await first.context.close();
  }

  // another device: a new browser context has none of the first one's local storage
  const second = await openAs(browser, 'rafi', `/t/engineering/c/${room.name}`);
  try {
    await expect(box(second.page)).toHaveValue('half a thought from my laptop', T);
    await box(second.page).click();
    await second.page.keyboard.press('Enter');
    await expect(messages(second.page).filter({ hasText: 'half a thought from my laptop' })).toHaveCount(1, T);
    await expect.poll(draftsOf, { timeout: 10_000 }).toEqual([]);
  } finally {
    await second.context.close();
  }
});

test('/topic typed the moment a channel opens does not say it is still loading; /status :coffee: sets the emoji', async ({ browser }) => {
  const fresh = await createChannel(omar, 'parity-topic');
  const { page, context } = await openAs(browser, 'omar', `/t/engineering/c/${fresh.name}`);
  try {
    const input = box(page);
    await input.click();
    await input.pressSequentially('/topic Release planning');
    await page.keyboard.press('Enter');
    const notice = page.getByTestId('slash-notice');
    await expect(notice).not.toContainText('still loading');
    await expect(notice).toContainText('The topic is changed.', T);

    await input.pressSequentially('/status :coffee: on a break');
    await page.keyboard.press('Enter');
    await expect(notice).toContainText('Your status is set.', T);
    expect(((await omar.get('/api/presence/me')) as { status: { emoji: string | null; text: string } | null }).status).toMatchObject({ emoji: '☕', text: 'on a break' });
    await input.pressSequentially('/status clear');
    await page.keyboard.press('Enter');
    await expect(notice).toContainText('Your status is cleared.', T);
  } finally {
    await context.close();
  }
});
