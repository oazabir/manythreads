import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, findSlashCommand, matchSlashCommands, parseSlash, slashMenuContext } from '../src/index.ts';

describe('parseSlash', () => {
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

  it('posts an unknown command, a path and a lone slash as the text typed, never swallowed', () => {
    expect(parseSlash('/xyz do a thing')).toEqual({ kind: 'text', body: '/xyz do a thing' });
    expect(parseSlash('/etc/hosts is wrong')).toEqual({ kind: 'text', body: '/etc/hosts is wrong' });
    expect(parseSlash('/')).toEqual({ kind: 'text', body: '/' });
    expect(parseSlash('/ask-me-later now')).toEqual({ kind: 'text', body: '/ask-me-later now' });
    expect(parseSlash('/shrugged')).toEqual({ kind: 'text', body: '/shrugged' });
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
    expect(parseSlash(long).kind).toBe('text');
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
    expect(findSlashCommand('remind')).toBeUndefined();
  });

  it('matches by the start of the name', () => {
    expect(matchSlashCommands('').length).toBe(SLASH_COMMANDS.length);
    expect(matchSlashCommands('s').map((c) => c.name)).toEqual(['shrug']);
    expect(matchSlashCommands('T').map((c) => c.name)).toEqual(['task']);
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
    expect(slashMenuContext('/ask ', 5)).toMatchObject({ stage: 'bot', query: '', from: 5, to: 5 });
    expect(slashMenuContext('/ask co', 7)).toMatchObject({ stage: 'bot', query: 'co', from: 5, to: 7 });
    expect(slashMenuContext('/ask @co', 8)).toMatchObject({ stage: 'bot', query: 'co', from: 5, to: 8 });
    expect(slashMenuContext('/ask coder how', 14)).toBeNull();
    expect(slashMenuContext('/ask coder how', 8)).toMatchObject({ stage: 'bot', query: 'cod', from: 5, to: 10 });
    expect(slashMenuContext('/ask\ncoder', 10)).toBeNull();
  });
});
