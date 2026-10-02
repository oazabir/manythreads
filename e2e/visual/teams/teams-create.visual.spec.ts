import { test } from '@playwright/test';
import { startStack, type Stack } from '../../fixtures/stack.ts';
import { comparePlate, openPage, type PlateSpec } from '../support/vt.ts';

/*
 * Teams > create from templates vs [proto §01 plate 4 · Step 5 · Teams] (section onboarding, plate 4). Class P.
 *
 * The plate is the onboarding step: a stepper rail (phase 10) and the pane "Which teams do you want?". The settings screen has
 * its own navigation instead of the rail, so the pane is what is compared (see support/vt.ts): its content box, 640px tall.
 * The plate's state is reproduced: Engineering, Customer support and Marketing ticked, invitees typed for the first two.
 *
 * Measured gap to the plate (residual, accepted within P): ~5% of pixels differ. Causes that are the product, not drift:
 *  - the plate's chip rows show connections ("GitHub . kahf", "needs: manuals") that exist from phase 8; the live cards show the
 *    template's board and role tags in the same chip style (one line, extra tags folded into "+N");
 *  - each ticked card has a slug field beside the name pill, and a ticked Marketing card has an Invite field the plate omits,
 *    so the Marketing card and the grid are taller than the plate's (landmarks are held for the first two cards and the text);
 *  - Customer support and Marketing list their own bot names (the plate says "Support responder (manuals)"), so only the
 *    templates whose plate text equals the stored definition are held to data-copy;
 *  - the plate's channel chips end in a "+" add affordance that arrives with channels (left out of the compared text).
 */
const PLATE: PlateSpec = {
  section: 'onboarding',
  n: 4,
  paneSelector: '.obr',
  padding: [32, 40, 32, 40],
  railWidth: 260,
  regions: {
    title: '.obr h3',
    lede: '.obr .lede',
    picker: '.obr .grid2',
    'card-engineering': '.obr .tpl:nth-child(1)',
    'card-customer-support': '.obr .tpl:nth-child(2)',
    'card-marketing': '.obr .tpl:nth-child(3)',
    'card-product-design': '.obr .tpl:nth-child(4)',
    'card-research': '.obr .tpl:nth-child(5)',
    'card-blank': '.obr .tpl:nth-child(6)',
    actions: '.obr .actions',
  },
  copy: {
    title: { selector: '.obr h3' },
    lede: { selector: '.obr .lede' },
    create: { selector: '.obr .actions .btn.p' },
    hint: { selector: '.obr .actions .skip' },
    'name-engineering': { selector: '.obr .tpl:nth-child(1) b' },
    'name-customer-support': { selector: '.obr .tpl:nth-child(2) b' },
    'name-marketing': { selector: '.obr .tpl:nth-child(3) b' },
    'name-product-design': { selector: '.obr .tpl:nth-child(4) b' },
    'name-research': { selector: '.obr .tpl:nth-child(5) b' },
    'name-blank': { selector: '.obr .tpl:nth-child(6) b' },
    'channels-engineering': { selector: '.obr .tpl:nth-child(1) .ch', omit: '.add' },
    'bots-engineering': { selector: '.obr .tpl:nth-child(1) .bots' },
    'bots-marketing': { selector: '.obr .tpl:nth-child(3) .bots' },
    'bots-product-design': { selector: '.obr .tpl:nth-child(4) .bots' },
    'bots-research': { selector: '.obr .tpl:nth-child(5) .bots' },
    'bots-blank': { selector: '.obr .tpl:nth-child(6) .bots' },
  },
};

let stack: Stack;
test.beforeAll(async () => {
  stack = await startStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

test('teams create matches the Step 5 · Teams plate (P)', async ({ browser }, testInfo) => {
  const { page, close } = await openPage(browser, stack, 'omar');
  try {
    await page.goto('/teams');
    for (const name of ['Engineering', 'Customer support', 'Marketing']) {
      await page.getByRole('checkbox', { name: `Create a ${name} team` }).click();
    }
    await page.getByLabel('Engineering invite emails').fill('nadia@kahf.io, tariq@kahf.io, sameera@kahf.io');
    await page.getByLabel('Customer support invite emails').fill('rafi@kahf.io');
    await page.getByLabel('Customer support invite emails').blur();
    await comparePlate(page, browser, testInfo, {
      cls: 'P',
      spec: PLATE,
      liveRegion: '[data-landmark="teams"]',
      order: [
        ['title', 'lede', 'picker', 'actions'],
        ['card-engineering', 'card-customer-support', 'card-marketing', 'card-product-design', 'card-research', 'card-blank'],
      ],
      exact: ['title', 'lede', 'card-engineering', 'card-customer-support'],
      copy: ['title', 'lede', 'create', 'hint', 'name-engineering', 'name-customer-support', 'name-marketing', 'name-product-design', 'name-research', 'name-blank', 'channels-engineering', 'bots-engineering', 'bots-marketing', 'bots-product-design', 'bots-research', 'bots-blank'],
    });
  } finally {
    await close();
  }
});
