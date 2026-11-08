import { expect, test, type Page } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { openChannelDetails } from '../../support/channel-details.ts';
import { SEED_CONNECTORS, connectorsStack, doorUrl, rows, seededOf, sendWebhook, telegramSend } from '../../connections/support.ts';
import { plate } from '../support/polish.ts';

/*
 * The screens of Bundle D (PLAN P16-12) in the Phase 21 look: twelve plates, each in light and dark at 1440 and 390 (48 pictures; class W, own baselines under
 * __baselines__/visual/connections/connections.visual.spec.ts/, made by the runner on first run; this spec was written without running it, and the pictures have not been looked at).
 *
 *   connections/gallery            the Add connection gallery with the document apps and the chat apps on their shelves
 *   connections/health             Settings, Connected apps: the Connectors tab with the seeded counts
 *   connections/people-scopes      the People tab: each sign-in with the permissions given and its state
 *   connections/offboard-dialog    Members, Lena, "Remove their connections": what will be removed
 *   meetings/scheduled-header      #design with the chip of the planned room
 *   meetings/schedule-dialog       the Schedule a room dialog with a title typed
 *   webhooks/provider-hooks-tab    #support, Integrations, the Work apps tab with the Zendesk address
 *   channels/run-origin-card       the Ticket watcher's post with "What started this run" opened
 *   knowledge/connector-source     the Handbook base with its Drive source (one document read, one left out)
 *   bridges/account-chat-apps      Account, Chat apps, for Nadia (linked to Telegram)
 *   bridges/admin-chat-apps        Settings, Chat apps: the four services, Telegram on
 *   channels/message-via           #support with Nadia's group message and "via Telegram"
 *
 * One stack with seed v16. The seed spaces its history from the clock, so every time, date and count that follows the clock carries `data-vt-mask` (on the small element only, never a whole
 * card), and so does everything made of an id (an address, a callback path).
 */
test.skip(({ isMobile }) => isMobile, 'desktop project: the spec sets its own viewports');
test.use({ actionTimeout: 10_000 });
test.setTimeout(240_000);
test.describe.configure({ mode: 'serial' });

let stack: Stack;

test.beforeAll(async () => {
  test.setTimeout(300_000); // the web client is built and the stack seeds the bundle first
  stack = await connectorsStack({ MANYTHREADS_STACK_MEETINGS: '1' });
  const seeded = seededOf(stack);
  // a ticket the Ticket watcher answers, and a message from the Telegram group: the two channel plates need them
  await sendWebhook(stack, { provider: 'zendesk', url: doorUrl(stack, seeded.zendeskEndpointId), secret: SEED_CONNECTORS.zendesk.secret, kind: 'ticket.created', title: 'Refund not received', deliveryId: 'plate-ticket-1' });
  await telegramSend(stack, { fromUserId: SEED_CONNECTORS.telegram.nadiaUserId, chatId: SEED_CONNECTORS.telegram.groupChatId, chatType: 'supergroup', chatTitle: SEED_CONNECTORS.telegram.groupTitle, text: 'Is the refund flow on the status page yet?' });
  await expect
    .poll(
      async () => {
        const post = await rows(stack, `SELECT 1 FROM app.messages WHERE channel_id = $1 AND meta ->> 'runId' IS NOT NULL AND body LIKE '%Refund not received%'`, [seeded.supportChannelId]);
        const via = await rows(stack, `SELECT 1 FROM app.messages WHERE channel_id = $1 AND body LIKE '%refund flow on the status page%'`, [seeded.supportChannelId]);
        return post.length + via.length;
      },
      { timeout: 150_000, intervals: [1_000, 3_000], message: 'the bot post and the Telegram message to land in #support' },
    )
    .toBe(2);
});
test.afterAll(async () => {
  await stack?.stop();
});

/** Marks the small elements that follow the clock or are made of an id. */
async function mask(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    for (const el of Array.from(document.querySelectorAll(sel))) el.setAttribute('data-vt-mask', '');
  }, selector);
}

const VOLATILE = 'time, .ac-d, .sch-chip-text, .wh-origin-fine, [data-testid="provider-state"], [data-testid="provider-address"], [data-testid="chat-app-callback"], [data-testid="connector-source-state"], [data-testid$="-health"]';

test('connections/gallery', async ({ browser }) => {
  await plate(browser, stack, 'connections/gallery', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/settings/team/engineering/connections');
      await page.getByTestId('connection-add').click();
      await expect(page.getByTestId('connector-gallery')).toBeVisible();
      await expect(page.getByTestId('connector-card-telegram')).toBeVisible();
    },
  });
});

test('connections/health', async ({ browser }) => {
  await plate(browser, stack, 'connections/health', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/settings/workspace/connections');
      await expect(page.getByTestId('connectors-admin')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('connections/people-scopes', async ({ browser }) => {
  await plate(browser, stack, 'connections/people-scopes', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/settings/workspace/connections?tab=people');
      await expect(page.getByTestId('person-connection')).toHaveCount(4);
      await mask(page, VOLATILE);
    },
  });
});

test('connections/offboard-dialog', async ({ browser }) => {
  await plate(browser, stack, 'connections/offboard-dialog', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/settings/workspace/members');
      await page.getByTestId('member-row').filter({ hasText: 'Lena' }).getByTestId('member-menu').click();
      await page.getByTestId('member-remove-connections').click();
      await expect(page.getByTestId('offboard-own')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('meetings/scheduled-header', async ({ browser }) => {
  await plate(browser, stack, 'meetings/scheduled-header', {
    who: 'nadia',
    go: async (page) => {
      await page.goto('/t/engineering/c/design');
      await expect(page.getByTestId('scheduled-chip')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('meetings/schedule-dialog', async ({ browser }) => {
  await plate(browser, stack, 'meetings/schedule-dialog', {
    who: 'nadia',
    go: async (page) => {
      await page.goto('/t/engineering/c/design');
      await page.getByTestId('schedule-open').click();
      await expect(page.getByTestId('schedule-dialog')).toBeVisible();
      await page.getByTestId('schedule-title').fill('Icon review');
      await mask(page, `${VOLATILE}, [data-testid="schedule-date"], [data-testid="schedule-time"]`);
    },
  });
});

test('webhooks/provider-hooks-tab', async ({ browser }) => {
  await plate(browser, stack, 'webhooks/provider-hooks-tab', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/t/customer-support/c/support');
      await openChannelDetails(page);
      await page.getByTestId('webhooks-open').click();
      await page.getByTestId('integrations-tab-apps').click();
      await expect(page.getByTestId('provider-row')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('channels/run-origin-card', async ({ browser }) => {
  await plate(browser, stack, 'channels/run-origin-card', {
    who: 'sameera',
    go: async (page) => {
      await page.goto('/t/customer-support/c/support');
      const card = page.getByTestId('run-origin').first();
      await card.scrollIntoViewIfNeeded();
      await page.getByTestId('run-origin-toggle').first().click();
      await expect(page.getByTestId('run-origin-body').first()).toBeVisible();
      // the seed spaces the channel's history from the clock: the list behind the card is not what the plate is about
      await mask(page, `${VOLATILE}, .vlist[aria-label^="Messages in #"] > :not(:has([data-testid="run-origin"]))`);
    },
  });
});

test('knowledge/connector-source', async ({ browser }) => {
  await plate(browser, stack, 'knowledge/connector-source', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/t/engineering/knowledge?base=handbook');
      await expect(page.getByTestId('connector-source')).toBeVisible();
      await expect(page.getByTestId('connector-source-skipped')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('bridges/account-chat-apps', async ({ browser }) => {
  await plate(browser, stack, 'bridges/account-chat-apps', {
    who: 'nadia',
    go: async (page) => {
      await page.goto('/account/chat-apps');
      await expect(page.getByTestId('chat-apps-account')).toBeVisible();
      await expect(page.getByTestId('chat-link-telegram')).toHaveAttribute('data-linked', 'true');
      await mask(page, VOLATILE);
    },
  });
});

test('bridges/admin-chat-apps', async ({ browser }) => {
  await plate(browser, stack, 'bridges/admin-chat-apps', {
    who: 'omar',
    go: async (page) => {
      await page.goto('/settings/workspace/chat-apps');
      await expect(page.getByTestId('chat-apps-admin')).toBeVisible();
      await expect(page.getByTestId('chat-app-telegram-status')).toBeVisible();
      await mask(page, VOLATILE);
    },
  });
});

test('channels/message-via', async ({ browser }) => {
  await plate(browser, stack, 'channels/message-via', {
    who: 'sameera',
    go: async (page) => {
      await page.goto('/t/customer-support/c/support');
      const via = page.getByTestId('message-via').first();
      await via.scrollIntoViewIfNeeded();
      await expect(via).toHaveText('via Telegram');
      await mask(page, `${VOLATILE}, .vlist[aria-label^="Messages in #"] > :not(:has([data-testid="message-via"]))`);
    },
  });
});
