import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, apiOn, channelsOf, noSidewaysScroll, openOn, type StackApi } from '../support/stack-browser.ts';

/**
 * Polls (PLAN P14-07), on a stack of its own (the spec posts messages and polls). Omar asks a poll from the composer's Poll button and from `/poll`;
 * Nadia and Rafi vote from their own pages and every page's counts move without a reload. An anonymous poll never lists who voted, and is only
 * asked in a channel with at least 5 readers (a private room of 6 is made for it, with Tariq and Sameera added to Engineering, and a room of 2 for the refusal). The author closes a poll early and its
 * result appears as a plain message. Options are toggle buttons (a click votes; an arrow key does not). At 390 px the card fits, a count changing
 * moves nothing, and "Your vote" never lands on the option text or the count.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'the desktop layout; the 390 px phone is opened with its own viewport below');
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let dev = '';
let room = '';
let small = '';

test.beforeAll(async ({ playwright }) => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'work' });
  omar = await apiOn(playwright, stack, 'omar');
  dev = (await channelsOf(omar))['dev']!;
  // a private room of six readers (Omar and five more), for the anonymous poll
  room = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'poll-room', private: true })).channel.id;
  // a private room of two (Omar and Nadia, added below), too small for an anonymous poll
  small = (await omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name: 'poll-small', private: true })).channel.id;
  // Engineering holds Omar, Nadia, Rafi and Priya; a channel only takes people of its team, so Tariq and Sameera join the team first
  for (const who of ['nadia', 'rafi', 'priya', 'tariq', 'sameera']) {
    const api = await apiOn(playwright, stack, who);
    const me = await api.get<{ person: { id: string } }>('/api/session');
    if (who === 'tariq' || who === 'sameera') await omar.post('/api/teams/engineering/members', { personId: me.person.id });
    if (who === 'nadia') await omar.post(`/api/channels/${small}/members`, { personId: me.person.id });
    await omar.post(`/api/channels/${room}/members`, { personId: me.person.id });
    await api.ctx.dispose();
  }
});
test.afterAll(async () => {
  await omar?.ctx.dispose();
  await stack?.stop();
});

const box = (page: Page) => page.getByRole('textbox', { name: 'Message #dev' });
const card = (page: Page, question: string) => page.getByTestId('poll').filter({ hasText: question });
const choice = (poll: ReturnType<typeof card>, name: RegExp | string) => poll.getByRole('button', { name });

test('the Poll button opens a dialog; a poll is asked with two options and shown as a card with a group of toggle buttons', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    await box(page).click(); // the toolbar opens with the caret
    await page.getByTestId('poll-tool').click();
    const dlg = page.getByTestId('poll-dialog');
    await expect(dlg).toBeVisible();
    // an incomplete form is explained, nothing is posted
    await dlg.getByTestId('poll-create').click();
    await expect(dlg.getByTestId('poll-form-error')).toContainText('Write the question');
    await dlg.getByTestId('poll-question').fill('Where do we eat on Friday?');
    await dlg.getByTestId('poll-option-input').nth(0).fill('Pizza');
    await dlg.getByTestId('poll-option-input').nth(1).fill('Sushi');
    await dlg.getByTestId('poll-add-option').click();
    await dlg.getByTestId('poll-option-input').nth(2).fill('Soup');
    await dlg.getByTestId('poll-create').click();
    await expect(dlg).toBeHidden();
    const poll = card(page, 'Where do we eat on Friday?');
    await expect(poll).toBeVisible();
    await expect(poll.getByTestId('poll-choice')).toHaveCount(3);
    await expect(poll.getByRole('group', { name: 'Where do we eat on Friday?' })).toBeVisible();
    await expect(poll.getByRole('button', { pressed: true })).toHaveCount(0);
    await expect(poll.getByTestId('poll-voters')).toHaveText('No votes yet');
  } finally {
    await context.close();
  }
});

test('/poll with quoted pieces asks the poll at once; a half-typed one opens the form with what was typed; /poll alone opens the form', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  try {
    const input = box(page);
    await input.click();
    await input.fill('/poll "Standup time?" "9:30" "10:00"');
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('');
    await expect(card(page, 'Standup time?').getByTestId('poll-choice')).toHaveCount(2);

    // one option is not enough: nothing is posted and nothing typed is lost, the form opens with the question and the option filled in
    await input.fill('/poll "Only one" "A"');
    await page.keyboard.press('Enter');
    const dlg = page.getByTestId('poll-dialog');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('poll-question')).toHaveValue('Only one');
    await expect(dlg.getByTestId('poll-option-input').nth(0)).toHaveValue('A');
    await expect(dlg.getByTestId('poll-option-input').nth(1)).toHaveValue('');
    await expect(card(page, 'Only one')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();

    await input.fill('/poll');
    await page.keyboard.press('Enter');
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId('poll-question')).toHaveValue('');
    await page.keyboard.press('Escape');
    await expect(dlg).toBeHidden();
  } finally {
    await context.close();
  }
});

test('votes move the counts live on every page; a vote can be changed and removed; the voter’s own choice is marked; arrow keys do not vote', async ({ browser, playwright }) => {
  const author = await apiOn(playwright, stack, 'omar');
  await author.post(`/api/channels/${dev}/polls`, { question: 'Live count?', options: ['Yes', 'No'] });
  const a = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  const b = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/c/dev');
  try {
    const pa = card(a.page, 'Live count?');
    const pb = card(b.page, 'Live count?');
    await expect(pa).toBeVisible();
    await expect(pb).toBeVisible();
    // moving through the options with the arrow keys casts nothing
    await choice(pb, /Yes/).focus();
    await b.page.keyboard.press('ArrowDown');
    await b.page.keyboard.press('ArrowUp');
    await expect(pb.getByTestId('poll-voters')).toHaveText('No votes yet');
    await choice(pa, /Yes/).click();
    await expect(pa.getByTestId('poll-voters')).toHaveText('1 vote');
    await expect(choice(pa, /Yes/)).toHaveAttribute('aria-pressed', 'true');
    // Rafi did nothing and his page already shows it, with no vote of his own marked
    await expect(pb.getByTestId('poll-voters')).toHaveText('1 vote');
    await expect(pb.getByTestId('poll-option').first()).toHaveAttribute('data-votes', '1');
    await expect(pb.getByRole('button', { pressed: true })).toHaveCount(0);
    // the counts are read out with each option
    await expect(choice(pb, /Yes/)).toHaveAccessibleDescription(/1 vote, 100 percent/);
    await choice(pb, /No/).click();
    await expect(pa.getByTestId('poll-voters')).toHaveText('2 votes');
    await expect(pb.getByTestId('poll-option').nth(1)).toHaveAttribute('data-mine', 'true');
    await expect(pa.getByTestId('poll-option').nth(1)).toHaveAttribute('data-mine', 'false');
    // change the vote
    await choice(pb, /Yes/).click();
    await expect(pa.getByTestId('poll-option').first()).toHaveAttribute('data-votes', '2');
    await expect(pa.getByTestId('poll-voters')).toHaveText('2 votes');
    // remove it
    await pb.getByRole('button', { name: 'Remove my vote' }).click();
    await expect(pa.getByTestId('poll-voters')).toHaveText('1 vote');
    await expect(pb.getByRole('button', { pressed: true })).toHaveCount(0);
    // a named poll lists who voted for what
    await pa.getByRole('button', { name: 'Show who voted' }).click();
    await expect(pa.getByTestId('poll-who')).toContainText('Nadia');
  } finally {
    await a.context.close();
    await b.context.close();
    await author.ctx.dispose();
  }
});

test('an anonymous poll lists nobody, to the author as to anyone; several choices are several pressed buttons; a small channel refuses it', async ({ browser, playwright }) => {
  // two readers: below 5 an anonymous poll is refused with a sentence, and nothing is posted
  const refused = await omar.ctx.post(`/api/channels/${small}/polls`, {
    data: { question: 'Too small?', options: ['Yes', 'No'], anonymous: true },
    headers: await omar.headers(),
  });
  expect(refused.status()).toBe(400);
  expect(await refused.text()).toContain('at least 5 people');

  await omar.post(`/api/channels/${room}/polls`, { question: 'Secret lunch?', options: ['Pizza', 'Sushi', 'Soup'], anonymous: true, multiple: true });
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/poll-room');
  try {
    const poll = card(page, 'Secret lunch?');
    await expect(poll.getByTestId('poll-choice')).toHaveCount(3);
    await choice(poll, /Pizza/).click();
    // a click while a vote is in flight is ignored by the card, so wait for the first to settle
    await expect(choice(poll, /Pizza/)).toHaveAttribute('aria-pressed', 'true');
    await expect(poll.getByTestId('poll-voters')).toHaveText('1 vote');
    await choice(poll, /Soup/).click();
    await expect(poll.getByRole('button', { pressed: true })).toHaveCount(2);
    await expect(poll.getByTestId('poll-voters')).toHaveText('1 vote');
    await expect(poll).toContainText('Anonymous');
    await expect(poll.getByRole('button', { name: /who voted/ })).toHaveCount(0);
    const results = await omar.get<{ voters: unknown }>(`/api/channels/${room}/polls/${await poll.getAttribute('data-poll-id')}`);
    expect(results.voters).toBeNull();
  } finally {
    await context.close();
  }
});

test('the author closes a poll early: the card closes for everyone and the result is posted as a plain message', async ({ browser, playwright }) => {
  await omar.post(`/api/channels/${dev}/polls`, { question: 'Close me?', options: ['Yes', 'No'] });
  const o = await openOn(browser, playwright, stack, 'omar', '/t/engineering/c/dev');
  const n = await openOn(browser, playwright, stack, 'nadia', '/t/engineering/c/dev');
  try {
    const mine = card(o.page, 'Close me?');
    const theirs = card(n.page, 'Close me?');
    await choice(theirs, /Yes/).click();
    await expect(mine.getByTestId('poll-voters')).toHaveText('1 vote');
    // an ordinary reader is not offered the button
    await expect(theirs.getByRole('button', { name: 'Close poll' })).toHaveCount(0);
    await mine.getByRole('button', { name: 'Close poll' }).click();
    await mine.getByRole('button', { name: 'Close the poll now' }).click();
    await expect(mine).toHaveAttribute('data-closed', 'true');
    await expect(theirs).toHaveAttribute('data-closed', 'true');
    await expect(theirs.getByTestId('poll-choice').first()).toBeDisabled();
    await expect(n.page.getByTestId('message').filter({ hasText: 'Poll closed early: Close me?' })).toContainText('Yes: 1 vote (100%)');
  } finally {
    await o.context.close();
    await n.context.close();
  }
});

test('a deleted poll is gone for everyone: no results, no vote, and the card does not come back', async ({ playwright }) => {
  const made = await omar.post<{ id: string; poll: { id: string } }>(`/api/channels/${dev}/polls`, { question: 'Delete me?', options: ['Yes', 'No'] });
  const nadia = await apiOn(playwright, stack, 'nadia');
  try {
    const gone = await omar.ctx.delete(`/api/channels/${dev}/messages/${made.id}`, { headers: await omar.headers() });
    expect(gone.status()).toBeLessThan(300);
    expect((await nadia.ctx.get(`/api/channels/${dev}/polls/${made.poll.id}`)).status()).toBe(404);
    const voted = await nadia.ctx.put(`/api/channels/${dev}/polls/${made.poll.id}/vote`, { data: { options: [0] }, headers: await nadia.headers() });
    expect(voted.status()).toBeGreaterThanOrEqual(400);
  } finally {
    await nadia.ctx.dispose();
  }
});

test('at 390 px the card and the dialog fit, a count changing moves nothing, and "Your vote" never covers the text or the count', async ({ browser, playwright }) => {
  await omar.post(`/api/channels/${dev}/polls`, { question: 'A rather long question so that it needs more than one line on a phone screen?', options: ['A fairly long first option', 'Short', 'Another long enough option text here'] });
  const phone = await openOn(browser, playwright, stack, 'rafi', '/t/engineering/c/dev', { viewport: PHONE, mobile: true });
  try {
    const poll = card(phone.page, 'A rather long question');
    await expect(poll).toBeVisible();
    await poll.scrollIntoViewIfNeeded();
    expect(await noSidewaysScroll(phone.page)).toBe(true);
    const before = await poll.boundingBox();
    // Nadia votes from the API as another person's page would; the push changes the counts under Rafi's open page
    const nadia = await apiOn(playwright, stack, 'nadia');
    const id = await poll.getAttribute('data-poll-id');
    const voted = await nadia.ctx.put(`/api/channels/${dev}/polls/${id}/vote`, { data: { options: [1] }, headers: await nadia.headers() });
    expect(voted.status()).toBe(200);
    await expect(poll.getByTestId('poll-voters')).toHaveText('1 vote');
    const after = await poll.boundingBox();
    expect(after!.height).toBe(before!.height);
    expect(after!.width).toBe(before!.width);
    expect(await noSidewaysScroll(phone.page)).toBe(true);
    await nadia.ctx.dispose();

    // Rafi's own vote on the longest option: the card keeps its size and "Your vote" sits clear of the option text and of the count
    await choice(poll, /A fairly long first option/).click();
    const first = poll.getByTestId('poll-option').first();
    await expect(first).toHaveAttribute('data-mine', 'true');
    const text = (await first.locator('.poll-text').boundingBox())!;
    const you = (await first.locator('.poll-you').boundingBox())!;
    const count = (await first.locator('.poll-count').boundingBox())!;
    const apart = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
      a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
    expect(apart(you, text), 'Your vote overlaps the option text').toBe(true);
    expect(apart(you, count), 'Your vote overlaps the count').toBe(true);
    expect(await noSidewaysScroll(phone.page)).toBe(true);

    // the dialog
    await phone.page.getByRole('textbox', { name: 'Message #dev' }).click(); // the toolbar opens with the caret
    await phone.page.getByTestId('poll-tool').click();
    const dlg = phone.page.getByTestId('poll-dialog');
    await expect(dlg).toBeVisible();
    const dialogBox = await dlg.boundingBox();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(390);
  } finally {
    await phone.context.close();
  }
});
