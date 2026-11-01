import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, findSlashCommand } from '@manythreads/shared';
import {
  NO_MANAGE,
  NO_REMINDER_AS_GUEST,
  SHRUG,
  WHERE_LOADING,
  availability,
  commandChoices,
  findPerson,
  isActionPlan,
  planSlash,
  taskFailureText,
  unknownCommandText,
  type SlashEnv,
  type SlashWho,
} from '../src/channels/slash';

const CHANNEL = '11111111-1111-4111-8111-111111111111';
const DEV = '22222222-2222-4222-8222-222222222222';
const RAFI = '33333333-3333-4333-8333-333333333333';
const OMAR = '44444444-4444-4444-8444-444444444444';
const RAFI2 = '55555555-5555-4555-8555-555555555555';

const member: SlashWho = {
  guest: false,
  teamMember: true,
  teamArchived: false,
  bots: [
    { slug: 'coder', name: 'Coder' },
    { slug: 'release-bot', name: 'Release Bot' },
  ],
  selfName: 'Omar',
  where: { channelId: CHANNEL, kind: 'channel', isMember: true, canManage: true },
};
const guest: SlashWho = { ...member, guest: true, teamMember: false, bots: null };
// Monday 2 November 2026, 10:00 in UTC
const env: SlashEnv = {
  now: new Date('2026-11-02T10:00:00Z'),
  timeZone: 'UTC',
  people: [
    { personId: RAFI, name: 'Rafi Khan', handle: 'rafi' },
    { personId: OMAR, name: 'Omar Said', handle: 'omar' },
  ],
  channels: [{ id: DEV, name: 'dev' }],
  selfPersonId: OMAR,
};

describe('who may run a command', () => {
  it('lets a team member run every command', () => {
    for (const { availability: a } of commandChoices(member)) expect(a).toEqual({ ok: true });
  });

  it('shows /ask and /task disabled to a guest with a plain reason, and keeps the rest', () => {
    expect(availability(findSlashCommand('task')!, guest)).toEqual({ ok: false, reason: 'Guests cannot create cards.' });
    expect(availability(findSlashCommand('ask')!, guest)).toEqual({ ok: false, reason: 'Guests cannot ask bots with a command.' });
    for (const name of ['me', 'shrug', 'help']) expect(availability(findSlashCommand(name)!, guest)).toEqual({ ok: true });
    expect(commandChoices(guest)).toHaveLength(SLASH_COMMANDS.length);
  });

  it('keeps /remind from a guest, and lists every command with a hint for its words', () => {
    expect(availability(findSlashCommand('remind')!, guest)).toEqual({ ok: false, reason: NO_REMINDER_AS_GUEST });
    for (const c of SLASH_COMMANDS) expect(c.usage.startsWith(`/${c.name}`)).toBe(true);
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual(
      expect.arrayContaining(['remind', 'status', 'dnd', 'away', 'invite', 'leave', 'mute', 'topic', 'me', 'shrug', 'ask', 'task', 'poll', 'help']),
    );
  });

  it('needs the conversation for /invite, /leave and /topic, and says why not when it is a direct message or the person is not a lead', () => {
    const invite = findSlashCommand('invite')!;
    const leave = findSlashCommand('leave')!;
    const topic = findSlashCommand('topic')!;
    const loading = { ...member, where: null };
    for (const c of [invite, leave, topic]) expect(availability(c, loading)).toEqual({ ok: false, reason: WHERE_LOADING });
    const plain = { ...member, where: { channelId: CHANNEL, kind: 'channel' as const, isMember: true, canManage: false } };
    expect(availability(invite, plain)).toEqual({ ok: false, reason: NO_MANAGE });
    expect(availability(topic, plain)).toEqual({ ok: false, reason: NO_MANAGE });
    expect(availability(leave, plain)).toEqual({ ok: true });
    const dm = { ...member, where: { channelId: CHANNEL, kind: 'dm' as const, isMember: true, canManage: true } };
    expect(availability(leave, dm)).toMatchObject({ ok: false, reason: expect.stringContaining('direct message') });
    expect(availability(topic, dm)).toMatchObject({ ok: false, reason: expect.stringContaining('direct message') });
    const outside = { ...member, where: { channelId: CHANNEL, kind: 'channel' as const, isMember: false, canManage: true } };
    expect(availability(leave, outside)).toMatchObject({ ok: false, reason: expect.stringContaining('not a member') });
  });

  it('refuses a person outside the team, an archived team, and /ask in a team with no bots', () => {
    const outsider: SlashWho = { ...member, teamMember: false };
    expect(availability(findSlashCommand('task')!, outsider)).toMatchObject({ ok: false, reason: 'Only members of this team can create cards.' });
    expect(availability(findSlashCommand('ask')!, outsider)).toMatchObject({ ok: false });
    expect(availability(findSlashCommand('task')!, { ...member, teamArchived: true })).toMatchObject({ ok: false, reason: expect.stringContaining('archived') });
    expect(availability(findSlashCommand('ask')!, { ...member, bots: [] })).toMatchObject({ ok: false, reason: 'This team has no bots that can answer yet.' });
    // the list still loading is not "no bots"
    expect(availability(findSlashCommand('ask')!, { ...member, bots: null })).toEqual({ ok: true });
  });
});

describe('planSlash', () => {
  it('posts ordinary text as typed, including the // escape and paths; a command-shaped unknown word is refused, never posted', () => {
    expect(planSlash('hello', member)).toEqual({ do: 'post', body: 'hello' });
    expect(planSlash('/xyz keep me', member)).toEqual({ do: 'say', message: unknownCommandText('xyz') });
    expect(unknownCommandText('xyz')).toContain('//xyz');
    expect(planSlash('/etc/hosts is wrong', member)).toEqual({ do: 'post', body: '/etc/hosts is wrong' });
    expect(planSlash('//xyz keep me', member)).toEqual({ do: 'post', body: '/xyz keep me' });
    expect(planSlash('//ask coder hi', member)).toEqual({ do: 'post', body: '/ask coder hi' });
    expect(planSlash('see /ask in the docs', member)).toEqual({ do: 'post', body: 'see /ask in the docs' });
  });

  it('turns /ask into a message that mentions the bot', () => {
    expect(planSlash('/ask coder how do I run the tests?', member)).toEqual({ do: 'post', body: '@coder how do I run the tests?' });
    expect(planSlash('/ask @Coder two\nlines', member)).toEqual({ do: 'post', body: '@coder two\nlines' });
    expect(planSlash('/ask Release-Bot ship it?', member)).toEqual({ do: 'post', body: '@release-bot ship it?' });
  });

  it('explains a /ask that cannot go out and keeps the text', () => {
    expect(planSlash('/ask', member)).toMatchObject({ do: 'say', message: expect.stringContaining('which bot') });
    expect(planSlash('/ask coder', member)).toMatchObject({ do: 'say', message: expect.stringContaining('/ask coder how do I run the tests?') });
    expect(planSlash('/ask nobody hi', member)).toEqual({ do: 'say', message: 'There is no bot called “nobody” in this team. Bots here: coder, release-bot.' });
    expect(planSlash('/ask coder hi', { ...member, bots: null })).toMatchObject({ do: 'say', message: expect.stringContaining('not ready yet') });
    expect(planSlash('/ask coder hi', guest)).toEqual({ do: 'say', message: 'Guests cannot ask bots with a command.' });
  });

  it('plans /task with a one-line title, and refuses an empty, long or guest one', () => {
    expect(planSlash('/task Fix the login redirect', member)).toEqual({ do: 'task', title: 'Fix the login redirect' });
    expect(planSlash('/task a\nb', member)).toEqual({ do: 'task', title: 'a b' });
    expect(planSlash('/task', member)).toMatchObject({ do: 'say', message: expect.stringContaining('title') });
    expect(planSlash(`/task ${'x'.repeat(201)}`, member)).toMatchObject({ do: 'say', message: expect.stringContaining('at most 200') });
    expect(planSlash('/task Fix it', guest)).toEqual({ do: 'say', message: 'Guests cannot create cards.' });
    expect(planSlash('/task Fix it', member, true)).toMatchObject({ do: 'say', message: expect.stringContaining('attached files') });
  });

  it('builds /shrug, /me and /help', () => {
    expect(planSlash('/shrug', member)).toEqual({ do: 'post', body: SHRUG });
    expect(planSlash('/shrug no idea', member)).toEqual({ do: 'post', body: `no idea ${SHRUG}` });
    expect(planSlash('/me is at lunch', member)).toEqual({ do: 'post', body: '*Omar is at lunch*' });
    expect(planSlash('/me is at lunch', { ...member, selfName: null })).toEqual({ do: 'post', body: '*is at lunch*' });
    expect(planSlash('/me', member)).toMatchObject({ do: 'say' });
    expect(planSlash('/help', guest)).toEqual({ do: 'help' });
    // words after /help are never thrown away: nothing opens, nothing is cleared
    expect(planSlash('/help me with the build', member)).toMatchObject({ do: 'say' });
    // files stay with a /shrug message
    expect(planSlash('/shrug', member, true)).toEqual({ do: 'post', body: SHRUG });
  });

  it('writes the shrug face so the message renderer draws it whole', () => {
    expect(SHRUG).toBe('¯\\\\\\_(ツ)\\_/¯');
  });
});

describe('planSlash: /remind', () => {
  const plan = (t: string, who: SlashWho = member) => planSlash(t, who, false, env);

  it('plans a reminder for the person themself against the page clock and zone', () => {
    expect(plan('/remind me in 20 minutes call the bank')).toEqual({
      do: 'remind',
      target: { kind: 'me' },
      text: 'call the bank',
      remindAt: '2026-11-02T10:20:00.000Z',
      to: 'you',
    });
    expect(plan('/remind me tomorrow at 9 send the report')).toMatchObject({ do: 'remind', remindAt: '2026-11-03T09:00:00.000Z', text: 'send the report' });
    expect(plan('/remind me on 2026-12-01 at 10:00 renew')).toMatchObject({ do: 'remind', remindAt: '2026-12-01T10:00:00.000Z' });
  });

  it('works in the zone of the person', () => {
    const tokyo: SlashEnv = { ...env, timeZone: 'Asia/Tokyo' };
    expect(planSlash('/remind me tomorrow at 9am stand-up', member, false, tokyo)).toMatchObject({ do: 'remind', remindAt: '2026-11-03T00:00:00.000Z' });
  });

  it('plans a reminder for a channel by its name, and refuses a channel the person cannot see', () => {
    expect(plan('/remind #dev in 1h deploy window')).toEqual({
      do: 'remind',
      target: { kind: 'channel', channelId: DEV },
      text: 'deploy window',
      remindAt: '2026-11-02T11:00:00.000Z',
      to: '#dev',
    });
    expect(plan('/remind #nowhere in 1h hello')).toMatchObject({ do: 'say', message: expect.stringContaining('#nowhere') });
  });

  it('plans a reminder for a person, naming the conversation they are asked in', () => {
    expect(plan('/remind @rafi tomorrow review the plan')).toEqual({
      do: 'remind',
      target: { kind: 'person', personId: RAFI, channelId: CHANNEL },
      text: 'review the plan',
      remindAt: '2026-11-03T09:00:00.000Z',
      to: 'Rafi Khan',
    });
    expect(plan('/remind @nobody tomorrow x')).toMatchObject({ do: 'say', message: expect.stringContaining('@nobody') });
    expect(plan('/remind @omar tomorrow x')).toMatchObject({ do: 'say', message: expect.stringContaining('/remind me') });
    expect(plan('/remind @rafi tomorrow x', { ...member, where: null })).toEqual({ do: 'say', message: WHERE_LOADING });
  });

  it('shows the list for /remind list, and explains an unreadable or past time instead of guessing', () => {
    expect(plan('/remind list')).toEqual({ do: 'remind-list' });
    expect(plan('/remind')).toEqual({ do: 'remind-list' });
    expect(plan('/remind me whenever do it')).toMatchObject({ do: 'say' });
    expect(plan('/remind me on 2026-10-01 at 9:00 thing')).toMatchObject({ do: 'say' });
    expect(plan('/remind me in 20 minutes')).toMatchObject({ do: 'say' });
    expect(plan('/remind me in 5 minutes x', guest)).toEqual({ do: 'say', message: NO_REMINDER_AS_GUEST });
  });

  it('classifies the plans that change something through another plugin', () => {
    expect(isActionPlan(plan('/remind me in 5 minutes x'))).toBe(true);
    expect(isActionPlan(plan('/remind list'))).toBe(false);
    expect(isActionPlan(plan('hello'))).toBe(false);
    expect(isActionPlan(plan('/shrug'))).toBe(false);
  });

  it('finds a person by handle or by name with hyphens, and reports an ambiguous name', () => {
    const people = [...env.people, { personId: RAFI2, name: 'Rafi Ahmed', handle: 'rafi-ahmed' }];
    expect(findPerson('@Rafi-Ahmed', people)).toMatchObject({ personId: RAFI2 });
    expect(findPerson('omar-said', people)).toMatchObject({ personId: OMAR });
    expect(findPerson('nobody', people)).toBe('unknown');
    expect(findPerson('rafi', [...people, { personId: OMAR, name: 'Rafi', handle: 'other' }])).toBe('ambiguous');
  });
});

describe('planSlash: status, dnd, away, invite, leave, mute, topic', () => {
  const plan = (t: string, who: SlashWho = member) => planSlash(t, who, false, env);

  it('plans /status with and without an emoji, and /status clear', () => {
    expect(plan('/status in a meeting')).toEqual({ do: 'status', emoji: null, text: 'in a meeting' });
    expect(plan('/status 🌴 on holiday')).toEqual({ do: 'status', emoji: '🌴', text: 'on holiday' });
    expect(plan('/status clear')).toEqual({ do: 'status-clear' });
    // a leading :shortcode: becomes the emoji (P14-02 follow-up); the rest stays text
    expect(plan('/status :coffee: on a break')).toEqual({ do: 'status', emoji: '☕', text: 'on a break' });
    expect(plan('/status :palm_tree:')).toEqual({ do: 'status', emoji: '🌴', text: '' });
    expect(plan('/status :nosuchemoji: hello')).toEqual({ do: 'status', emoji: null, text: ':nosuchemoji: hello' });
    expect(plan('/status in :coffee: land')).toEqual({ do: 'status', emoji: null, text: 'in :coffee: land' });
    expect(plan('/status 🌴 :coffee: x')).toEqual({ do: 'status', emoji: '🌴', text: ':coffee: x' });
    expect(plan('/status')).toMatchObject({ do: 'say', message: expect.stringContaining('/status') });
    expect(plan('/status hi', guest)).toEqual({ do: 'status', emoji: null, text: 'hi' });
  });

  it('plans /dnd with a length or off, and explains a bad length', () => {
    expect(plan('/dnd 2h')).toEqual({ do: 'dnd', minutes: 120 });
    expect(plan('/dnd 30m')).toEqual({ do: 'dnd', minutes: 30 });
    expect(plan('/dnd off')).toEqual({ do: 'dnd', minutes: null });
    expect(plan('/dnd')).toMatchObject({ do: 'say' });
    expect(plan('/dnd soon')).toMatchObject({ do: 'say' });
    expect(plan('/dnd 30d')).toMatchObject({ do: 'say', message: expect.stringContaining('7 days') });
  });

  it('plans /away only when typed alone', () => {
    expect(plan('/away')).toEqual({ do: 'away' });
    expect(plan('/away at lunch')).toMatchObject({ do: 'say', message: expect.stringContaining('//away') });
  });

  it('plans /invite from the roster, and refuses unknown people, yourself, and a plain member', () => {
    expect(plan('/invite @rafi')).toEqual({ do: 'invite', personId: RAFI, name: 'Rafi Khan' });
    expect(plan('/invite rafi')).toEqual({ do: 'invite', personId: RAFI, name: 'Rafi Khan' });
    expect(plan('/invite @nobody')).toMatchObject({ do: 'say', message: expect.stringContaining('@nobody') });
    expect(plan('/invite @omar')).toEqual({ do: 'say', message: 'You are already here.' });
    expect(plan('/invite')).toMatchObject({ do: 'say' });
    expect(plan('/invite @rafi @omar')).toMatchObject({ do: 'say' });
    expect(plan('/invite @rafi', { ...member, where: { channelId: CHANNEL, kind: 'channel', isMember: true, canManage: false } })).toEqual({ do: 'say', message: NO_MANAGE });
  });

  it('plans /leave, /mute and /topic', () => {
    expect(plan('/leave')).toEqual({ do: 'leave' });
    expect(plan('/leave now')).toMatchObject({ do: 'say', message: expect.stringContaining('//leave') });
    expect(plan('/leave', { ...member, where: { channelId: CHANNEL, kind: 'dm', isMember: true, canManage: false } })).toMatchObject({ do: 'say' });
    expect(plan('/mute')).toEqual({ do: 'mute', on: true });
    expect(plan('/mute off')).toEqual({ do: 'mute', on: false });
    expect(plan('/mute 1h')).toMatchObject({ do: 'say', message: expect.stringContaining('not available yet') });
    expect(plan('/mute', { ...member, where: null })).toEqual({ do: 'say', message: WHERE_LOADING });
    expect(plan('/topic Release planning')).toEqual({ do: 'topic', text: 'Release planning' });
    expect(plan('/topic clear')).toEqual({ do: 'topic', text: '' });
    expect(plan('/topic')).toMatchObject({ do: 'say' });
    expect(plan(`/topic ${'x'.repeat(251)}`)).toMatchObject({ do: 'say', message: expect.stringContaining('250') });
  });

  it('refuses attached files for a command that does not post a message', () => {
    for (const t of ['/remind me in 5 minutes x', '/status hi', '/dnd 1h', '/away', '/invite @rafi', '/leave', '/mute', '/topic hi']) {
      expect(planSlash(t, member, true, env)).toMatchObject({ do: 'say', message: expect.stringContaining('attached files') });
    }
    expect(planSlash('/shrug', member, true, env)).toEqual({ do: 'post', body: SHRUG });
  });
});

describe('taskFailureText', () => {
  it('answers a closed set of failures in a sentence', () => {
    expect(taskFailureText(403, 'x')).toBe('You are not allowed to create cards in this team.');
    expect(taskFailureText(404, 'x')).toContain('could not be found');
    expect(taskFailureText(429, undefined)).toContain('Too many');
    expect(taskFailureText(409, 'The board is full.')).toBe('The board is full.');
    expect(taskFailureText(500, 'boom')).toBe('The card could not be created just now. Try again in a moment.');
    expect(taskFailureText(undefined, undefined)).toContain('could not be created');
  });
});
