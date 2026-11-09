// L4 · What Lena must never be able to do around voice rooms and groups (PLAN phases 14 to 18 additions): start a room, mention `@on-call`, open `meetings/` or a finished call
// of the team. A guest-link meeting that shows her the call only waits for the guest links (P17-04). Runs on both viewports.
import { expect, type Page } from '@playwright/test';
import { defineJourney } from '../harness/journey.ts';
import { TID } from '../../pages/index.ts';
import { LENA_ENV, allowKnownNoise } from './support/index.ts';
import { askFromPage } from './support/denied.ts';

async function refused(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: /You do not have access|Page not found/ }).or(page.getByTestId(TID.noAccess)).first()).toBeVisible();
}

let meetingId = '';
let releasesId = '';

export default defineJourney({
  id: 'L4',
  persona: 'lena',
  goal: 'Check that as a guest I cannot start a voice room, call a group of people with a mention, or open the team\'s call transcripts.',
  markers: [],
  start: 'week-2',
  stackEnv: LENA_ENV,
  steps: [
    {
      id: 'channel-header',
      expect: TID.channelView,
      next: { testid: 'call-start', label: 'Start voice room', unchecked: true },
      run: async ({ pages, page, stack, api }) => {
        allowKnownNoise(page);
        await pages.channel.open('releases');
        const dir = await (await api('lena')).get<{ groups: Array<{ channels: Array<{ id: string; name: string }> }> }>('/api/teams/engineering/channels');
        releasesId = dir.groups.flatMap((g) => g.channels).find((c) => c.name.replace(/^#/, '') === 'releases')!.id;
        const rows = await stack.sql<{ id: string }>(`SELECT m.id FROM app.meetings m JOIN app.teams t ON t.id = m.team_id WHERE t.slug = 'engineering' ORDER BY m.started_at LIMIT 1`);
        meetingId = rows[0]!.id;
      },
    },
    {
      id: 'start-room-refused',
      expect: TID.channelView,
      expectDenied: 403,
      run: async ({ page }) => {
        const start = page.getByTestId('call-start');
        if ((await start.count()) > 0) {
          await start.click();
          await expect(page.getByTestId('call-dock').or(page.getByTestId('call-failed')).or(page.getByTestId('call-notice')).first()).toBeHidden({ timeout: 2_000 }).catch(() => undefined);
        } else {
          expect(await askFromPage(page, 'POST', `/api/channels/${releasesId}/meetings`, {})).toBe(403);
        }
      },
    },
    {
      id: 'mention-group-refused',
      expect: TID.channelView,
      expectDenied: 403,
      run: async ({ page, pages }) => {
        expect(await pages.channel.hasComposer(), 'no message box to type a mention in').toBe(false);
        expect(await askFromPage(page, 'POST', `/api/channels/${releasesId}/messages`, { channelId: releasesId, body: '@on-call please look at this', threadRootId: null })).toBe(403);
      },
    },
    {
      id: 'meetings-folder-refused',
      expect: TID.frame,
      expectDenied: 403,
      run: async ({ page }) => {
        await page.goto('/t/engineering/files?path=meetings');
        await refused(page);
      },
    },
    {
      id: 'finished-call-refused',
      expect: TID.frame,
      expectDenied: 404,
      run: async ({ page, stack }) => {
        const title = (await stack.sql<{ title: string }>(`SELECT title FROM app.meetings WHERE id = $1`, [meetingId]))[0]!.title;
        await page.goto(`/meetings/${meetingId}`);
        await expect(page.getByTestId('meeting-transcript')).toHaveCount(0);
        await expect(page.locator('body')).not.toContainText(title);
        expect(await askFromPage(page, 'GET', `/api/meetings/${meetingId}`), 'the call itself').toBe(404);
      },
    },
    {
      id: 'transcript-refused',
      expect: TID.frame,
      expectDenied: 404,
      run: async ({ page }) => {
        expect(await askFromPage(page, 'GET', `/api/meetings/${meetingId}/transcript`)).toBe(404);
      },
    },
    {
      id: 'guest-link-call',
      expect: TID.frame,
      pending: 'P17-04',
    },
  ],
  outcome: async ({ api }) => {
    const lena = await api('lena');
    expect(await lena.status('GET', `/api/meetings/${meetingId}/transcript`), 'a call transcript').toBe(404);
    expect(await lena.status('POST', `/api/channels/${releasesId}/meetings`, {}), 'starting a room').toBe(403);
    expect(await lena.status('POST', `/api/channels/${releasesId}/messages`, { channelId: releasesId, body: '@on-call hello', threadRootId: null }), 'a mention').toBe(403);
  },
});
