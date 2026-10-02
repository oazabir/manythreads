import type { PlaywrightWorkerArgs } from '@playwright/test';
import type { Stack } from '../../fixtures/stack.ts';
import { apiOn, channelsOf, type StackApi } from '../../support/stack-browser.ts';
import { TEAM_IDS } from '../../fixtures/seed.ts';

/*
 * The story of plate 1 and plate 2 of the app prototype (docs/spec/mockups-all.html, section `app`): the release channel of the
 * Engineering team, a goal thread of seven replies, two attachments. The prototype's bots (Orchestrator, Coder, Tester, ...) do not exist
 * before phase 5, so the same words are spoken by the people of the seed; an agent's lane is the one part of the plates that has no live
 * counterpart (the visual specs mask it, see `story.agentRows`).
 *
 * The channel is created by the spec on a stack seeded with `MANYTHREADS_STACK_SEED=content`, through the same routes the app uses, so
 * the numbers the screen shows (replies, unread, attachments) are the server's.
 */

export type StoryPerson = 'omar' | 'nadia' | 'rafi' | 'priya';

interface Line {
  who: StoryPerson;
  text: string;
  /** Spoken by one of the prototype's bots: the live row carries no lane. */
  agent?: boolean;
  file?: { name: string; mime: string; bytes: number };
}

export const CHANNEL = 'release-eng';

const ROOT: Line = {
  who: 'priya',
  agent: true,
  text: 'Goal G-27 created. Starting @nadia on `feat/schedule-migration`.',
};

/** The channel, oldest first. `ROOT` is the third message and carries the thread. */
const CHANNEL_LINES: Line[] = [
  {
    who: 'rafi',
    text: 'MT7981 QA batch is done. 48 of 50 boards pass. Two have the LED flicker again — same as last batch.',
    file: { name: 'qa-batch-7-report.pdf', mime: 'application/pdf', bytes: 412 * 1024 },
  },
  {
    who: 'omar',
    text: '@Orchestrator per-device schedules need a migration for the old household profile. Existing profiles migrate to a household default, every device inherits it, upgrade test passes on a 2.3 fixture. Ship it to production.',
  },
  ROOT,
  {
    who: 'nadia',
    text: 'Release notes for 2.4 are drafted — @rafi can you check the LED section matches what QA saw?',
    file: { name: 'release-notes-2.4.md', mime: 'text/markdown', bytes: 6 * 1024 },
  },
  { who: 'priya', agent: true, text: '3 updates collected from #router-firmware since 17:00 yesterday. Posted to #eng-leads.' },
  // below the prototype's fold: the list has to be longer than the screen for its first day to sit at the top, as the plate's does
  { who: 'rafi', text: 'The LED section matches what QA saw. One typo in the DNS paragraph, I will fix it in the draft.' },
  { who: 'nadia', text: 'Thanks. I will fold that in before the freeze and ping the channel when the notes are final.' },
  { who: 'omar', text: 'Good. Ship it once the fixture is in and the upgrade test passes on the 2.3 profile.' },
];

const QA_REPLIES: Line[] = [
  { who: 'nadia', text: 'Is the flicker the same two board positions as batch 6?' },
  { who: 'rafi', text: 'Positions 14 and 31, same as before.' },
  { who: 'priya', text: 'I can rerun those two with the new firmware tonight.' },
  { who: 'nadia', text: 'Please do, and attach the log to the report.' },
];

const THREAD_LINES: Line[] = [
  { who: 'nadia', agent: true, text: 'Migration in `migrations/0042` plus a 2.3 fixture. Pushed `c9e2f1a`, PR 4431. @rafi @priya' },
  {
    who: 'rafi',
    agent: true,
    text: '212 passing, 1 failing at `c9e2f1a`. Unscheduled device shows blank. @nadia',
    file: { name: 'schedule-empty.png', mime: 'image/png', bytes: 176 * 1024 },
  },
  { who: 'priya', agent: true, text: 'Two findings on 4431. Batch the per-device writes. @nadia' },
  { who: 'omar', agent: true, text: 'Sent to Coder as one note. Rework 1 of 2.' },
  { who: 'nadia', agent: true, text: 'Fixed inherit, batched writes. Pushed `f07b3d9`. @rafi @priya' },
  { who: 'rafi', agent: true, text: '213 passing at `f07b3d9`. Ready.' },
];

/** The bytes of a file of that size that is what its extension claims (a PDF or markdown a card can show as such). */
function bytesOf(file: NonNullable<Line['file']>): Buffer {
  const head =
    file.mime === 'application/pdf'
      ? Buffer.from('%PDF-1.7\n')
      : file.mime === 'image/png'
        ? Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : Buffer.from('# Release notes 2.4\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(0, file.bytes - head.length), 0x20)]);
}

async function post(api: StackApi, channelId: string, line: Line, threadRootId: string | null): Promise<{ id: string; fileId: string | null }> {
  let attachments: string[] | undefined;
  let fileId: string | null = null;
  if (line.file) {
    const res = await api.ctx.post(`/api/channels/${channelId}/files`, {
      headers: { ...(await api.headers()), 'content-type': line.file.mime, 'x-file-name': encodeURIComponent(line.file.name) },
      data: bytesOf(line.file),
    });
    if (res.status() !== 201) throw new Error(`upload ${line.file.name}: ${res.status()} ${await res.text()}`);
    fileId = ((await res.json()) as { id: string }).id;
    attachments = [fileId];
  }
  const sent = await api.post<{ id: string }>(`/api/channels/${channelId}/messages`, { channelId, body: line.text, threadRootId, ...(attachments ? { attachments } : {}) });
  return { id: sent.id, fileId };
}

export interface Story {
  channelId: string;
  rootId: string;
  /** `[data-message-id]` of every message spoken by a prototype bot (their rows are masked). */
  agentRows: string[];
  /** The people's API contexts, to dispose. */
  apis: StackApi[];
}

/** One more thread of plate 2's list: where it lives, its root and its replies, oldest first. `read` leaves it read for Omar. */
interface ExtraThread {
  channel: string;
  root: Line;
  replies: Line[];
  /** Omar has read up to his own reply; the replies after it are unread. Default: everything is read. */
  unreadAfter?: number;
}

/** The other rows of the inbox plate, oldest first (the goal thread of the channel story is the newest). */
const EXTRA_THREADS: ExtraThread[] = [
  {
    channel: 'incidents',
    root: { who: 'rafi', text: 'DNS fallback shipped as 2.3.4 — watching for 24h' },
    replies: [
      { who: 'omar', text: 'Watching the resolver dashboards.' },
      { who: 'nadia', text: 'Error rate flat since the rollout.' },
      { who: 'priya', text: 'No tickets from support about DNS.' },
      { who: 'rafi', text: 'Twelve hours in, still clean.' },
      { who: 'omar', text: 'Good. Keep it open until tomorrow.' },
      { who: 'nadia', text: 'Deploy: 24h clean. Closing.' },
    ],
  },
  {
    channel: 'release-eng',
    root: CHANNEL_LINES[3] as Line,
    replies: [
      { who: 'omar', text: 'Thanks for drafting these.' },
      { who: 'rafi', text: 'Matches. One typo in the DNS paragraph.' },
      { who: 'nadia', text: 'Fixed the typo, notes are final.' },
    ],
  },
  {
    channel: 'router-firmware',
    root: { who: 'rafi', text: 'MT7981 QA batch is done. 48 of 50 boards pass.' },
    replies: [
      { who: 'omar', text: 'Which two failed?' },
      { who: 'nadia', text: 'Is the flicker the same two board positions as batch 6?' },
    ],
    unreadAfter: 1,
  },
  {
    channel: 'alerts',
    root: { who: 'rafi', text: '[P2] resolver latency p95 > 400ms · eu-west' },
    replies: [
      { who: 'omar', text: 'Is this the nightly reindex again?' },
      { who: 'priya', text: 'Known runbook, dev only — fixed, waiting for the alert to clear.' },
      { who: 'nadia', text: 'Confirmed on my side, latency is back under 300ms.' },
    ],
    unreadAfter: 1,
  },
];

export interface StoryOptions {
  /** Also the other threads of plate 2's list (the Threads inbox), with their read state for Omar. */
  inbox?: boolean;
}

/** Creates #release-eng (purpose "Ship coordination") in a "Product" group of Engineering and speaks the plates' lines in it. */
export async function buildStory(playwright: PlaywrightWorkerArgs['playwright'], stack: Stack, options: StoryOptions = {}): Promise<Story> {
  const api: Record<StoryPerson, StackApi> = {
    omar: await apiOn(playwright, stack, 'omar'),
    nadia: await apiOn(playwright, stack, 'nadia'),
    rafi: await apiOn(playwright, stack, 'rafi'),
    priya: await apiOn(playwright, stack, 'priya'),
  };
  const group = await api.omar.post<{ group: { id: string } }>('/api/teams/engineering/channel-groups', { name: 'Product' });
  const make = async (name: string, purpose: string): Promise<string> => {
    const created = await api.omar.post<{ channel: { id: string } }>('/api/teams/engineering/channels', { name, purpose, groupId: group.group.id });
    for (const who of ['nadia', 'rafi', 'priya'] as const) await api[who].post(`/api/channels/${created.channel.id}/join`);
    return created.channel.id;
  };
  const channelId = await make(CHANNEL, 'Ship coordination');
  const agentRows: string[] = [];
  let rootId = '';
  const files: string[] = [];
  const ids = new Map<Line, string>();
  for (const line of CHANNEL_LINES) {
    const sent = await post(api[line.who], channelId, line, null);
    ids.set(line, sent.id);
    if (line.agent) agentRows.push(sent.id);
    if (line === ROOT) rootId = sent.id;
    if (sent.fileId) files.push(sent.fileId);
  }
  // the QA report has a thread of four replies (the plate's "4 replies · last 09:03" beside its card); Omar is not in it
  const qa = CHANNEL_LINES[0] as Line;
  for (const r of QA_REPLIES) await post(api[r.who], channelId, r, ids.get(qa) ?? '');
  // "Linked" in the thread header: the kernel's link table, written by the plugins that own the things (here, as the owner)
  for (const fileId of files) {
    await stack.sql(
      `INSERT INTO app.entity_links (team_id, src_type, src_id, dst_type, dst_id, kind) VALUES ($1, 'message', $2, 'file', $3, 'related') ON CONFLICT DO NOTHING`,
      [TEAM_IDS.Engineering, rootId, fileId],
    );
  }
  if (options.inbox) {
    const channels = await channelsOf(api.omar);
    channels['release-eng'] = channelId;
    channels['router-firmware'] = await make('router-firmware', 'Firmware builds and QA');
    for (const t of EXTRA_THREADS) {
      const where = channels[t.channel];
      if (!where) throw new Error(`story: no channel ${t.channel}`);
      const root = ids.get(t.root) ?? (await post(api[t.root.who], where, t.root, null)).id;
      const sent: string[] = [];
      for (const r of t.replies) sent.push((await post(api[r.who], where, r, root)).id);
      // Omar reads up to his own reply (or to the end); what others said after it stays unread
      const upTo = sent[t.unreadAfter === undefined ? sent.length - 1 : t.unreadAfter - 1];
      if (upTo) await api.omar.post('/api/read-state/mark', { targetType: 'thread', targetId: root, upTo });
    }
  }
  for (const line of THREAD_LINES) {
    const sent = await post(api[line.who], channelId, line, rootId);
    if (line.agent) agentRows.push(sent.id);
  }
  return { channelId, rootId, agentRows, apis: Object.values(api) };
}
