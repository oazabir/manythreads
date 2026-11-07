import { expect, test } from '@playwright/test';
import { startStack, type Stack } from '../fixtures/stack.ts';
import { PHONE, openOn } from '../support/stack-browser.ts';

/*
 * The settings navigation (PLAN P21-19, POLISH 6.2): grouped (People, Bots and models, Security, Operations), an icon on every item, and it stays
 * in view, scrolling inside itself when it is taller than the screen. A member sees only Account and Teams.
 */
let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const GROUPS: Record<string, string[]> = {
  People: ['General', 'Members', 'Roles', 'Sign-in'],
  'Bots and models': ['LLM', 'Runners', 'Brain', 'Memory sharing'],
  Security: ['Data protection', 'Domain & HTTPS', 'Audit'],
  Operations: ['Setup', 'System health', 'Usage', 'Import'],
};

test('an admin sees four workspace groups in order, with an icon on each item', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'on a phone the groups are the optgroups of the section select (members.spec.ts)');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/general');
  try {
    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.locator('.tgrp').first()).toBeVisible();
    const headings = await nav.locator('.tgrp').allTextContents();
    expect(headings.slice(0, 6)).toEqual(['Account', 'People', 'Bots and models', 'Security', 'Operations', 'Teams']);
    for (const [heading, items] of Object.entries(GROUPS)) {
      const group = nav.getByRole('group', { name: heading, exact: true });
      await expect(group.locator('.tab-label')).toHaveText(items);
      await expect(group.locator('.tab-ico svg')).toHaveCount(items.length);
    }
    await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveClass(/\bon\b/);
    await expect(nav.getByRole('link', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'Members', exact: true })).not.toHaveAttribute('aria-current', 'page');
    await nav.getByRole('link', { name: 'Members', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/workspace\/members$/);
    await expect(page).toHaveTitle(/^Members · /);
  } finally {
    await context.close();
  }
});

test('the navigation is sticky and, on a 700 px high screen, scrolls inside itself', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the side navigation is hidden on a phone');
  const { page, context } = await openOn(browser, playwright, stack, 'omar', '/settings/workspace/general', { viewport: { width: 1440, height: 700 } });
  try {
    const sticky = page.locator('.tabs-sticky');
    const style = await sticky.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { position: cs.position, top: cs.top, overflowY: cs.overflowY };
    });
    expect(style).toEqual({ position: 'sticky', top: '0px', overflowY: 'auto' });
    const box = await sticky.boundingBox();
    expect(box?.height ?? 0).toBeLessThanOrEqual(700);
    // too tall for 700 px: the list scrolls inside itself and the last item can be reached
    const scrolls = await sticky.evaluate((el) => el.scrollHeight > el.clientHeight);
    expect(scrolls).toBe(true);
    await page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Import', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Import', exact: true })).toBeInViewport();
  } finally {
    await context.close();
  }
});

test('a member sees Account and Teams only', async ({ browser, playwright, isMobile }) => {
  test.skip(isMobile, 'the side navigation is hidden on a phone');
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/profile');
  try {
    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.locator('.tgrp').first()).toBeVisible();
    const headings = await nav.locator('.tgrp').allTextContents();
    expect(headings.slice(0, 2)).toEqual(['Account', 'Teams']);
    await expect(nav.getByRole('link', { name: 'Members', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'Audit', exact: true })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('a member sees the same two groups in the phone select', async ({ browser, playwright }) => {
  const { page, context } = await openOn(browser, playwright, stack, 'nadia', '/account/profile', { viewport: PHONE, mobile: true });
  try {
    await expect(page.locator('#settings-section optgroup').first()).toBeAttached();
    const groups = await page.locator('#settings-section optgroup').evaluateAll((os) => os.map((o) => (o as HTMLOptGroupElement).label));
    expect(groups.slice(0, 2)).toEqual(['Account', 'Teams']);
    expect(groups).not.toContain('People');
    const values = await page.locator('#settings-section option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(values).not.toContain('/settings/workspace/members');
  } finally {
    await context.close();
  }
});
