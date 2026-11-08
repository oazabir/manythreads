import { expect, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs } from '@playwright/test';
import { MEETING_BOT_FILES, personas as testPersonas } from '@manythreads/test-utils';
import { startStack, type Stack } from '../fixtures/stack.ts';
import type { PersonaKey } from '../support/env.ts';
import { applyGuarded, apiOn, DESKTOP, PHONE, type StackApi } from '../support/stack-browser.ts';

/*
 * Helpers of the meeting specs (PLAN P15-17, e2e/meetings). Every spec file starts a stack of its own with the voice-room stand-ins on (fixtures/stack-server.ts,
 * `MANYTHREADS_STACK_MEETINGS=1`): the fake media provider, the fake server ASR, a Hermes command that answers the meeting prompts. Each person is a browser context
 * with the web build's fake speech engine (`window.__manythreadsSay`) and the fake media adapter, so nothing here needs a microphone, and nothing sleeps: every wait
 * is on something the page or the database shows.
 */

export const personas = testPersonas;
export type Who = PersonaKey;

/** A stack for the meeting specs. `seed` is any stack seed (default `content`: the channels and members of the Engineering team). */
export function meetingsStack(seed = 'content', env: Record<string, string> = {}): Promise<Stack> {
  return startStack({ MANYTHREADS_STACK_SEED: seed, MANYTHREADS_STACK_MEETINGS: '1', ...env });
}

/** The Scribe, the Archivist and the note-taker as stand-in bot definitions, set up as a lead does (a proposal applied at once), then waited for until the loader has them. */
export async function installBots(stack: Stack, omar: StackApi, which: readonly string[] = ['scribe', 'archivist']): Promise<void> {
  for (const bot of MEETING_BOT_FILES.filter((b) => which.includes(b.slug))) {
    const res = await applyGuarded(omar, `bots/${bot.slug}/BOT.md`, bot.md, `Set up ${bot.slug}`);
    expect(res.status, `set up ${bot.slug}: ${res.text}`).toBe(201);
  }
  await expect
    .poll(async () => (await stack.sql<{ n: string }>(`SELECT count(*)::text AS n FROM app.bots WHERE slug = ANY($1::text[]) AND status = 'active'`, [which])).at(0)?.n, { timeout: 60_000, message: 'the loader to load the meeting bots' })
    .toBe(String(which.length));
}

export interface Person {
  key: Who;
  page: Page;
  context: BrowserContext;
  api: StackApi;
  /** Every URL the page requested, oldest first (the request log of PLAN §3 criterion 1). */
  requests: string[];
}

/** A browser context of the persona on the stack, open at `path` (default: the Engineering channel #dev), with the request log on. */
export async function openAs(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  key: Who,
  path = '/t/engineering/c/dev',
  opts: { mobile?: boolean } = {},
): Promise<Person> {
  const api = await apiOn(playwright, stack, key);
  const storageState = await api.ctx.storageState();
  const context = await browser.newContext({
    baseURL: stack.origin,
    viewport: opts.mobile ? PHONE : DESKTOP,
    storageState,
    reducedMotion: 'reduce',
    permissions: ['microphone'],
    ...(opts.mobile ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
  await page.goto(path);
  return { key, page, context, api, requests };
}

export async function closePerson(p: Person | undefined): Promise<void> {
  await p?.context.close().catch(() => undefined);
  await p?.api.ctx.dispose().catch(() => undefined);
}

export const dock = (p: Person) => p.page.getByTestId('call-dock');

/** Presses Start voice room (or Join voice room when one is live) and waits until the call bar is connected. */
export async function enterRoom(p: Person): Promise<void> {
  await p.page.getByTestId('call-start').click();
  await expect(dock(p)).toHaveAttribute('data-phase', 'connected', { timeout: 20_000 });
}

/** Opens Call settings, runs `then`, and puts the menu away again. */
async function inSettings(p: Person, then: () => Promise<void>): Promise<void> {
  await p.page.getByTestId('call-settings-btn').click();
  await expect(p.page.getByTestId('call-settings')).toBeVisible();
  await then();
  await p.page.getByTestId('call-settings-btn').click();
  await expect(p.page.getByTestId('call-settings')).toBeHidden();
}

/** "Turn on transcription" from Call settings (the room's mode: the device writes its own person's words). */
export async function turnOnTranscription(p: Person): Promise<void> {
  await inSettings(p, async () => {
    await p.page.getByTestId('transcription-on').click();
    await expect(p.page.getByTestId('transcription-off')).toBeVisible();
  });
}

/** Answers "Transcribe my voice?" and waits until the prompt is gone. */
export async function answerConsent(p: Person, answer: 'yes' | 'no'): Promise<void> {
  await p.page.getByTestId(answer === 'yes' ? 'consent-yes' : 'consent-no').click();
  await expect(p.page.getByTestId('call-consent')).toBeHidden();
}

/** The person says `text` into the fake engine of their page. Fails when the engine is not listening (they did not say yes, or are not in the room). */
export async function say(p: Person, text: string): Promise<void> {
  await expect.poll(() => p.page.evaluate((t) => (window as unknown as { __manythreadsSay?: (t: string) => boolean }).__manythreadsSay?.(t) ?? false, text), { timeout: 15_000, message: `${p.key} to be heard saying "${text}"` }).toBe(true);
}

/** Makes the fake media adapter of the page report these people as speaking (what the media server's speaker events do for a real room). */
export async function showSpeaking(p: Person, actorIds: string[]): Promise<void> {
  await p.page.evaluate((ids) => (window as unknown as { __manythreadsFakeMedia: { last(): { speak(ids: string[]): void } | undefined } }).__manythreadsFakeMedia.last()?.speak(ids), actorIds);
}

/** "End for everyone" from Call settings; waits until the call bar is gone. */
export async function endForEveryone(p: Person): Promise<void> {
  await p.page.getByTestId('call-settings-btn').click();
  await p.page.getByTestId('call-end-all').click();
  await expect(dock(p)).toBeHidden();
}

export async function leave(p: Person): Promise<void> {
  await p.page.getByTestId('call-leave').click();
  await expect(dock(p)).toBeHidden();
}

// ---- the database and the API, as the specs arrange and check ------------------------------------------------------------------------------------

export type MeetingRow = {
  id: string;
  title: string;
  state: string;
  thread_root_id: string | null;
  channel_id: string;
  transcription: string;
};

/** The room opened last in the channel with this name (live or ended). */
export async function lastMeeting(stack: Stack, channel: string): Promise<MeetingRow> {
  const rows = await stack.sql<MeetingRow>(
    `SELECT m.id, m.title, m.state, m.thread_root_id, m.channel_id, m.transcription FROM app.meetings m JOIN app.channels c ON c.id = m.channel_id WHERE c.name = $1 AND c.kind <> 'dm' ORDER BY m.started_at DESC LIMIT 1`,
    [channel],
  );
  expect(rows[0], `a room in #${channel}`).toBeDefined();
  return rows[0]!;
}

/** The final lines stored for a room: what the transcript will hold (a line of someone who did not say yes is stored blank). */
export function storedLines(stack: Stack, meetingId: string): Promise<Array<{ speaker: string; text: string; source: string }>> {
  return stack.sql(
    `SELECT s.speaker_id AS speaker, s.text, s.source FROM app.meeting_segments s WHERE s.meeting_id = $1 AND s.final ORDER BY s.start_ms, s.id`,
    [meetingId],
  );
}

/** Runs the room's transcript job now instead of two minutes after the end, and waits for the notes to settle. Returns the notes row. */
export async function finishNotes(stack: Stack, meetingId: string): Promise<{ status: string; location: string; notes_path: string | null; transcript_path: string; notes_md: string; memory_item_id: string | null; items: Array<{ kind: string; text: string; ownerName: string | null }> }> {
  await expect
    .poll(async () => {
      await stack.sql(`UPDATE app.jobs SET run_at = now() WHERE queue LIKE 'meetings.%' AND payload->>'meetingId' = $1 AND state = 'ready'`, [meetingId]);
      const rows = await stack.sql<{ status: string }>('SELECT status FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]);
      return rows[0] !== undefined && rows[0].status !== 'pending' ? rows[0].status : '';
    }, { timeout: 90_000, message: 'the notes of the room to settle' })
    .not.toBe('');
  const rows = await stack.sql<never>('SELECT status, location, notes_path, transcript_path, notes_md, memory_item_id, items FROM app.meeting_notes WHERE meeting_id = $1', [meetingId]);
  return rows[0] as never;
}

/** A thread's lines after the root, as plain text with the author's kind. */
export function threadLines(stack: Stack, meetingId: string): Promise<Array<{ body: string; kind: string; meta: Record<string, unknown> | null }>> {
  return stack.sql(
    `SELECT m.body, a.kind, m.meta FROM app.messages m JOIN app.meetings mt ON mt.thread_root_id = m.thread_root_id JOIN app.actors a ON a.id = m.author_id WHERE mt.id = $1 AND m.id <> mt.thread_root_id ORDER BY m.id`,
    [meetingId],
  );
}

/** The repo file as the team's repository serves it (the route a Files screen uses), or null when there is none. */
export async function repoText(api: StackApi, team: string, path: string): Promise<string | null> {
  const res = await api.ctx.get(`/api/teams/${team}/repo/blob?path=${encodeURIComponent(path)}`);
  if (res.status() === 404) return null;
  expect(res.status(), `blob ${path}`).toBe(200);
  return ((await res.json()) as { content: string }).content;
}

/** One request that is expected to be refused: the status. */
export async function statusOf(api: StackApi, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<number> {
  const headers = await api.headers();
  const res = await api.ctx.fetch(path, { method, headers, ...(data === undefined ? {} : { data }) });
  return res.status();
}

/** What the fake media server recorded for a room (tokens, what was published, who each listener hears, who was removed). Test stacks only. */
export async function mediaState(stack: Stack, api: StackApi, meetingId: string): Promise<{ tokens: Array<{ identity: string; kind: 'person' | 'bot'; canPublish: boolean; canSubscribe: boolean; listenOnly: boolean }>; published: string[]; listeners: Array<{ identity: string; subscriptions: string[] }>; kicked: string[] }> {
  const res = await api.ctx.get(`/api/test/media/state?meetingId=${meetingId}`, { headers: { 'x-test-auth': stack.testAuthToken } });
  expect(res.status(), await res.text()).toBe(200);
  return (await res.json()) as never;
}

/** The person "says" these words to the room's note-taker (the fake media server hands the listener a chunk). True when the listener hears that person; false for someone who did not say yes. */
export async function speakToListener(stack: Stack, api: StackApi, meetingId: string, who: Who, text: string, durationMs = 1500): Promise<boolean> {
  const res = await api.ctx.post('/api/test/media/speak', { data: { meetingId, actorId: testPersonas[who].actorId, text, durationMs }, headers: { ...(await api.headers()), 'x-test-auth': stack.testAuthToken } });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { delivered: boolean }).delivered;
}

export const actorOf = (key: Who): string => testPersonas[key].actorId;

// ---- a whole note-taker meeting, for the specs that start after it ------------------------------------------------------------------------------

/**
 * Nadia and Rafi hold a call in #general with the Note-taker bot (installed first); both say yes, each says one line, the room ends and the notes are written.
 * Returns the two people (their pages stay open on #general), the room and the notes row. The caller closes the people.
 */
export async function noteTakerMeeting(
  browser: Browser,
  playwright: PlaywrightWorkerArgs['playwright'],
  stack: Stack,
  omar: StackApi,
  lines: { nadia: string; rafi: string },
): Promise<{ nadia: Person; rafi: Person; meetingId: string; notes: Awaited<ReturnType<typeof finishNotes>> }> {
  const nadia = await openAs(browser, playwright, stack, 'nadia', '/t/engineering/c/general');
  await enterRoom(nadia);
  const meetingId = (await lastMeeting(stack, 'general')).id;
  const rafi = await openAs(browser, playwright, stack, 'rafi', '/t/engineering/c/general');
  await enterRoom(rafi);
  await nadia.page.getByTestId('call-notetaker-btn').click();
  await nadia.page.getByTestId('notetaker-add-note-taker').click();
  for (const p of [nadia, rafi]) await answerConsent(p, 'yes');
  await expect
    .poll(async () => [...((await mediaState(stack, omar, meetingId)).listeners[0]?.subscriptions ?? [])].sort(), { timeout: 20_000, message: 'the note-taker to listen to both' })
    .toEqual([actorOf('nadia'), actorOf('rafi')].sort());
  for (const [who, text] of [['nadia', lines.nadia], ['rafi', lines.rafi]] as const) {
    await expect.poll(() => speakToListener(stack, omar, meetingId, who, text), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await nadia.api.get<{ lines: Array<{ text: string }> }>(`/api/meetings/${meetingId}/transcript`)).lines.map((l) => l.text), { timeout: 20_000 }).toContain(text);
  }
  await leave(rafi);
  await endForEveryone(nadia);
  return { nadia, rafi, meetingId, notes: await finishNotes(stack, meetingId) };
}

/** The conversation channel and message in which the note-taker told the person its notes are ready (the card with Share and Save). */
export async function notesCardMessage(stack: Stack, meetingId: string): Promise<{ channelId: string; messageId: string }> {
  // The notes row turns `written` a moment before the bot's message is posted, so wait for the message.
  let found: { channel_id: string; id: string } | undefined;
  await expect
    .poll(
      async () => {
        const rows = await stack.sql<{ channel_id: string; id: string }>(
          `SELECT m.channel_id, m.id FROM app.messages m JOIN app.actors a ON a.id = m.author_id WHERE a.kind = 'bot' AND m.meta->'meetingNotes'->>'meetingId' = $1 ORDER BY m.id DESC LIMIT 1`,
          [meetingId],
        );
        found = rows[0];
        return found !== undefined;
      },
      { timeout: 30_000, message: 'the note-taker told the organizer' },
    )
    .toBe(true);
  return { channelId: found!.channel_id, messageId: found!.id };
}
