import { createSystemPool, withSystem } from '@manythreads/kernel';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, LENA, NADIA, OMAR, PRIYA, RAFI, TEAM_IDS, type Persona } from './personas.ts';
import { SEED_IDS } from './seed-content.ts';

/**
 * Seed v15 (PLAN P15-17): what the meetings screens show on a site that has been through a few calls. OPT-IN: nothing calls this from `seedWorld`; only the stack
 * with `MANYTHREADS_STACK_SEED=meetings` (e2e/fixtures/stack-server.ts) and the specs that ask for it run it, so every other stack and baseline stays as it was
 * (a test asserts `seedWorld` alone never creates a meeting).
 *
 * Three finished calls in the Engineering team, made through the real routes of the running server (a person starts a room, joins, answers the consent prompt, says
 * a line; the platform writes the transcript, the Scribe's stand-in writes the notes, the Archivist's stand-in files the memory) and not written to tables:
 *
 *  1. "Engineering stand-up" in `#dev` (public): Nadia, Rafi, and Priya who said no. Transcript and notes in the team repo under `meetings/`, a `Meeting` concept in
 *     memory, two action items, one of them already a card on the team board.
 *  2. "Leads sync" in `#eng-leads` (private; Omar and Nadia): transcript and notes in Files under the channel, nothing in memory.
 *  3. "Design review" in `#general` with the note-taker bot: Nadia is the organizer, Rafi said yes, Priya no. Transcript and notes in Nadia's Personal space,
 *     the bot's direct message to Nadia carries the Share and Save buttons.
 *
 * Needs a server started with `MANYTHREADS_MEDIA_PROVIDER=fake`, `MANYTHREADS_FAKE_ASR=1`, test plugins, `devAuth`, and a Hermes command that answers the meeting prompts
 * (e2e/fixtures/meeting-hermes.mjs); the stack server sets all of that for the `meetings` mode. The meetings have today's date: the server's clock is the real one.
 * Run it once per database: a second run finds the stand-up by its title and refuses (the calls are not made twice).
 */
export const SEED_MEETINGS = {
  team: 'engineering',
  standup: { title: 'Engineering stand-up', channel: 'dev', slug: 'engineering-stand-up' },
  leads: { title: 'Leads sync', channel: 'eng-leads' },
  design: { title: 'Design review', channel: 'general' },
  boardName: 'Team board',
} as const;

/** The lines of each call as the speakers said them. Priya's line in the stand-up is never stored: she said no. */
export const STANDUP_LINES: ReadonlyArray<{ who: Persona; text: string }> = [
  { who: NADIA, text: 'Good morning. Quick stand-up before the release.' },
  { who: RAFI, text: 'The staging run was green overnight and the cache change is merged.' },
  { who: NADIA, text: 'We decided to ship the new cache time on Thursday morning.' },
  { who: RAFI, text: 'I will write the rollback note by 2026-11-12.' },
  { who: PRIYA, text: 'I can cover the support questions on Thursday.' },
  { who: NADIA, text: "I'll update the release checklist before the release." },
  { who: RAFI, text: 'Who is on call this weekend?' },
];
export const LEADS_LINES: ReadonlyArray<{ who: Persona; text: string }> = [
  { who: OMAR, text: 'We agreed to keep the hiring plan for the autumn as it is.' },
  { who: NADIA, text: 'I will bring the budget numbers to the next leads sync.' },
  { who: OMAR, text: 'Who covers the on-call rota while Rafi is away?' },
];
export const DESIGN_LINES: ReadonlyArray<{ who: Persona; text: string }> = [
  { who: NADIA, text: "Let's start the design review for the settings page." },
  { who: RAFI, text: 'The new layout works at 390 pixels and the spacing is consistent.' },
  { who: NADIA, text: 'We decided to keep the sidebar collapsed by default.' },
  { who: RAFI, text: 'I will send the updated mockups to Nadia by 2026-11-13.' },
  { who: NADIA, text: 'Please check the contrast on the dark theme.' },
  { who: NADIA, text: 'Who reviews the icon set?' },
];

/** The three bot definitions the stack needs (a seeded team has none of the template bots). Plain stand-ins: the model behind them is `meeting-hermes.mjs`. */
const botMd = (name: string, role: string, trigger: string, native: string, aliases = 'smart'): string =>
  ['---', 'schema: 1', `name: ${name}`, `role: ${role}`, 'kind: agent', 'runtime: hermes', 'model:', `  aliases: [${aliases}]`, 'triggers:', `  - type: ${trigger}`, 'capabilities:', `  native: [${native}]`, '---', '', `# ${name}`, '', 'Stand-in definition for the browser tests.', ''].join('\n');
export const MEETING_BOT_FILES: ReadonlyArray<{ slug: string; md: string }> = [
  { slug: 'scribe', md: botMd('Scribe', 'Writes the notes of a meeting', 'meeting_ended', 'meetings.read, memory.recall, meetings.write_notes') },
  { slug: 'archivist', md: botMd('Archivist', 'Files what is dropped into the inbox', 'drop', 'inbox.read, memory.recall, memory.write') },
  { slug: 'note-taker', md: botMd('Note-taker', 'Sits in a call and writes its notes', 'meeting', 'meetings.read, meetings.search, memory.recall, meetings.write_notes', 'smart, fast') },
];

export interface SeedMeetingsOptions {
  /** The server's address (`TestServer.url`); it must have been started with `devAuth`. */
  url: string;
  db: Pick<TestDatabase, 'systemUrl'>;
  /** Waits at most this long for each step (default 90 seconds). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface SeededMeeting {
  id: string;
  title: string;
  channelId: string;
  /** The call's chat thread (the message every reply hangs on). */
  threadRootId: string;
}

export interface SeedMeetingsResult {
  standup: SeededMeeting & { transcriptPath: string; notesPath: string; memoryItemId: string | null; cardTitle: string | null };
  leads: SeededMeeting & { transcriptPath: string; notesPath: string };
  design: SeededMeeting & { transcriptPath: string; notesPath: string; botId: string };
}

interface Reply {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the replies of many routes, read by field
}

const header = (who: Persona): Record<string, string> => ({ 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) });

async function call(url: string, who: Persona, method: string, path: string, body?: unknown): Promise<Reply> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...header(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: parsed };
}

async function ok(url: string, who: Persona, method: string, path: string, body?: unknown, expected: readonly number[] = [200, 201, 202]): Promise<Reply> {
  const reply = await call(url, who, method, path, body);
  if (!expected.includes(reply.status)) throw new Error(`seed meetings: ${method} ${path} answered ${String(reply.status)}: ${JSON.stringify(reply.body).slice(0, 300)}`);
  return reply;
}

async function until<T>(what: string, timeoutMs: number, fn: () => Promise<T | false | null | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`seed meetings: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Seeds the three calls (see the top of this file). Throws with the server's words when a step is refused or something does not settle in time.
 */
export async function seedMeetings(options: SeedMeetingsOptions): Promise<SeedMeetingsResult> {
  const { url } = options;
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 90_000;
  const pool = createSystemPool(options.db.systemUrl, 2);
  const sys = <T>(fn: Parameters<typeof withSystem<T>>[0]): Promise<T> => withSystem(fn, { pool, workspaceId: KAHF_WORKSPACE_ID });
  try {
    // ---- the bots the calls need -------------------------------------------------------------------------------------------------------------------
    for (const bot of MEETING_BOT_FILES) {
      const res = await call(url, OMAR, 'POST', `/api/teams/${SEED_MEETINGS.team}/proposals`, { path: `bots/${bot.slug}/BOT.md`, op: 'put', content: bot.md, title: `Set up ${bot.slug}`, applyNow: true });
      if (res.status >= 300 && !(res.status === 400 && JSON.stringify(res.body).includes('does not change the file'))) throw new Error(`seed meetings: could not set up ${bot.slug}: ${String(res.status)} ${JSON.stringify(res.body).slice(0, 300)}`);
    }
    await until('the loader to load the three bots', timeoutMs, async () =>
      sys(async (tx) => (await tx.query(`SELECT 1 FROM app.bots WHERE team_id = $1 AND slug = ANY($2::text[]) AND status = 'active' HAVING count(*) = $3`, [TEAM_IDS.Engineering, MEETING_BOT_FILES.map((b) => b.slug), MEETING_BOT_FILES.length])).rows.length > 0),
    );
    const botId = await sys(async (tx) => (await tx.query<{ id: string }>(`SELECT id FROM app.bots WHERE team_id = $1 AND slug = 'note-taker'`, [TEAM_IDS.Engineering])).rows[0]!.id);

    const earlier = await sys(async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM app.meetings WHERE team_id = $1 AND title = $2 AND state = 'ended'`, [TEAM_IDS.Engineering, SEED_MEETINGS.standup.title])).rows[0],
    );
    if (earlier) throw new Error('seed meetings: the meetings are already there (seed once per database)');

    const channel = SEED_IDS.channels;
    // ---- shared steps ------------------------------------------------------------------------------------------------------------------------------
    const open = async (organizer: Persona, channelId: string, title: string): Promise<SeededMeeting> => {
      const started = await ok(url, organizer, 'POST', `/api/channels/${channelId}/meetings`, { title });
      return { id: started.body.meeting.id as string, title, channelId, threadRootId: started.body.meeting.threadRootId as string };
    };
    const transcribe = async (m: SeededMeeting, turnedOnBy: Persona, answers: ReadonlyArray<[Persona, 'yes' | 'no']>): Promise<void> => {
      await ok(url, turnedOnBy, 'PUT', `/api/meetings/${m.id}/transcription`, { mode: 'on_device' });
      for (const [who, answer] of answers) await ok(url, who, 'POST', `/api/meetings/${m.id}/consent`, { transcribe: answer });
    };
    const say = async (m: SeededMeeting, lines: ReadonlyArray<{ who: Persona; text: string }>): Promise<void> => {
      let at = 0;
      let n = 0;
      for (const line of lines) {
        n += 1;
        await ok(url, line.who, 'POST', `/api/meetings/${m.id}/segments`, { segments: [{ clientSegId: `seed-${m.id.slice(-6)}-${String(n)}`, startMs: at, endMs: at + 3500, text: line.text, final: true }] });
        at += 5000;
      }
    };
    /** Ends the room and runs its transcript job now instead of two minutes later. */
    const endAndWrite = async (m: SeededMeeting, who: Persona): Promise<void> => {
      await ok(url, who, 'POST', `/api/meetings/${m.id}/end`);
      await until('the transcript job', timeoutMs, async () =>
        sys(async (tx) => {
          await tx.query(`UPDATE app.jobs SET run_at = now() WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1 AND state = 'ready'`, [m.id]);
          return (await tx.query(`SELECT 1 FROM app.jobs WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1`, [m.id])).rows.length > 0;
        }),
      );
    };
    const settledNotes = (m: SeededMeeting, reader: Persona): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
      until(`the notes of ${m.title}`, timeoutMs, async () => {
        const res = await call(url, reader, 'GET', `/api/meetings/${m.id}/notes`);
        return res.status === 200 && res.body.status !== 'pending' ? res.body : false;
      });
    const pathsOf = async (m: SeededMeeting): Promise<{ transcriptPath: string; notesPath: string }> => {
      const row = await sys(async (tx) => (await tx.query<{ transcript_path: string; notes_path: string | null; status: string; failure: string | null }>(`SELECT transcript_path, notes_path, status, failure FROM app.meeting_notes WHERE meeting_id = $1`, [m.id])).rows[0]);
      if (!row || row.status !== 'written' || !row.notes_path) throw new Error(`seed meetings: the notes of ${m.title} were not written (${row?.status ?? 'no row'}: ${row?.failure ?? ''})`);
      return { transcriptPath: row.transcript_path, notesPath: row.notes_path };
    };

    // ---- 1. the stand-up in #dev -------------------------------------------------------------------------------------------------------------------
    const standup = await open(NADIA, channel['engineering/dev'], SEED_MEETINGS.standup.title);
    await ok(url, RAFI, 'POST', `/api/meetings/${standup.id}/join`);
    await ok(url, PRIYA, 'POST', `/api/meetings/${standup.id}/join`);
    await transcribe(standup, NADIA, [[NADIA, 'yes'], [RAFI, 'yes'], [PRIYA, 'no']]);
    await say(standup, STANDUP_LINES);
    await endAndWrite(standup, NADIA);
    const standupNotes = await settledNotes(standup, NADIA);
    if (standupNotes.status !== 'written') throw new Error(`seed meetings: the stand-up notes ended ${String(standupNotes.status)}`);
    const standupPaths = await pathsOf(standup);
    log(`stand-up: ${standupPaths.transcriptPath}`);
    // the Archivist's stand-in files the meeting by itself (a public channel); wait for the item to settle
    const memoryItemId = await until('the stand-up to be filed into memory', timeoutMs, async () => {
      const row = await sys(async (tx) => (await tx.query<{ memory_item_id: string | null }>(`SELECT memory_item_id FROM app.meeting_notes WHERE meeting_id = $1`, [standup.id])).rows[0]);
      if (!row?.memory_item_id) return false;
      const item = (await call(url, OMAR, 'GET', `/api/teams/${SEED_MEETINGS.team}/inbox/items/${row.memory_item_id}`)).body?.item;
      return item && ['filed', 'failed', 'held', 'needs_review'].includes(item.state) ? row.memory_item_id : false;
    });
    // one of the two action items is already a card on the team board, made as Nadia does with "Add to board"
    const boards = (await ok(url, NADIA, 'GET', `/api/teams/${SEED_MEETINGS.team}/boards`)).body.items as Array<{ id: string; name: string }>;
    const board = boards[0] ?? (await ok(url, OMAR, 'POST', `/api/teams/${SEED_MEETINGS.team}/boards`, { name: SEED_MEETINGS.boardName })).body.board;
    const actions = (standupNotes.items as Array<{ kind: string; text: string; ownerName: string | null; due: string | null; atMs: number }>).filter((i) => i.kind === 'action');
    const first = actions.find((a) => a.ownerName === 'Rafi') ?? actions[0];
    let cardTitle: string | null = null;
    if (first) {
      const description = [`From the meeting “${standup.title}”, at 0:00:${String(Math.floor(first.atMs / 1000)).padStart(2, '0')}.`, first.ownerName ? `Owner: ${first.ownerName}` : 'Owner: no owner', first.due ? `Due: ${first.due}` : null].filter((l) => l !== null).join('\n');
      await ok(url, NADIA, 'POST', `/api/teams/${SEED_MEETINGS.team}/tasks`, { title: first.text.slice(0, 200), description, kind: 'other', priority: 'normal', branch: 'main', boardId: board.id });
      cardTitle = first.text.slice(0, 200);
    }

    // ---- 2. the private call in #eng-leads ---------------------------------------------------------------------------------------------------------
    const leads = await open(OMAR, channel['engineering/eng-leads'], SEED_MEETINGS.leads.title);
    await ok(url, NADIA, 'POST', `/api/meetings/${leads.id}/join`);
    await transcribe(leads, OMAR, [[OMAR, 'yes'], [NADIA, 'yes']]);
    await say(leads, LEADS_LINES);
    await endAndWrite(leads, OMAR);
    const leadsNotes = await settledNotes(leads, OMAR);
    if (leadsNotes.status !== 'written') throw new Error(`seed meetings: the leads notes ended ${String(leadsNotes.status)}`);
    const leadsPaths = await pathsOf(leads);
    log(`leads sync: ${leadsPaths.transcriptPath}`);

    // ---- 3. the note-taker call in #general --------------------------------------------------------------------------------------------------------
    const design = await open(NADIA, channel['engineering/general'], SEED_MEETINGS.design.title);
    await ok(url, RAFI, 'POST', `/api/meetings/${design.id}/join`);
    await ok(url, PRIYA, 'POST', `/api/meetings/${design.id}/join`);
    await ok(url, NADIA, 'PUT', `/api/meetings/${design.id}/notetaker`, { botId });
    await until('the note-taker to join the room', timeoutMs, async () => (await ok(url, NADIA, 'GET', `/api/meetings/${design.id}/notetakers`)).body.current?.listening === true);
    for (const [who, answer] of [[NADIA, 'yes'], [RAFI, 'yes'], [PRIYA, 'no']] as const) await ok(url, who, 'POST', `/api/meetings/${design.id}/consent`, { transcribe: answer });
    // the listener follows a consent change within a couple of seconds; Priya's words never reach it, and the stand-in says so
    await until('the note-taker to hear the right people', timeoutMs, async () => (await ok(url, OMAR, 'POST', '/api/test/media/speak', { meetingId: design.id, actorId: PRIYA.actorId, text: 'seed probe' })).body.delivered === false);
    for (const [i, line] of DESIGN_LINES.entries()) {
      await until(`the listener to hear line ${String(i + 1)}`, timeoutMs, async () => (await ok(url, OMAR, 'POST', '/api/test/media/speak', { meetingId: design.id, actorId: line.who.actorId, text: line.text })).body.delivered === true);
      await until(`line ${String(i + 1)} in the transcript`, timeoutMs, async () => ((await ok(url, NADIA, 'GET', `/api/meetings/${design.id}/transcript`)).body.lines as Array<{ text: string }>).some((l) => l.text === line.text));
    }
    await ok(url, NADIA, 'POST', `/api/meetings/${design.id}/end`);
    const designNotes = await settledNotes(design, NADIA);
    if (designNotes.status !== 'written') throw new Error(`seed meetings: the design review notes ended ${String(designNotes.status)}`);
    const designPaths = await pathsOf(design);
    log(`design review (note-taker): ${designPaths.transcriptPath}`);

    return {
      standup: { ...standup, ...standupPaths, memoryItemId, cardTitle },
      leads: { ...leads, ...leadsPaths },
      design: { ...design, ...designPaths, botId },
    };
  } finally {
    await pool.end();
  }
}

/** Lena (a guest of `#releases`) is used by the specs that need a guest in a room. */
export const SEED_MEETINGS_GUEST = LENA;
