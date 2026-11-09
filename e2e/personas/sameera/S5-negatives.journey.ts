// S5 · What Sameera must never be able to do (PLAN §4): read Engineering's channels, memory or inbox, run Coder, read other people's conversations.
// Each step shows the screen that refuses; the ones a hand-made request could try send it from her own page and show the server's refusal.
import { expect } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { askFromPage } from '../nadia/support/denied.ts';
import { BOT_STACK_ENV, allowKnownNoise, arrangeBrain } from '../nadia/support/brain.ts';

const NADIA_QUESTION = 'What did we decide about the cache TTL?';
const THREADS = '/t/customer-support/threads';
/** Set by the step in which Nadia asks Brain: the channel of her private conversation, and a direct message of two other people. */
let nadiasChat: string | undefined;
let othersDm: string | undefined;

async function refused(page: import('@playwright/test').Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /You do not have access|Page not found/ }).or(page.getByTestId(TID.noAccess)).first()).toBeVisible();
}

export default defineJourney({
  id: 'S5',
  persona: 'sameera',
  goal: 'Check that Engineering is closed to me: its channels, its memory, its inbox and its bots, and that nobody else\'s conversation opens for me.',
  markers: [],
  start: 'week-2',
  stackEnv: BOT_STACK_ENV,
  steps: [
    {
      id: 'own-team-only',
      expect: TID.frame,
      run: async ({ pages, page }) => {
        allowKnownNoise(page);
        await pages.inTeam('customer-support').shell.open(THREADS);
        await expect(pages.inTeam('customer-support').shell.channelLink('support')).toBeVisible();
        await expect(pages.inTeam('customer-support').shell.channelLink('dev')).toHaveCount(0);
        await expect(pages.inTeam('customer-support').shell.channelLink('releases')).toHaveCount(0);
      },
    },
    {
      id: 'engineering-channel-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/c/dev');
        await refused(page);
      },
    },
    {
      id: 'engineering-memory-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/memory');
        await refused(page);
      },
    },
    {
      id: 'engineering-inbox-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/memory?tab=inbox');
        await refused(page);
      },
    },
    {
      id: 'coder-refused',
      expect: TID.frame,
      run: async ({ page }) => {
        await page.goto('/t/engineering/bots/coder/chat');
        await refused(page);
      },
    },
    {
      id: 'engineering-api-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        await page.goto('/t/customer-support/threads');
        const dev = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
        expect(dev[0]?.id, 'the #dev channel exists').toBeTruthy();
        expect(await askFromPage(page, 'GET', `/api/channels/${dev[0]!.id}/messages`), 'messages of #dev').toBe(403);
      },
    },
    {
      id: 'engineering-memory-api-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        await page.goto(THREADS);
        // the screens above refuse without asking the server; these are the requests a hand-made call would send (every one answers 403 for a person outside the team)
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/memory/concepts'), "Engineering's memory").toBe(403);
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/inbox/items'), "Engineering's inbox").toBe(403);
        const item = await stack.sql<{ id: string }>(`SELECT i.id FROM app.memory_inbox_items i JOIN app.teams t ON t.id = i.team_id WHERE t.slug = 'engineering' LIMIT 1`);
        expect(item[0]?.id, 'Engineering has an inbox item').toBeTruthy();
        expect(await askFromPage(page, 'GET', `/api/teams/engineering/inbox/items/${item[0]!.id}`), 'one inbox item').toBe(403);
      },
    },
    {
      id: 'coder-api-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto(THREADS);
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/bots/coder'), 'the Coder bot').toBe(403);
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/bots/coder/conversations'), "Coder's conversations").toBe(403);
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/bots/coder/conversations/models'), "Coder's models").toBe(403);
      },
    },
    {
      id: 'others-conversations-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack, also }) => {
        // Nadia asks Brain in her own window: the conversation is hers alone. A direct message of two others is already there.
        await arrangeBrain(stack, [NADIA_QUESTION]);
        const nadia = await also('nadia');
        await nadia.pages.brain.open('brain');
        await nadia.pages.brain.ask(NADIA_QUESTION, { timeoutMs: 90_000 });
        nadiasChat = (
          await stack.sql<{ id: string }>(
            `SELECT m.channel_id AS id FROM app.messages m JOIN app.channels c ON c.id = m.channel_id JOIN app.actors a ON a.id = m.author_id JOIN app.people p ON p.id = a.ref_id WHERE c.kind = 'bot_conversation' AND p.display_name = 'Nadia' ORDER BY m.created_at DESC LIMIT 1`,
          )
        )[0]?.id;
        expect(nadiasChat, "Nadia's conversation with Brain has a channel").toBeTruthy();
        othersDm = (
          await stack.sql<{ id: string }>(
            `SELECT c.id FROM app.channels c WHERE c.kind = 'dm' AND NOT EXISTS (SELECT 1 FROM app.channel_members cm JOIN app.people p ON p.id = cm.person_id WHERE cm.channel_id = c.id AND p.display_name = 'Sameera') ORDER BY c.created_at LIMIT 1`,
          )
        )[0]?.id;
        expect(othersDm, 'a direct message that is not hers exists').toBeTruthy();
        await page.goto(THREADS);
        expect(await askFromPage(page, 'GET', `/api/channels/${nadiasChat!}/messages`), "Nadia's chat with Brain").toBe(403);
        expect(await askFromPage(page, 'GET', `/api/channels/${othersDm!}/messages`), "somebody else's direct message").toBe(403);
      },
    },
    {
      id: 'back-to-support',
      expect: TID.frame,
      run: async ({ pages, page }) => {
        await pages.inTeam('customer-support').channel.open('support');
        await expect(page.getByTestId(TID.channelView)).toBeVisible();
      },
    },
  ],
  outcome: async ({ api, stack }) => {
    const sameera = await api('sameera');
    const dev = await stack.sql<{ id: string }>(`SELECT c.id FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE t.slug = 'engineering' AND c.name = 'dev'`);
    expect(await sameera.status('GET', `/api/channels/${dev[0]!.id}/messages`), '#dev messages').toBeGreaterThanOrEqual(400);
    const listed = await sameera.get<{ groups: Array<{ channels: unknown[] }> }>('/api/teams/engineering/channels');
    expect(listed.groups.flatMap((g) => g.channels), 'Engineering lists no channel to her').toHaveLength(0);
    expect(await sameera.status('GET', '/api/teams/customer-support/channels'), 'her own team still opens').toBeLessThan(400);
    // the same refusals as the steps, from her own session, with the status pinned: a 404 or a 200 here would be a different rule
    for (const path of ['/api/teams/engineering/memory/concepts', '/api/teams/engineering/inbox/items', '/api/teams/engineering/bots/coder', '/api/teams/engineering/bots/coder/conversations', '/api/teams/engineering/bots/coder/conversations/models', `/api/channels/${nadiasChat!}/messages`, `/api/channels/${othersDm!}/messages`]) {
      expect(await sameera.status('GET', path), path).toBe(403);
    }
    // and nothing of hers got into those places
    const written = await stack.sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.messages m JOIN app.actors a ON a.id = m.author_id JOIN app.people p ON p.id = a.ref_id WHERE p.display_name = 'Sameera' AND m.channel_id = ANY($1::uuid[])`,
      [[dev[0]!.id, nadiasChat!, othersDm!]],
    );
    expect(Number(written[0]!.n), 'she wrote nothing in #dev, in Nadia\'s chat or in the direct message').toBe(0);
  },
});
