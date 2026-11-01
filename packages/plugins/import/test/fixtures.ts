import { buildZip, type ZipItem } from './zip-builder.ts';

// The fixture exports (PLAN P14-13, and P14-18's seed requirement: a Slack export of 3 channels and 200 messages). Both are made by code, so they are the
// same every time and a test can say exactly what is in them. The committed copies in test/fixtures/ are written by generate-fixtures.ts and compared
// with these in fixtures.test.ts, so a change here cannot go unnoticed.
//
// The people are the seed workspace's own: Omar, Nadia and Rafi are on Engineering, Sameera is on another team, and Jon, a deleted user, a deleted user
// without an email and a bot exist only in the archive. Dates are in March 2024.

const DAY = 86_400;
const BASE = Date.UTC(2024, 2, 4, 9, 0, 0) / 1000;

const USERS = [
  { id: 'U01OMAR', name: 'omar', real_name: 'Omar', profile: { email: 'omar@kahf.example', real_name: 'Omar' } },
  { id: 'U02NADIA', name: 'nadia', real_name: 'Nadia', profile: { email: 'nadia@kahf.example', real_name: 'Nadia' } },
  { id: 'U03RAFI', name: 'rafi', real_name: 'Rafi', profile: { email: 'rafi@kahf.example', real_name: 'Rafi' } },
  { id: 'U04SAM', name: 'sameera', real_name: 'Sameera', profile: { email: 'sameera@kahf.example', real_name: 'Sameera' } },
  { id: 'U05JON', name: 'jon', real_name: 'Jon Outside', profile: { email: 'jon@outside.example', real_name: 'Jon Outside' } },
  { id: 'U06GHOST', name: 'ghost', real_name: 'Gone Away', deleted: true, profile: { real_name: 'Gone Away' } },
  { id: 'U07BOT', name: 'deploybot', real_name: 'Deploy Bot', is_bot: true, profile: { real_name: 'Deploy Bot' } },
];
const HUMANS = ['U01OMAR', 'U02NADIA', 'U03RAFI', 'U04SAM', 'U05JON', 'U06GHOST'];

type SlackMessage = Record<string, unknown>;
const tsOf = (seconds: number, n: number): string => `${Math.floor(seconds)}.${String(n).padStart(6, '0')}`;

/** `count` messages of one channel: every tenth starts a thread of three replies, and the rest are plain; `special` places the odd ones. */
function channelMessages(channelId: string, count: number, channelIndex: number, special: Record<number, (ts: string, i: number) => SlackMessage>): SlackMessage[] {
  const out: SlackMessage[] = [];
  let i = 0;
  let root: string | null = null;
  let repliesLeft = 0;
  while (out.length < count) {
    const ts = tsOf(BASE + Math.floor(i / 4) * DAY + (i % 4) * 3600 + channelIndex * 60, i + 1);
    const user = HUMANS[(i + channelIndex) % HUMANS.length]!;
    const make = special[out.length];
    if (make) {
      out.push(make(ts, i));
    } else if (repliesLeft > 0 && root) {
      out.push({ type: 'message', user, text: `Reply ${3 - repliesLeft + 1} to the thread (${channelId})`, ts, thread_ts: root });
      repliesLeft -= 1;
    } else if (out.length % 10 === 0 && out.length + 4 <= count) {
      root = ts;
      repliesLeft = 3;
      out.push({ type: 'message', user, text: `Thread starter number ${out.length} in ${channelId}`, ts, thread_ts: ts, reply_count: 3 });
    } else {
      out.push({ type: 'message', user, text: `Message ${out.length} in ${channelId}: shipping notes & plans`, ts });
    }
    i += 1;
  }
  return out;
}

const byDay = (messages: SlackMessage[]): Map<string, SlackMessage[]> => {
  const days = new Map<string, SlackMessage[]>();
  for (const m of messages) {
    const day = new Date(Number(String(m['ts']).split('.')[0]) * 1000).toISOString().slice(0, 10);
    const list = days.get(day) ?? [];
    list.push(m);
    days.set(day, list);
  }
  return days;
};

export interface SlackFixtureOptions {
  /** Messages per channel: general, eng-random, leadership. Default 90, 60 and 50 (200 in all). */
  counts?: [number, number, number];
}

/** The Slack export as zip entries. */
export function slackEntries(options: SlackFixtureOptions = {}): ZipItem[] {
  const [general, random, lead] = options.counts ?? [90, 60, 50];
  const json = (v: unknown): string => JSON.stringify(v, null, 2);
  const reaction = (name: string, users: string[]) => ({ name, users, count: users.length });
  const generalMessages = channelMessages('general', general, 0, {
    1: (ts) => ({ type: 'message', user: 'U01OMAR', text: 'Welcome <@U02NADIA>! Read <https://example.com/doc|the doc> first & then <#C02RND|eng-random>. <!here>', ts }),
    2: (ts) => ({
      type: 'message', subtype: 'file_share', user: 'U03RAFI', text: 'Here is the plan', ts,
      files: [{ id: 'F01PLAN', name: 'plan.pdf', filetype: 'pdf', size: 1024, url_private: 'https://files.slack.com/files-pri/T0-F01PLAN/plan.pdf' }],
    }),
    3: (ts) => ({ type: 'message', subtype: 'bot_message', bot_id: 'B01', username: 'deploybot', text: 'Deployed build 41', ts }),
    4: (ts) => ({ type: 'message', subtype: 'channel_join', user: 'U02NADIA', text: '<@U02NADIA> has joined the channel', ts }),
    5: (ts) => ({ type: 'message', subtype: 'huddle_thread', user: 'U01OMAR', text: '', room: { id: 'R01' }, ts }),
    6: (ts) => ({ type: 'message', user: 'U01OMAR', text: '', files: [{ id: 'F02CANVAS', name: 'Notes', filetype: 'canvas' }], ts }),
    7: (ts) => ({ type: 'message', user: 'U05JON', text: 'A reply whose first message is not in the export', ts, thread_ts: '1600000000.000100' }),
    8: (ts) => ({
      type: 'message', user: 'U02NADIA', text: 'Great news', ts,
      reactions: [reaction('+1', ['U01OMAR', 'U03RAFI']), reaction('tada', ['U05JON', 'U06GHOST']), reaction('thumbsup::skin-tone-3', ['U02NADIA'])],
    }),
    9: (ts) => ({ type: 'message', user: 'U07BOT', text: 'Build bot says hello', ts }),
  });
  const randomMessages = channelMessages('eng-random', random, 1, {
    2: (ts) => ({ type: 'message', user: 'U03RAFI', text: 'Look at this', ts, reactions: [reaction('eyes', ['U01OMAR'])] }),
  });
  const leadMessages = channelMessages('leadership', lead, 2, {});
  const dmOmarNadia = channelMessages('D01OMARNADIA', 8, 3, {}).map((m, i) => ({ ...m, user: i % 2 === 0 ? 'U01OMAR' : 'U02NADIA' }));
  const dmOmarJon = channelMessages('D02OMARJON', 5, 4, {}).map((m, i) => ({ ...m, user: i % 2 === 0 ? 'U01OMAR' : 'U05JON' }));
  const items: ZipItem[] = [
    { name: 'users.json', data: json(USERS) },
    { name: 'channels.json', data: json([
      { id: 'C01GEN', name: 'general', created: 1709000000, is_general: true, members: ['U01OMAR', 'U02NADIA', 'U03RAFI'], purpose: { value: 'Company-wide announcements' } },
      { id: 'C02RND', name: 'eng-random', created: 1709000100, members: ['U01OMAR', 'U03RAFI'], purpose: { value: 'Anything goes' } },
    ]) },
    { name: 'groups.json', data: json([{ id: 'G01LEAD', name: 'leadership', created: 1709000200, members: ['U01OMAR', 'U02NADIA', 'U05JON'], purpose: { value: 'Leads only' } }]) },
    { name: 'mpims.json', data: '[]' },
    { name: 'dms.json', data: json([{ id: 'D01OMARNADIA', members: ['U01OMAR', 'U02NADIA'] }, { id: 'D02OMARJON', members: ['U01OMAR', 'U05JON'] }]) },
  ];
  const add = (dir: string, messages: SlackMessage[]): void => {
    for (const [day, list] of byDay(messages)) items.push({ name: `${dir}/${day}.json`, data: json(list) });
  };
  add('general', generalMessages);
  add('eng-random', randomMessages);
  add('leadership', leadMessages);
  add('D01OMARNADIA', dmOmarNadia);
  add('D02OMARJON', dmOmarJon);
  return items;
}

export const slackExport = (options?: SlackFixtureOptions): Buffer => buildZip(slackEntries(options));

/** What the Slack fixture holds, by construction (see `slackEntries`). */
export const SLACK_EXPECTED = {
  people: 6, // seven users, one of them a bot
  matched: 4,
  placeholders: 2,
  withoutEmail: 1,
  matchedNotOnTeam: 1, // Sameera
  channels: 5, // general, eng-random, leadership, two direct conversations
  /** Messages that reach the engine: 200 in the three channels less the canvas-only one, and 13 in the two direct conversations. */
  messages: 199 + 13,
  appMessages: 2, // a bot_message and a message from the bot user
  systemMessages: 1,
  huddles: 1,
  canvases: 1,
  orphanReplies: 1,
} as const;

/** The Mattermost export as JSON lines. */
export function mattermostExport(): string {
  const lines: unknown[] = [{ type: 'version', version: 1 }];
  const user = (username: string, email: string, channels: string[]) => ({
    type: 'user',
    user: { username, email, first_name: username[0]!.toUpperCase() + username.slice(1), last_name: '', teams: [{ name: 'acme', channels: channels.map((name) => ({ name })) }] },
  });
  lines.push({ type: 'team', team: { name: 'acme', display_name: 'Acme' } });
  lines.push({ type: 'channel', channel: { team: 'acme', name: 'town-square', display_name: 'Town Square', type: 'O', purpose: 'Everything' } });
  lines.push({ type: 'channel', channel: { team: 'acme', name: 'ops-private', display_name: 'Ops Private', type: 'P', purpose: 'Operations' } });
  lines.push(user('omar', 'omar@kahf.example', ['town-square', 'ops-private']));
  lines.push(user('nadia', 'nadia@kahf.example', ['town-square', 'ops-private']));
  lines.push(user('rafi', 'rafi@kahf.example', ['town-square']));
  lines.push(user('jon', 'jon@outside.example', ['town-square', 'ops-private']));
  lines.push({ type: 'direct_channel', direct_channel: { members: ['omar', 'nadia'] } });
  const at = Date.UTC(2024, 2, 5, 10, 0, 0);
  const people = ['omar', 'nadia', 'rafi', 'jon'];
  for (let i = 0; i < 30; i += 1) {
    const post: Record<string, unknown> = {
      team: 'acme',
      channel: 'town-square',
      user: people[i % people.length],
      message: `Town square message ${i} with @omar mentioned`,
      create_at: at + i * 60_000,
    };
    if (i % 5 === 0) post['replies'] = [1, 2].map((n) => ({ user: people[(i + n) % people.length], message: `Reply ${n} to ${i}`, create_at: at + i * 60_000 + n * 1000 }));
    if (i % 7 === 0) post['reactions'] = [{ user: 'nadia', emoji_name: 'thumbsup', create_at: at }, { user: 'jon', emoji_name: 'tada', create_at: at }];
    if (i === 3) post['attachments'] = [{ path: 'data/ab/plan.pdf' }];
    lines.push({ type: 'post', post });
  }
  for (let i = 0; i < 6; i += 1) {
    lines.push({ type: 'post', post: { team: 'acme', channel: 'ops-private', user: i % 2 ? 'omar' : 'nadia', message: `Ops note ${i}`, create_at: at + i * 90_000 } });
  }
  for (let i = 0; i < 4; i += 1) {
    lines.push({ type: 'direct_post', direct_post: { channel_members: ['omar', 'nadia'], user: i % 2 ? 'omar' : 'nadia', message: `Direct note ${i}`, create_at: at + i * 45_000 } });
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** What the Mattermost fixture holds: 30 root posts and their replies (6 roots have 2), 6 private-channel posts and 4 direct posts. */
export const MATTERMOST_EXPECTED = { people: 4, matched: 3, placeholders: 1, channels: 3, messages: 30 + 12 + 6 + 4 } as const;
