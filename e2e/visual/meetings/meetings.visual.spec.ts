import { expect, test, type Page } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { apiOn, type StackApi } from '../../support/stack-browser.ts';
import { meetingsStack, notesCardMessage } from '../../meetings/support.ts';
import { plate } from '../support/polish.ts';

/*
 * The meetings screens in the Phase 21 look (PLAN P15-17, visual part): nine plates, each in light and dark at 1440 and 390 (class W, own baselines under
 * __baselines__/visual/meetings/meetings.visual.spec.ts/, made by the runner on first run; this spec was written without running it).
 *
 *   call-bar              the call bar of a live room, two people in it (the call clock is masked)
 *   captions              the caption strip with two lines just said
 *   consent               "Transcribe my voice?" for a person who joins while transcription is on
 *   notetaker-consent     the same prompt in a room that has the Note-taker (the words say the server writes the lines)
 *   folder                Files: the folder a private call's transcript and notes were written to
 *   transcript            the transcript tab of the stand-up (Priya's stretch reads "spoke (not transcribed)")
 *   notes-card            the notes tab of the stand-up: summary, decisions, actions with one already on the board
 *   notes-dm              the Note-taker's direct message to the organizer with its Share and Save buttons
 *   share-dialog          "Share these notes" over that message
 *
 * One stack with the `meetings` seed (v15: three finished calls). The live plates make a room through the real routes and end it again, one test after
 * another, so one person is never in two rooms. The seeded calls have today's date and the clock is the real one: every date and time carries
 * `data-vt-mask` (the call clock and the caption times already do; `maskDates` adds the rest). Nobody is shown speaking, so there is no ring to mask.
 */
test.skip(({ isMobile }) => isMobile, 'desktop project: the spec sets its own viewports');
test.use({ actionTimeout: 10_000 });
test.setTimeout(240_000);
test.describe.configure({ mode: 'serial' });

let stack: Stack;
let omar: StackApi;
let nadia: StackApi;
let rafi: StackApi;
let seq = 0;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000); // the web client is built and the stack seeds three calls first
  stack = await meetingsStack('meetings');
  omar = await apiOn(playwright, stack, 'omar');
  nadia = await apiOn(playwright, stack, 'nadia');
  rafi = await apiOn(playwright, stack, 'rafi');
  // the `meetings` seed already set up the Scribe, the Archivist and the Note-taker
});
test.afterAll(async () => {
  await Promise.all([omar, nadia, rafi].map((a) => a?.ctx.dispose()));
  await stack?.stop();
});

const channelId = async (name: string): Promise<string> => (await stack.sql<{ id: string }>(`SELECT id FROM app.channels WHERE name = $1 AND kind <> 'dm' LIMIT 1`, [name]))[0]!.id;
const meetingByTitle = async (title: string): Promise<string> => (await stack.sql<{ id: string }>(`SELECT id FROM app.meetings WHERE title = $1 ORDER BY started_at DESC LIMIT 1`, [title]))[0]!.id;

/**
 * The dates and times of a page carry the mask: the seeded calls were made today, so their stamps differ on every run. So does the channel behind a call
 * bar: the seed spaces its history from the clock, so where the day lines fall depends on the time of day; the plates are about the call, not that list.
 */
async function maskDates(page: Page): Promise<void> {
  await atLatest(page);
  await page.evaluate(() => {
    // a bot's picture is drawn at random for each stack, so the Note-taker's face in the bar is masked too
    const sel = 'time, .jump, .vlist[aria-label^="Messages in #"], .call-clock, .cap-time, [data-testid="meeting-facts"], [data-testid="notes-facts"], [data-testid="line-time"], [data-testid="note-at"], [data-testid="share-row"] .mv-share-when, [data-testid="call-notetaker-face"] .av, .fhead .when, .frow .when, .file-when';
    for (const el of Array.from(document.querySelectorAll(sel))) el.setAttribute('data-vt-mask', '');
    // what carries the run's own clock without a tag of its own: a time of day ("13:11"), a call's folder ("08-1311-leads-sync"), a running clock ("0:06")
    const stamp = /(^|\s)\d{1,2}:\d{2}(\s|$)|^\d{2}-\d{4}-/;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (el.children.length > 0 || el.closest('[data-vt-mask]')) continue;
      if (stamp.test((el.textContent ?? '').trim())) el.setAttribute('data-vt-mask', '');
    }
  });
}

/**
 * The channel page behind a call bar is at its newest message: the dock opens after the page has drawn and shrinks the list, and for a moment the list is
 * a little above the bottom ("Jump to latest" shows). Waits until it has stayed at the bottom for two looks in a row.
 */
async function atLatest(page: Page): Promise<void> {
  const jump = page.locator('button.jump:not(.jump-top)');
  let calm = 0;
  for (let i = 0; i < 40 && calm < 2; i += 1) {
    if ((await jump.count()) > 0) {
      calm = 0;
      await jump.first().click();
    } else calm += 1;
    await page.waitForTimeout(300);
  }
  await expect(jump).toHaveCount(0);
}

/** Presses Start voice room / Join voice room on a channel page and waits until the call bar is connected. */
async function intoRoom(page: Page, channel: string): Promise<void> {
  await page.goto(`/t/engineering/c/${channel}`);
  // the header's Schedule button arrives with the plan list, a moment after the rest of the header: the plate waits for it
  await expect(page.getByTestId('schedule-open')).toBeVisible();
  await page.getByTestId('call-start').click();
  await expect(page.getByTestId('call-dock')).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
  await atLatest(page);
}

/**
 * A room in `channel` made through the routes (as the seed does), run by `fn`, and always ended afterwards. Its "Started a voice room" message is taken
 * out again, so the next plate finds the channel as the seed left it whatever ran before it (a failed test also restarts the worker and the stack).
 */
async function withRoom(channel: string, organizer: StackApi, fn: (meetingId: string) => Promise<void>): Promise<void> {
  const started = await organizer.post<{ meeting: { id: string } }>(`/api/channels/${await channelId(channel)}/meetings`, { title: 'Plate room' });
  const id = started.meeting.id;
  try {
    await fn(id);
  } finally {
    await organizer.post(`/api/meetings/${id}/end`).catch(() => undefined);
    await stack.sql(`DELETE FROM app.messages WHERE id = (SELECT thread_root_id FROM app.meetings WHERE id = $1::uuid)`, [id]);
  }
}

test('call-bar: a live room with two people in it', async ({ browser }) => {
  await withRoom('releases', nadia, async (id) => {
    await rafi.post(`/api/meetings/${id}/join`);
    await plate(browser, stack, 'call-bar', {
      who: 'nadia',
      order: ['header', 'content'],
      go: async (page) => {
        await intoRoom(page, 'releases');
        await expect(page.getByTestId('call-face')).toHaveCount(2);
        await maskDates(page);
      },
    });
  });
});

test('captions: two lines just said', async ({ browser }) => {
  await withRoom('releases', nadia, async (id) => {
    await rafi.post(`/api/meetings/${id}/join`);
    await nadia.ctx.put(`/api/meetings/${id}/transcription`, { data: { mode: 'on_device' }, headers: await nadia.headers() });
    for (const api of [nadia, rafi]) await api.post(`/api/meetings/${id}/consent`, { transcribe: 'yes' });
    await plate(browser, stack, 'captions', {
      who: 'nadia',
      order: ['header', 'content'],
      go: async (page) => {
        await intoRoom(page, 'releases');
        const captions = page.getByTestId('call-captions');
        if ((await captions.getAttribute('aria-pressed')) !== 'true') await captions.click();
        await expect(page.getByTestId('call-captions-strip')).toBeVisible();
        await maskDates(page);
        // said last: a caption leaves the strip after eight seconds
        const at = Date.now() % 1_000_000;
        for (const [api, text] of [[rafi, 'The staging run was green overnight.'], [nadia, 'Good, then we ship on Thursday.']] as const) {
          seq += 1;
          await api.post(`/api/meetings/${id}/segments`, { segments: [{ clientSegId: `plate-${String(seq)}`, startMs: at, endMs: at + 2500, text, final: true }] });
        }
        await expect(page.getByTestId('caption-line')).toHaveCount(2);
        await atLatest(page);
      },
    });
  });
});

test('consent: the prompt a person gets when they join a room that is being transcribed', async ({ browser }) => {
  await withRoom('releases', nadia, async (id) => {
    await nadia.ctx.put(`/api/meetings/${id}/transcription`, { data: { mode: 'on_device' }, headers: await nadia.headers() });
    await nadia.post(`/api/meetings/${id}/consent`, { transcribe: 'yes' });
    await plate(browser, stack, 'consent', {
      who: 'rafi',
      order: ['header', 'content'],
      go: async (page) => {
        await intoRoom(page, 'releases');
        await expect(page.getByTestId('call-consent')).toBeVisible();
        await expect(page.getByTestId('call-consent')).toContainText('Nadia turned on transcription');
        await maskDates(page);
      },
    });
  });
});

test('notetaker-consent: the same prompt when the Note-taker is in the room', async ({ browser }) => {
  const botId = (await stack.sql<{ id: string }>(`SELECT id FROM app.bots WHERE slug = 'note-taker' LIMIT 1`))[0]!.id;
  await withRoom('releases', nadia, async (id) => {
    await nadia.ctx.put(`/api/meetings/${id}/notetaker`, { data: { botId }, headers: await nadia.headers() });
    await expect
      .poll(async () => (await nadia.get<{ current: { listening?: boolean } | null }>(`/api/meetings/${id}/notetakers`)).current?.listening === true, { timeout: 30_000 })
      .toBe(true);
    await nadia.post(`/api/meetings/${id}/consent`, { transcribe: 'yes' });
    await plate(browser, stack, 'notetaker-consent', {
      who: 'rafi',
      order: ['header', 'content'],
      go: async (page, size) => {
        await intoRoom(page, 'releases');
        await expect(page.getByTestId('call-consent')).toBeVisible();
        // on a phone the bar is a collapsed sheet, which keeps the row of faces folded away until it is opened
        if (size === '1440') await expect(page.getByTestId('call-notetaker-face')).toBeVisible();
        else await expect(page.getByTestId('call-notetaker-face')).toHaveCount(1);
        await maskDates(page);
      },
    });
  });
});

test('folder: where a private call wrote its transcript and notes', async ({ browser }) => {
  const id = await meetingByTitle('Leads sync');
  const notes = (await stack.sql<{ notes_path: string }>(`SELECT notes_path FROM app.meeting_notes WHERE meeting_id = $1`, [id]))[0]!.notes_path;
  const folder = notes.slice(0, notes.lastIndexOf('/'));
  await plate(browser, stack, 'folder', {
    who: 'omar',
    order: ['sidebar', 'header', 'content'],
    go: async (page) => {
      await page.goto(`/t/engineering/files?path=${encodeURIComponent(folder)}`);
      await expect(page.getByTestId('files-screen')).toBeVisible();
      await expect(page.getByText('transcript', { exact: false }).first()).toBeVisible();
      await maskDates(page);
    },
  });
});

test('transcript: the stand-up as a person reads it', async ({ browser }) => {
  const id = await meetingByTitle('Engineering stand-up');
  await plate(browser, stack, 'transcript', {
    who: 'nadia',
    order: ['content'],
    go: async (page) => {
      await page.goto(`/meetings/${id}`);
      await page.getByTestId('meeting-tab-transcript').click();
      await expect(page.getByTestId('transcript-line').first()).toBeVisible();
      await expect(page.getByTestId('transcript-line').filter({ hasText: 'Priya spoke (not transcribed)' }).first()).toBeVisible();
      await maskDates(page);
    },
  });
});

test('notes-card: the stand-up notes with an action already on the board', async ({ browser }) => {
  const id = await meetingByTitle('Engineering stand-up');
  await plate(browser, stack, 'notes-card', {
    who: 'nadia',
    order: ['content'],
    go: async (page) => {
      await page.goto(`/meetings/${id}`);
      await expect(page.getByTestId('notes-card')).toBeVisible();
      await expect(page.getByTestId('action-item').first()).toBeVisible();
      await maskDates(page);
    },
  });
});

test('notes-dm: the Note-taker tells the organizer the notes are ready', async ({ browser }) => {
  const id = await meetingByTitle('Design review');
  const card = await notesCardMessage(stack, id);
  await plate(browser, stack, 'notes-dm', {
    who: 'nadia',
    order: ['header', 'content'],
    go: async (page) => {
      await page.goto(`/t/engineering/chat/${card.channelId}?thread=${card.messageId}`);
      await expect(page.getByTestId('meeting-notes-card').first()).toBeVisible();
      await expect(page.getByTestId('meeting-card-share')).toBeVisible();
      await maskDates(page);
    },
  });
});

test('share-dialog: Share these notes, with nobody yet', async ({ browser }) => {
  const id = await meetingByTitle('Design review');
  const card = await notesCardMessage(stack, id);
  await plate(browser, stack, 'share-dialog', {
    who: 'nadia',
    order: ['content'],
    go: async (page) => {
      await page.goto(`/t/engineering/chat/${card.channelId}?thread=${card.messageId}`);
      await page.getByTestId('meeting-card-share').click();
      const dialog = page.getByTestId('share-dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('share-none')).toBeVisible();
      await maskDates(page);
    },
  });
});
