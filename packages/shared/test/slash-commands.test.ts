import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, findSlashCommand, matchSlashCommands, parseSlash, slashMenuContext } from '../src/index.ts';

describe('parseSlash', () => {
  it('reads the new commands with their words', () => {
    expect(parseSlash('/remind me in 20 minutes call the bank')).toMatchObject({ kind: 'command', args: 'me in 20 minutes call the bank' });
    expect(parseSlash('/status 🌴 on holiday')).toMatchObject({ kind: 'command', args: '🌴 on holiday' });
    expect(parseSlash('/DND 2h')).toMatchObject({ kind: 'command', args: '2h' });
    expect(parseSlash('/away')).toMatchObject({ kind: 'command', args: '' });
    expect(parseSlash('/invite @priya')).toMatchObject({ kind: 'command', args: '@priya' });
    expect(parseSlash('/topic Release planning')).toMatchObject({ kind: 'command', args: 'Release planning' });
    // a near miss is an unknown command: refused, never posted as text and never run as the command it resembles
    expect(parseSlash('/reminder me tomorrow x')).toEqual({ kind: 'unknown', name: 'reminder' });
    expect(parseSlash('/muted')).toEqual({ kind: 'unknown', name: 'muted' });
  });

  it('reads a known command at the very start, with its words', () => {
    expect(parseSlash('/ask coder how do I run the tests?')).toMatchObject({ kind: 'command', args: 'coder how do I run the tests?' });
    expect(parseSlash('/task Fix the login redirect')).toMatchObject({ kind: 'command', args: 'Fix the login redirect' });
    expect(parseSlash('/help')).toMatchObject({ kind: 'command', args: '' });
    expect(parseSlash('/SHRUG   well  ')).toMatchObject({ kind: 'command', args: 'well' });
  });

  it('keeps the lines of a multi-line argument', () => {
    const r = parseSlash('/ask coder first line\nsecond line');
    expect(r.kind === 'command' && r.args).toBe('coder first line\nsecond line');
    const bare = parseSlash('/shrug\nmore');
    expect(bare.kind === 'command' && bare.args).toBe('more');
  });

  it('never posts an unknown command as text; a path and a lone slash are still the text typed', () => {
    expect(parseSlash('/xyz do a thing')).toEqual({ kind: 'unknown', name: 'xyz' });
    expect(parseSlash('/xyz')).toEqual({ kind: 'unknown', name: 'xyz' });
    expect(parseSlash('/ask-me-later now')).toEqual({ kind: 'unknown', name: 'ask-me-later' });
    expect(parseSlash('/shrugged')).toEqual({ kind: 'unknown', name: 'shrugged' });
    expect(parseSlash('/etc/hosts is wrong')).toEqual({ kind: 'text', body: '/etc/hosts is wrong' });
    expect(parseSlash('/')).toEqual({ kind: 'text', body: '/' });
    expect(parseSlash('/12 things')).toEqual({ kind: 'text', body: '/12 things' });
  });

  it('is not a command anywhere but the first character', () => {
    expect(parseSlash(' /ask coder hi')).toEqual({ kind: 'text', body: '/ask coder hi' });
    expect(parseSlash('hello /ask coder hi')).toEqual({ kind: 'text', body: 'hello /ask coder hi' });
    expect(parseSlash('```\n/ask coder hi\n```')).toEqual({ kind: 'text', body: '```\n/ask coder hi\n```' });
  });

  it('turns // plus a letter into one literal slash, and leaves comments alone', () => {
    expect(parseSlash('//ask coder hi')).toEqual({ kind: 'text', body: '/ask coder hi' });
    expect(parseSlash('//xyz')).toEqual({ kind: 'text', body: '/xyz' });
    expect(parseSlash('// TODO later')).toEqual({ kind: 'text', body: '// TODO later' });
    expect(parseSlash('//')).toEqual({ kind: 'text', body: '//' });
  });

  it('reads hostile input in linear time', () => {
    const long = `/${'a'.repeat(200_000)}`;
    const t0 = performance.now();
    expect(parseSlash(long).kind).toBe('text'); // a name of 200 000 letters is no command word: ordinary text
    expect(parseSlash(`/ask ${' '.repeat(200_000)}x`).kind).toBe('command');
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('the list', () => {
  it('has unique lowercase names that the lookup finds in any case', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of SLASH_COMMANDS) {
      expect(c.name).toBe(c.name.toLowerCase());
      expect(c.usage.startsWith(`/${c.name}`)).toBe(true);
      expect(findSlashCommand(c.name.toUpperCase())).toBe(c);
    }
    expect(findSlashCommand('nonesuch')).toBeUndefined();
  });

  it('has every built-in command, each from the platform and with a hint of its words', () => {
    expect(SLASH_COMMANDS.map((c) => c.name)).toEqual([
      'ask', 'task', 'remind', 'status', 'dnd', 'away', 'invite', 'leave', 'mute', 'topic', 'me', 'shrug', 'poll', 'help',
    ]);
    for (const c of SLASH_COMMANDS) {
      expect(c.source).toBe('builtin');
      expect(c.summary.length).toBeGreaterThan(10);
      // a command that takes words shows them in its usage line, one that takes none shows only its name
      if (c.args === 'none') expect(c.usage).toBe(`/${c.name}`);
      else expect(c.usage.length).toBeGreaterThan(c.name.length + 1);
    }
  });

  it('says who may run each command, as the registry and nowhere else', () => {
    const needs = Object.fromEntries(SLASH_COMMANDS.map((c) => [c.name, c.needs]));
    expect(needs).toMatchObject({
      invite: 'channel_manager',
      topic: 'channel_manager',
      leave: 'channel_member',
      remind: 'anyone',
      status: 'anyone',
      dnd: 'anyone',
      away: 'anyone',
      mute: 'anyone',
      ask: 'team_member',
      task: 'team_member',
    });
  });

  it('matches by the start of the name', () => {
    expect(matchSlashCommands('').length).toBe(SLASH_COMMANDS.length);
    expect(matchSlashCommands('s').map((c) => c.name)).toEqual(['status', 'shrug']);
    expect(matchSlashCommands('T').map((c) => c.name)).toEqual(['task', 'topic']);
    expect(matchSlashCommands('re').map((c) => c.name)).toEqual(['remind']);
    expect(matchSlashCommands('d').map((c) => c.name)).toEqual(['dnd']);
    expect(matchSlashCommands('zzz')).toEqual([]);
  });
});

describe('slashMenuContext', () => {
  it('opens on a slash at the start of the message, with what follows up to the caret', () => {
    expect(slashMenuContext('/', 1)).toEqual({ stage: 'command', query: '', to: 1 });
    expect(slashMenuContext('/as', 3)).toMatchObject({ stage: 'command', query: 'as', to: 3 });
    // the caret in the middle of the word still replaces the whole word
    expect(slashMenuContext('/ask', 2)).toMatchObject({ stage: 'command', query: 'a', to: 4 });
  });

  it('never opens in the middle of a message, on a later line, or for //', () => {
    expect(slashMenuContext('hello /', 7)).toBeNull();
    expect(slashMenuContext(' /', 2)).toBeNull();
    expect(slashMenuContext('first\n/', 7)).toBeNull();
    expect(slashMenuContext('```\n/', 5)).toBeNull();
    expect(slashMenuContext('//', 2)).toBeNull();
    expect(slashMenuContext('//as', 4)).toBeNull();
    expect(slashMenuContext('plain', 5)).toBeNull();
    expect(slashMenuContext('', 0)).toBeNull();
  });

  it('closes once the command word is finished, except for the bot after /ask', () => {
    expect(slashMenuContext('/shrug ', 7)).toBeNull();
    expect(slashMenuContext('/task fix', 9)).toBeNull();
    expect(slashMenuContext('/remind me in 20 minutes', 24)).toBeNull();
    expect(slashMenuContext('/status ', 8)).toBeNull();
    expect(slashMenuContext('/ask ', 5)).toMatchObject({ stage: 'bot', query: '', from: 5, to: 5 });
    expect(slashMenuContext('/ask co', 7)).toMatchObject({ stage: 'bot', query: 'co', from: 5, to: 7 });
    expect(slashMenuContext('/ask @co', 8)).toMatchObject({ stage: 'bot', query: 'co', from: 5, to: 8 });
    expect(slashMenuContext('/ask coder how', 14)).toBeNull();
    expect(slashMenuContext('/ask coder how', 8)).toMatchObject({ stage: 'bot', query: 'cod', from: 5, to: 10 });
    expect(slashMenuContext('/ask\ncoder', 10)).toBeNull();
  });
});
