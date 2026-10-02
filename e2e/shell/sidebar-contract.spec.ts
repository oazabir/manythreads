import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { openOn } from '../support/stack-browser.ts';
import type { PersonaKey } from '../support/env.ts';

/**
 * PLAN phase 3 criterion 10, second half and the exit line "the sidebar matches the contract for every persona including Lena":
 * Files (10) · Boards (20) · Threads (30) · Approvals (35) · channel groups (40) · Direct messages (45) · Bots (50), in exactly that
 * order for each of the seven people (a guest sees the one entry that allows guests: the channels she was granted). The sections are
 * read from the page, in DOM order, on a stack with the seed's channels.
 */
test.use({ actionTimeout: 10_000 });
test.skip(({ isMobile }) => isMobile, 'desktop layout; the phone drawer holds the same rows (e2e/shell/shell.spec.ts)');

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack({ MANYTHREADS_STACK_SEED: 'content' });
});
test.afterAll(async () => {
  await stack?.stop();
});

const CONTRACT = ['Files', 'Boards', 'Threads', 'Approvals', 'channel groups', 'Direct messages', 'Bots'];

const PEOPLE: ReadonlyArray<[PersonaKey, string[]]> = [
  ['omar', CONTRACT],
  ['nadia', CONTRACT],
  ['rafi', CONTRACT],
  ['priya', CONTRACT],
  ['sameera', CONTRACT],
  ['tariq', CONTRACT],
  ['lena', ['channel groups']],
];

for (const [key, expected] of PEOPLE) {
  test(`${key}: the sidebar is the contract, in order${key === 'lena' ? ' (guest: the granted channels only)' : ''}`, async ({ browser, playwright }) => {
    const { page, context } = await openOn(browser, playwright, stack, key, '/');
    try {
      const sidebar = page.locator('[data-landmark="sidebar"]');
      await expect(sidebar).toBeVisible();
      // the channel groups and, for a member, the team's sections have arrived
      await expect(sidebar.locator('.channel-groups .group').first()).toBeVisible();
      const sections = await sidebar.locator(':scope > *').evaluateAll((children) =>
        children.flatMap((el) => {
          if (el.classList.contains('channel-groups')) return ['channel groups'];
          if (el.classList.contains('sec')) return [(el.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/(No conversations yet|No bots yet)$/, '').trim()];
          if (el.classList.contains('it') && !el.classList.contains('dm-new-btn')) return [(el.querySelector('.it-label')?.textContent ?? '').trim()];
          return []; // the rows and the "New" button that belong to Direct messages
        }),
      );
      expect(sections).toEqual(expected);
      // the order is also the `order` of the contract entries (10, 20, 30, 35, 40, 45, 50), so a persona-specific reordering cannot hide here
      const channelGroupsAt = await sidebar.locator(':scope > *').evaluateAll((els) => els.findIndex((e) => e.classList.contains('channel-groups')));
      expect(channelGroupsAt).toBe(key === 'lena' ? 0 : 4);
    } finally {
      await context.close();
    }
  });
}

test('priya (two teams): the second team has the same contract', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'priya', '/t/marketing/threads');
  try {
    const sidebar = page.locator('[data-landmark="sidebar"]');
    await expect(sidebar.locator('.channel-groups .group').first()).toBeVisible();
    const labels = await sidebar.locator(':scope > .it').evaluateAll((els) => els.filter((e) => !e.classList.contains('dm-new-btn')).map((e) => (e.querySelector('.it-label')?.textContent ?? '').trim()));
    expect(labels).toEqual(['Files', 'Boards', 'Threads', 'Approvals']);
    await expect(sidebar.locator(':scope > .sec')).toHaveText([/^Direct messages/, /^Bots/]);
  } finally {
    await context.close();
  }
});
