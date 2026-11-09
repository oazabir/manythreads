// L3 · What Lena must never be able to do (PLAN §4): see other channels, members, Files, Boards, Approvals or DMs; talk to or mention any bot, Brain included; post; drop
// into an inbox; search outside #releases. Each step shows the screen that refuses (or has nothing to offer); the ones a hand-made request could try send it from her own
// page and show the server's refusal. The plan asks for this journey at 390 px too, so it runs on both viewports.
import { expect, type Page } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV, allowKnownNoise, engineeringChannelId } from './support/index.ts';
import { askFromPage } from './support/denied.ts';

/** The refusal screen of the app: the channel one, the generic "no access", or "Page not found". */
async function refused(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /You do not have access|Page not found/ }).or(page.getByTestId(TID.noAccess)).first()).toBeVisible();
}

export default defineJourney({
  id: 'L3',
  persona: 'lena',
  goal: 'Check that as a guest I see nothing but #releases: no other channel, no people list, no files, boards, approvals or direct messages, no bot, no way to post, and search stays inside #releases.',
  markers: [],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: [
    {
      id: 'releases-only',
      expect: TID.readOnly,
      run: async ({ pages, page }) => {
        allowKnownNoise(page);
        await pages.channel.open('releases');
        const sidebar = page.locator('[data-landmark="sidebar"]');
        await expect(sidebar.locator('a.it')).toHaveCount(1);
        await expect(sidebar.locator('a.it')).toContainText('releases');
        await expect(page.getByTestId(TID.readOnly)).toHaveText('You can read this channel.');
      },
    },
    {
      id: 'no-composer',
      expect: TID.readOnly,
      run: async ({ pages, page }) => {
        expect(await pages.channel.hasComposer(), 'the message box').toBe(false);
        await expect(page.getByRole('textbox', { name: /Message/ })).toHaveCount(0);
        await pages.channel.messages.first().hover();
        await expect(page.getByRole('button', { name: 'Reply in thread' })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Add reaction' })).toHaveCount(0);
      },
    },
    {
      id: 'dev-channel-refused',
      expect: TID.noAccess,
      expectDenied: 403,
      run: async ({ pages, page, stack }) => {
        // the screen answers from the channel directory she was given, with no request of its own, so the server's refusal is asked for from the same page
        await pages.channel.openExpectingRefusal('/t/engineering/c/dev');
        expect(await askFromPage(page, 'GET', `/api/channels/${await engineeringChannelId(stack, 'dev')}/messages?limit=20`)).toBe(403);
      },
    },
    {
      id: 'private-channel-refused',
      expect: TID.noAccess,
      expectDenied: 403,
      run: async ({ pages, page, stack }) => {
        await pages.channel.openExpectingRefusal('/t/engineering/c/eng-leads');
        expect(await askFromPage(page, 'GET', `/api/channels/${await engineeringChannelId(stack, 'eng-leads')}/messages?limit=20`)).toBe(403);
      },
    },
    {
      id: 'members-refused',
      expect: TID.frame,
      expectDenied: 404,
      run: async ({ page }) => {
        // the workspace settings do not exist for a guest: the client shows "Page not found" with no request, and the member list answers 404
        await page.goto('/settings/workspace/members');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        expect(await askFromPage(page, 'GET', '/api/workspace/members')).toBe(404);
      },
    },
    {
      id: 'files-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/files');
        await refused(page);
      },
    },
    {
      id: 'boards-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/boards');
        await refused(page);
      },
    },
    {
      id: 'approvals-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        // PRODUCT FINDING: a guest is let into the Approvals screen, which then fails to load (it asks for `/api/teams//approvals`, an empty team name, and gets 400)
        await page.goto('/t/engineering/approvals');
        await expect(page.getByText('Could not load approvals.')).toBeVisible();
        await expect(page.getByTestId(TID.approvalCard)).toHaveCount(0);
        expect(await askFromPage(page, 'GET', '/api/teams/engineering/approvals?status=pending&limit=50')).toBe(403);
      },
    },
    {
      id: 'direct-messages-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page, stack }) => {
        // PRODUCT FINDING: the Messages screen opens for a guest (empty, with "New message"); the server is where a conversation with a member is refused
        await page.goto('/t/engineering/dms');
        await expect(page.getByText('No messages yet')).toBeVisible();
        const omar = await stack.sql<{ id: string }>(`SELECT id FROM app.people WHERE primary_email = 'omar@kahf.example'`);
        expect(await askFromPage(page, 'POST', '/api/dms', { personIds: [omar[0]!.id] })).toBe(403);
      },
    },
    {
      id: 'bots-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/bots');
        await refused(page);
      },
    },
    {
      id: 'brain-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/chat?bot=brain');
        await expect(page.getByText('You cannot chat with this bot.')).toBeVisible();
      },
    },
    {
      id: 'memory-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/memory');
        await expect(page.getByText(/You cannot see this team/)).toBeVisible();
      },
    },
    {
      id: 'admin-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/settings/workspace/general');
        await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
        expect(await askFromPage(page, 'GET', '/api/admin/bot-runners')).toBe(403);
      },
    },
    {
      id: 'inbox-drop-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/c/releases');
        expect(await askFromPage(page, 'POST', '/api/teams/engineering/inbox/notes', { title: 'Lena note', text: 'Please file this.', teamOnly: false })).toBe(403);
      },
    },
    {
      id: 'search-stays-inside',
      expect: TID.searchResults,
      next: { testid: TID.searchHit, label: 'A hit in #releases' },
      run: async ({ pages }) => {
        await pages.search.open('deploy');
        await expect(pages.search.hits.first()).toBeVisible();
        const channels = await pages.search.hits.evaluateAll((els) => els.map((e) => e.textContent ?? ''));
        for (const text of channels) expect(text, 'a hit from a channel she was not given').toMatch(/^\W*#releases/);
      },
    },
  ],
  outcome: async ({ api }) => {
    const lena = await api('lena');
    const directory = await lena.get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels');
    const names = directory.groups.flatMap((g) => g.channels).map((c) => c.name.replace(/^#/, ''));
    expect(names, 'the only channel she can list').toEqual(['releases']);
    for (const path of ['/api/teams/engineering/inbox/items', '/api/teams/engineering/approvals', '/api/teams/engineering/bots']) {
      expect(await lena.status('GET', path), path).toBeGreaterThanOrEqual(400);
    }
    const releases = directory.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'releases')!;
    expect(await lena.status('POST', `/api/channels/${releases.id}/messages`, { channelId: releases.id, body: 'hello', threadRootId: null }), 'posting').toBe(403);
    const found = await lena.get<{ messages: Array<{ channel: { name: string } }>; threads: Array<{ channel?: { name?: string } }>; files: unknown[]; pages: unknown[] }>('/api/search?q=deploy&scope=all&limit=20');
    expect(found.messages.length, 'she finds the deploy lines of #releases').toBeGreaterThan(0);
    for (const h of found.messages) expect(h.channel.name.replace(/^#/, ''), 'a search hit outside #releases').toBe('releases');
    for (const h of found.threads) expect(h.channel?.name?.replace(/^#/, ''), 'a thread hit outside #releases').toBe('releases');
    expect(found.files, 'no file in a guest search').toHaveLength(0);
    expect(found.pages, 'no page in a guest search').toHaveLength(0);
  },
});
