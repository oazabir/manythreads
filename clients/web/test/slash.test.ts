import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, findSlashCommand } from '@manythreads/shared';
import { SHRUG, availability, commandChoices, planSlash, taskFailureText, type SlashWho } from '../src/channels/slash';

const member: SlashWho = {
  guest: false,
  teamMember: true,
  teamArchived: false,
  bots: [
    { slug: 'coder', name: 'Coder' },
    { slug: 'release-bot', name: 'Release Bot' },
  ],
  selfName: 'Omar',
};
const guest: SlashWho = { ...member, guest: true, teamMember: false, bots: null };

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
  it('posts ordinary text as typed, including an unknown command and the // escape', () => {
    expect(planSlash('hello', member)).toEqual({ do: 'post', body: 'hello' });
    expect(planSlash('/xyz keep me', member)).toEqual({ do: 'post', body: '/xyz keep me' });
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
