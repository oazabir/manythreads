import { expect, test, type Page } from '@playwright/test';
import { authState } from '../support/env.ts';

/**
 * The buttons in a block header on the team roster (People: Add person and Invite; Template definition: Open) sit fully inside their card
 * and never overlap, at the desktop, laptop and phone widths. A shared `.act` icon-button rule (26 px wide) once squeezed the group, the
 * card clipped it and "Open" read "Oper". The viewport is set here because the phone project does not run the teams folder.
 */
test.use({ storageState: authState('omar') });

const WIDTHS = [1440, 1024, 390] as const;

/** The seeded Engineering team was made blank (no Template definition card, so no Open button); the live team has one. Give the response one. */
const DEFINITION = {
  id: 'engineering',
  name: 'Engineering',
  description: 'A team that plans, codes, reviews and ships.',
  version: 1,
  channels: [{ name: '#general', purpose: 'Everyone' }],
  board: { name: 'Engineering board', columns: ['Open', 'Done'] },
  bots: [{ slug: 'brain', name: 'Brain', role: 'Team memory.' }],
  roleTags: [],
  teamMd: '# Engineering',
};

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function headerButtons(page: Page, landmark: string): Promise<{ card: Box; buttons: { name: string; box: Box; scrollWidth: number; clientWidth: number }[] }> {
  return page.locator(`[data-landmark="${landmark}"]`).evaluate((card) => {
    const rect = (el: Element): Box => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    const buttons = Array.from(card.querySelectorAll<HTMLElement>('.bh button, .bh a')).map((el) => ({
      name: (el.textContent ?? '').trim(),
      box: rect(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    return { card: rect(card), buttons };
  });
}

const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

for (const width of WIDTHS) {
  test(`the People and Template definition header buttons lie inside their cards at ${width}px`, async ({ page }) => {
    await page.route('**/api/teams/engineering', async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { team: Record<string, unknown> };
      await route.fulfill({ response: res, json: { ...body, team: { ...body.team, templateDefinition: DEFINITION } } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings/team/engineering/roster');
    await expect(page.getByRole('heading', { name: 'Engineering', level: 1 })).toBeVisible();
    await expect(page.locator('[data-landmark="template-definition"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add person' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    for (const [landmark, names] of [
      ['people', ['Add person', 'Invite']],
      ['template-definition', ['Open']],
    ] as const) {
      const { card, buttons } = await headerButtons(page, landmark);
      expect(buttons.map((b) => b.name), landmark).toEqual(names);
      for (const b of buttons) {
        const where = `${landmark} / ${b.name} at ${width}px`;
        expect(b.box.x, `${where}: left edge`).toBeGreaterThanOrEqual(card.x);
        expect(b.box.x + b.box.width, `${where}: right edge`).toBeLessThanOrEqual(card.x + card.width);
        expect(b.box.y, `${where}: top edge`).toBeGreaterThanOrEqual(card.y);
        expect(b.box.y + b.box.height, `${where}: bottom edge`).toBeLessThanOrEqual(card.y + card.height);
        expect(b.scrollWidth, `${where}: its text is not cut`).toBeLessThanOrEqual(b.clientWidth);
      }
      for (let i = 0; i < buttons.length; i++) {
        for (let j = i + 1; j < buttons.length; j++) {
          expect(overlap(buttons[i]!.box, buttons[j]!.box), `${landmark}: ${buttons[i]!.name} and ${buttons[j]!.name} overlap at ${width}px`).toBe(false);
        }
      }
    }

    // and in the phone's stacked rows no button of the People card runs past the card either
    const rowButtons = await page.locator('[data-landmark="people"] button, [data-landmark="people"] a').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().right));
    const cardRight = (await headerButtons(page, 'people')).card;
    for (const right of rowButtons) expect(right, `a People button at ${width}px`).toBeLessThanOrEqual(cardRight.x + cardRight.width);

    // the page itself does not scroll sideways
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways, 'horizontal scroll').toBeLessThanOrEqual(0);
  });
}
