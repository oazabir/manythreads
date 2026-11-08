import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetRepoBlobResponse, StartMeetingResponse } from '@manythreads/shared';
import { relaxedRateLimiter } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eventually } from '../../channels/test/world.ts';
import { createWorld, ensureChannels, personas, type ApiResult, type FilesWorld } from '../../files/test/world.ts';

// The Scribe (PLAN P15-10 to P15-12), end to end on a real server: a room ends, its transcript is written, the team's Scribe runs (a stand-in for Hermes answers the notes JSON by
// rules read from the transcript lines), the platform checks every item and writes notes.md beside the transcript, posts the summary in the call thread, tells the owners, and
// files a public channel's meeting into the team's memory inbox (held when a guest was in the room; only on request for a private channel).

const { omar, nadia, rafi, priya } = personas;
vi.setConfig({ testTimeout: 120_000 });

// Rules, from the words on a transcript line: "DECIDE: x" a decision, "TASK <Name|none>: x" an action (owner by name), "ASK: x" a question, "BOGUS: x" a decision at a time that
// is not in the transcript, "PROSE" an answer that is not JSON, "CRASH" a model that falls over. A prompt that is not the notes prompt is the Archivist's: one concept.
const FAKE_HERMES = [
  "import { appendFileSync } from 'node:fs';",
  'const chunks = [];',
  'for await (const chunk of process.stdin) chunks.push(chunk);',
  "const prompt = Buffer.concat(chunks).toString('utf8').trim();",
  "appendFileSync(process.env.HERMES_FAKE_SPOOL ?? '/dev/null', JSON.stringify({ prompt }) + '\\n');",
  "const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');",
  "if (prompt.split('\\n')[0] === 'Write the notes of a meeting.') {",
  "  const body = prompt.slice(prompt.indexOf('----- TRANSCRIPT -----'), prompt.indexOf('----- END OF TRANSCRIPT -----'));",
  '  const rows = [];',
  '  for (const raw of body.split("\\n")) { const m = /^@(\\d+) \\| [^|]* \\| ([^:]{1,80}): (.+)$/.exec(raw.trim()); if (m) rows.push({ atMs: Number(m[1]), speaker: m[2], text: m[3] }); }',
  "  if (rows.some((r) => r.text.startsWith('CRASH'))) { out({ type: 'result', exit_code: 1, text: '', error: 'model fell over' }); process.exit(1); }",
  "  let reply;",
  "  if (rows.some((r) => r.text.startsWith('PROSE'))) reply = 'I read the transcript and it looks fine to me.';",
  '  else {',
  '    const notes = { summary: "They talked for " + rows.length + " lines.", decisions: [], actionItems: [], questions: [] };',
  '    for (const r of rows) {',
  '      let m;',
  "      if ((m = /^DECIDE: (.*)$/.exec(r.text))) notes.decisions.push({ text: m[1], atMs: r.atMs });",
  "      else if ((m = /^BOGUS: (.*)$/.exec(r.text))) notes.decisions.push({ text: m[1], atMs: 987654321 });",
  '      else if ((m = /^TASK (\\S+): (.*)$/.exec(r.text))) notes.actionItems.push({ text: m[2].replace(/ due \\d{4}-\\d{2}-\\d{2}/, ""), owner: m[1] === "none" ? null : m[1], due: (/ due (\\d{4}-\\d{2}-\\d{2})/.exec(m[2]) ?? [])[1] ?? null, atMs: r.atMs });',
  "      else if ((m = /^ASK: (.*)$/.exec(r.text))) notes.questions.push({ text: m[1], atMs: r.atMs });",
  '    }',
  '    reply = "Here are the notes:\\n```json\\n" + JSON.stringify(notes) + "\\n```";',
  '  }',
  "  out({ type: 'result', exit_code: 0, text: reply, tokens: { input: 5, output: 5, total: 10 } });",
  '} else {',
  "  const name = (/^Name: (.*)$/m.exec(prompt) ?? [])[1] ?? 'x';",
  "  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);",
  "  out({ type: 'result', exit_code: 0, text: JSON.stringify([{ path: 'memory/meetings/' + slug + '.md', type: 'Meeting', title: name, description: 'Filed by the stand-in', tags: ['meeting'], body: 'The stand-in filed this meeting.' }]), tokens: { input: 5, output: 5, total: 10 } });",
  '}',
  '',
].join('\n');

const bot = (name: string, role: string, trigger: string, native: string): string =>
  ['---', 'schema: 1', `name: ${name}`, `role: ${role}`, 'kind: agent', 'runtime: hermes', 'model:', '  aliases: [smart]', 'triggers:', `  - type: ${trigger}`, 'capabilities:', `  native: [${native}]`, '---', '', `# ${name}`, '', 'Stand-in definition.', ''].join('\n');
const SCRIBE = bot('Scribe', 'Writes the notes of a meeting', 'meeting_ended', 'meetings.read, memory.recall, meetings.write_notes');
const ARCHIVIST = bot('Archivist', 'Files what is dropped into the inbox', 'drop', 'inbox.read, memory.recall, memory.write');

let w: FilesWorld;
let scratch = '';
let spool = '';
const saved: Record<string, string | undefined> = Object.fromEntries(
  ['MANYTHREADS_MEDIA_PROVIDER', 'MANYTHREADS_HERMES_BIN', 'MANYTHREADS_HERMES_PREFIX', 'MANYTHREADS_RUNTIME_DIR', 'MANYTHREADS_LITELLM_URL', 'HERMES_FAKE_SPOOL'].map((k) => [k, process.env[k]]),
);
const restore = (): void => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

type Who = typeof nadia;
let seq = 0;
const ok = <T>(res: ApiResult, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body as T;
};
const open = async (channel: string, title: string, people: [Who, 'yes' | 'no'][]): Promise<string> => {
  const [starter, ...rest] = people;
  const id = StartMeetingResponse.parse(ok(await w.call(starter![0], 'POST', `/api/channels/${channel}/meetings`, { title }))).meeting.id;
  for (const [p] of rest) ok(await w.call(p, 'POST', `/api/meetings/${id}/join`));
  ok(await w.call(starter![0], 'PUT', `/api/meetings/${id}/transcription`, { mode: 'on_device' }));
  for (const [p, answer] of people) ok(await w.call(p, 'POST', `/api/meetings/${id}/consent`, { transcribe: answer }));
  return id;
};
const say = async (who: Who, room: string, text: string, startMs: number): Promise<void> => {
  ok(await w.call(who, 'POST', `/api/meetings/${room}/segments`, { segments: [{ clientSegId: `n${++seq}`, startMs, endMs: startMs + 1500, text, final: true }] }));
};
/** Ends the room and runs its transcript job now instead of in two minutes. */
const endAndWrite = async (room: string, who: Who = nadia): Promise<void> => {
  ok(await w.call(who, 'POST', `/api/meetings/${room}/end`));
  const jobs = () => w.system(async (tx) => (await tx.query<{ state: string }>("SELECT state FROM app.jobs WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1", [room])).rows);
  await eventually(async () => ((await jobs()).length > 0 ? true : undefined), 20_000, 'the transcript job');
  await w.system(async (tx) => void (await tx.query("UPDATE app.jobs SET run_at = now() WHERE queue = 'meetings.transcript' AND payload->>'meetingId' = $1 AND state = 'ready'", [room])));
  await eventually(async () => ((await jobs()).every((j) => ['done', 'completed', 'succeeded'].includes(j.state)) ? true : undefined), 30_000, 'the transcript job to finish');
};
interface NotesRow {
  status: string;
  notes_path: string | null;
  notes_md: string | null;
  items: Array<{ kind: string; text: string; ownerName: string | null; ownerId: string | null; due: string | null; atMs: number }>;
  memory_item_id: string | null;
  transcript_path: string;
  file_ids: string[];
}
const notesOf = (room: string) =>
  w.system(async (tx) => (await tx.query<NotesRow>('SELECT status, notes_path, notes_md, items, memory_item_id, transcript_path, file_ids FROM app.meeting_notes WHERE meeting_id = $1', [room])).rows[0]);
const settled = (room: string): Promise<NotesRow> =>
  eventually(async () => {
    const row = await notesOf(room);
    return row && row.status !== 'pending' ? row : undefined;
  }, 90_000, `the notes of ${room}`);
const inboxItem = (room: string) =>
  w.system(async (tx) =>
    (
      await tx.query<{ id: string; state: string; hold_reason: string | null; origin: string; name: string; dropper_id: string | null }>(
        `SELECT i.id, i.state, i.hold_reason, i.origin, i.name, i.dropper_id FROM app.memory_inbox_items i JOIN app.meeting_notes n ON n.memory_item_id = i.id WHERE n.meeting_id = $1`,
        [room],
      )
    ).rows[0],
  );
const threadPosts = (room: string) =>
  w.system(async (tx) =>
    (await tx.query<{ body: string; author: string; kind: string }>(
      `SELECT m.body AS body, m.author_id::text AS author, a.kind FROM app.messages m JOIN app.meetings mt ON mt.thread_root_id = m.thread_root_id JOIN app.actors a ON a.id = m.author_id WHERE mt.id = $1 AND m.id <> mt.thread_root_id ORDER BY m.id`,
      [room],
    )).rows,
  );
/** The first line in the call's thread that holds `text`; the thread is written just after the notes row settles, so this waits for it. */
const postWith = (room: string, text: string) =>
  eventually(async () => (await threadPosts(room)).find((p) => p.body.includes(text)), 30_000, `a thread line with "${text}"`);
const spooled = (): string[] =>
  existsSync(spool)
    ? readFileSync(spool, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => (JSON.parse(l) as { prompt: string }).prompt)
    : [];
const approve = async (path: string, content: string): Promise<void> => void ok(await w.call(omar, 'POST', '/api/teams/engineering/proposals', { path, op: 'put', content, title: `Set up ${path}`, applyNow: true }), 201);
const blob = async (path: string): Promise<string> => GetRepoBlobResponse.parse(ok(await w.call(omar, 'GET', `/api/teams/engineering/repo/blob?path=${encodeURIComponent(path)}`))).content;

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'meetings-scribe-'));
  spool = join(scratch, 'spool.jsonl');
  const script = join(scratch, 'fake-hermes.mjs');
  writeFileSync(script, FAKE_HERMES, 'utf8');
  process.env['MANYTHREADS_MEDIA_PROVIDER'] = 'fake';
  process.env['MANYTHREADS_HERMES_BIN'] = process.execPath;
  process.env['MANYTHREADS_HERMES_PREFIX'] = script;
  process.env['MANYTHREADS_RUNTIME_DIR'] = join(scratch, 'profiles');
  process.env['MANYTHREADS_LITELLM_URL'] = 'http://litellm.invalid:4000';
  process.env['HERMES_FAKE_SPOOL'] = spool;
  w = await createWorld({ limiter: relaxedRateLimiter() } as never);
  await ensureChannels(w);
  await approve('bots/scribe/BOT.md', SCRIBE);
  await approve('bots/archivist/BOT.md', ARCHIVIST);
  await eventually(
    async () => ((await w.system(async (tx) => (await tx.query("SELECT 1 FROM app.bots b JOIN app.teams t ON t.id = b.team_id WHERE t.slug = 'engineering' AND b.slug IN ('scribe', 'archivist') AND b.status = 'active' HAVING count(*) = 2")).rows.length)) > 0 ? true : undefined),
    30_000,
    'the loader to load the Scribe and the Archivist',
  );
}, 240_000);
afterAll(async () => {
  await w?.close();
  restore();
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true });
});

describe('a public channel: notes, thread, owners and memory', () => {
  let room = '';
  let notes: NotesRow;
  beforeAll(async () => {
    room = await open(await w.channelId('engineering', 'general'), 'Sprint review', [[nadia, 'yes'], [rafi, 'yes'], [omar, 'no']]);
    await say(nadia, room, 'DECIDE: Ship on Thursday', 0);
    await say(nadia, room, 'TASK Rafi: Write the migration note due 2026-11-06', 4000);
    await say(rafi, room, 'TASK Rafi: Review the plan', 8000);
    await say(rafi, room, 'TASK Nadia: Tell support', 12000);
    await say(nadia, room, 'TASK Omar: Own the invoice export', 16000);
    await say(rafi, room, 'TASK none: Update the status page', 20000);
    await say(nadia, room, 'ASK: Who pays for the pilot?', 24000);
    await say(rafi, room, 'BOGUS: A decision at a time nobody spoke', 28000);
    await say(omar, room, 'DECIDE: this must never be written', 32000);
    await endAndWrite(room);
    notes = await settled(room);
  });

  it('writes notes.md beside the transcript, with owners, no-owner and a link to the time of every item', async () => {
    expect(notes.status).toBe('written');
    expect(notes.notes_path).toBe(notes.transcript_path.replace(/transcript\.md$/, 'notes.md'));
    const md = await blob(notes.notes_path!);
    expect(md).toContain('type: "Meeting Notes"');
    expect(md).toContain('- Ship on Thursday ([00:00:00](transcript.md))');
    expect(md).toContain('- [ ] Write the migration note — owner: Rafi, due 2026-11-06 ([00:00:04](transcript.md))');
    expect(md).toContain('- [ ] Update the status page — no owner ([00:00:20](transcript.md))');
    expect(md).toContain('- Who pays for the pilot? ([00:00:24](transcript.md))');
    expect(notes.notes_md).toBe(md);
  });

  it('attributes nothing to the person who said no, drops an item at a time that is not a line, and never shows the model his words', async () => {
    expect(md(notes)).toContain('- [ ] Own the invoice export — no owner');
    expect(md(notes)).not.toContain('owner: Omar');
    expect(md(notes)).not.toContain('nobody spoke');
    expect(md(notes)).not.toContain('never be written');
    const prompt = spooled().find((p) => p.includes('Ship on Thursday'))!;
    expect(prompt).not.toContain('never be written');
    expect(notes.items.find((i) => i.text === 'Own the invoice export')).toMatchObject({ ownerName: null, ownerId: null });
  });

  it('posts the summary in the call thread, as the platform, with the way to the notes', async () => {
    const post = await postWith(room, '**Notes from Sprint review**');
    expect(post.body).toContain(`[Open the notes](/meetings/${room})`);
    expect(post.body).toContain('1 decision · 5 action items · 1 open question');
  });

  it('says so once in an event that carries ids and counts, never text', async () => {
    const events = await w.system(async (tx) => (await tx.query<{ payload: Record<string, unknown> }>("SELECT payload FROM app.events WHERE type = 'meetings.notes.written' AND payload->>'meetingId' = $1", [room])).rows.map((r) => r.payload));
    expect(events).toHaveLength(1);
    expect([...(events[0]!['actionOwnerIds'] as string[])].sort()).toEqual([nadia.actorId, rafi.actorId].sort());
    expect(JSON.stringify(events[0])).not.toContain('Ship on Thursday');
  });

  it('tells each owner how many action items they were given, once, and nobody else', async () => {
    const rows = await eventually(async () => {
      const found = await w.system(async (tx) => (await tx.query<{ person_id: string; preview: string; kind: string; ref_type: string }>("SELECT person_id, preview, kind, ref_type FROM app.notifications WHERE ref_id = $1 ORDER BY preview", [room])).rows);
      return found.length >= 2 ? found : undefined;
    }, 30_000, 'the notifications');
    expect(rows).toHaveLength(2);
    const byPerson = Object.fromEntries(rows.map((r) => [r.person_id, r]));
    expect(byPerson[rafi.personId]).toMatchObject({ kind: 'meeting_actions', ref_type: 'meeting', preview: '2 action items from Sprint review' });
    expect(byPerson[nadia.personId]).toMatchObject({ kind: 'meeting_actions', ref_type: 'meeting', preview: '1 action item from Sprint review' });
  });

  it('files the meeting into the team\'s memory inbox by itself, as the first person who said yes, and the Archivist files it', async () => {
    const item = await eventually(async () => {
      const row = await inboxItem(room);
      return row && ['filed', 'needs_review', 'failed'].includes(row.state) ? row : undefined;
    }, 90_000, 'the memory item');
    expect(item).toMatchObject({ origin: 'meeting', state: 'filed', dropper_id: nadia.actorId });
    expect(item.name).toContain('Sprint review');
    // the platform keeps a reference copy of the dropped text in the team's memory: it names the transcript and the time of each line
    const paths = await w.system(async (tx) => (await tx.query<{ filed_paths: string[] }>('SELECT filed_paths FROM app.memory_inbox_items WHERE id = $1', [item.id])).rows[0]!.filed_paths);
    const reference = paths.find((p) => p.startsWith('memory/references/'));
    expect(reference, JSON.stringify(paths)).toBeDefined();
    const text = await blob(reference!);
    expect(text).toContain(notes.transcript_path);
    expect(text).toContain('[00:00:04] Nadia: TASK Rafi: Write the migration note due 2026-11-06');
    expect(text).not.toContain('never be written');
    expect((await notesOf(room))!.memory_item_id).toBe(item.id);
  });

  const md = (n: NotesRow): string => n.notes_md ?? '';
});

describe('a run that does not give notes', () => {
  it('asks twice when the answer is not an object, then writes down that it failed and says so in the thread, with the way to the transcript', async () => {
    const before = spooled().length;
    const room = await open(await w.channelId('engineering', 'dev'), 'Prose please', [[nadia, 'yes']]);
    await say(nadia, room, 'PROSE', 0);
    await endAndWrite(room);
    const notes = await settled(room);
    expect(notes.status).toBe('failed');
    expect(notes.notes_path).toBeNull();
    expect(spooled().length - before).toBe(2);
    expect(spooled().slice(before)[1]).toContain('Your last answer was not one JSON object');
    const post = await postWith(room, 'could not be written');
    expect(post.body).toContain(notes.transcript_path);
    expect(post.body).toContain(`/meetings/${room}`);
    expect(await inboxItem(room)).toBeUndefined();
  });

  it('fails plainly, with no text from the failure, when the model falls over', async () => {
    const room = await open(await w.channelId('engineering', 'dev'), 'Crash please', [[nadia, 'yes']]);
    await say(nadia, room, 'CRASH', 0);
    await endAndWrite(room);
    const notes = await settled(room);
    expect(notes.status).toBe('failed');
    const post = await postWith(room, 'could not be written');
    expect(post.body).not.toContain('fell over');
    const runs = await w.system(async (tx) => (await tx.query<{ status: string; trigger_type: string }>("SELECT status, trigger_type FROM app.bot_runs WHERE trigger_type = 'meeting_ended' ORDER BY started_at")).rows);
    expect(runs.some((r) => r.status === 'failed')).toBe(true);
    expect(runs.some((r) => r.status === 'done' || r.status === 'succeeded')).toBe(true);
  });
});

describe('a room with somebody from outside the team', () => {
  it('holds the memory item for a lead instead of filing it', async () => {
    // Priya takes part and then leaves the team (a guest of the room by the time the notes are written)
    const room = await open(await w.channelId('engineering', 'releases'), 'Release call', [[nadia, 'yes'], [priya, 'yes']]);
    await say(nadia, room, 'DECIDE: Release on Friday', 0);
    await say(priya, room, 'Sounds good to me', 3000);
    const teamId = await w.system(async (tx) => (await tx.query<{ id: string }>("SELECT id FROM app.teams WHERE slug = 'engineering'")).rows[0]!.id);
    await w.system(async (tx) => void (await tx.query('DELETE FROM app.team_members WHERE team_id = $1 AND actor_id = $2', [teamId, priya.actorId])));
    try {
      await endAndWrite(room);
      expect((await settled(room)).status).toBe('written');
      const item = await eventually(async () => (await inboxItem(room)) ?? undefined, 60_000, 'the held item');
      expect(item).toMatchObject({ origin: 'meeting', state: 'held', hold_reason: 'unknown_sender' });
    } finally {
      await w.system(async (tx) => void (await tx.query("INSERT INTO app.team_members (team_id, actor_id, workspace_id, role) VALUES ($1, $2, $3, 'member') ON CONFLICT DO NOTHING", [teamId, priya.actorId, priya.workspaceId])));
    }
  });
});

describe('a private channel', () => {
  let room = '';
  beforeAll(async () => {
    const made = ok<{ channel: { id: string } }>(await w.call(omar, 'POST', '/api/teams/engineering/channels', { name: 'scribe-private', private: true }), 201);
    ok(await w.call(omar, 'POST', `/api/channels/${made.channel.id}/members`, { personId: nadia.personId }));
    room = await open(made.channel.id, 'Private sync', [[omar, 'yes'], [nadia, 'yes']]);
    await say(omar, room, 'DECIDE: Keep this between us', 0);
    await endAndWrite(room, omar);
  });

  it('writes the notes into the channel\'s files, and files nothing into memory by itself', async () => {
    const notes = await settled(room);
    expect(notes.status).toBe('written');
    expect(notes.file_ids).toHaveLength(2);
    expect(notes.notes_path).toMatch(/\/notes\.md$/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await inboxItem(room)).toBeUndefined();
  });

  it('shows a warning first, and files only after a person confirms', async () => {
    const asked = ok<{ warning: string; sent: boolean; memoryItemId: string | null }>(await w.call(nadia, 'POST', `/api/meetings/${room}/send-to-memory`, { confirmed: false }));
    expect(asked).toMatchObject({ sent: false, memoryItemId: null });
    expect(asked.warning).toContain('private channel');
    expect(asked.warning).toContain('everyone in Engineering will see');
    expect(await inboxItem(room)).toBeUndefined();
    const sent = ok<{ sent: boolean; memoryItemId: string }>(await w.call(nadia, 'POST', `/api/meetings/${room}/send-to-memory`, { confirmed: true }));
    expect(sent.sent).toBe(true);
    expect(await inboxItem(room)).toMatchObject({ id: sent.memoryItemId, origin: 'meeting' });
    // a second press returns the same item and files nothing more
    const again = ok<{ sent: boolean; memoryItemId: string }>(await w.call(omar, 'POST', `/api/meetings/${room}/send-to-memory`, { confirmed: true }));
    expect(again).toMatchObject({ sent: true, memoryItemId: sent.memoryItemId });
  });

  it('is refused for a person who was not in the room, and for a room that has no notes yet', async () => {
    expect((await w.call(rafi, 'POST', `/api/meetings/${room}/send-to-memory`, { confirmed: true })).status).toBeGreaterThanOrEqual(403);
  });
});

describe('a team that keeps its meetings out of memory', () => {
  it('writes the notes and files nothing when TEAM.md says autoMemory: false', async () => {
    const current = await blob('TEAM.md').catch(() => '');
    const body = current.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    await approve('TEAM.md', `---\nmeetings:\n  autoMemory: false\n---\n${body}`);
    const room = await open(await w.channelId('engineering', 'standup'), 'Stand-up', [[nadia, 'yes']]);
    await say(nadia, room, 'DECIDE: Skip the stand-up', 0);
    await endAndWrite(room);
    expect((await settled(room)).status).toBe('written');
    await new Promise((r) => setTimeout(r, 1500));
    expect(await inboxItem(room)).toBeUndefined();
  });
});
