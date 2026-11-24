import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomEmoji } from '@manythreads/shared';
import { ComposerToolbar } from '../src/channels/ComposerToolbar';
import {
  TOOL_ORDER, chordText, isMac, matchBroadcast, matchLocalCommands, parseLocalCommand, sendButtonClass, toolForKey, toolTitle, type LocalCommand,
} from '../src/channels/composerTools';
import { emojiForShortcode } from '../src/channels/emoji';
import { detectEmojiTrigger, suggestEmoji } from '../src/channels/emojiSuggest';

const key = (k: string, o: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ key: k, ctrlKey: o.ctrl ?? false, metaKey: o.meta ?? false, shiftKey: o.shift ?? false, altKey: o.alt ?? false });

describe('one composer (P34-03)', () => {
  it('draws the same bar tools in the same order in every box; the poll is in the Attach menu, not the bar (P36-09)', () => {
    expect(TOOL_ORDER).toEqual(['bold', 'italic', 'strike', 'code', 'codeblock', 'quote', 'bullet', 'number', 'link', 'mention', 'channel', 'emoji']);
  });
  it('draws Send one size with or without text: only the colour class changes', () => {
    const empty = sendButtonClass(false).split(' ');
    const ready = sendButtonClass(true).split(' ');
    expect(empty).toEqual(['btn', 'send']);
    expect(ready).toEqual(expect.arrayContaining(['btn', 'send', 'primary', 'ready']));
    // nothing in either that sets a size
    expect([...empty, ...ready].filter((c) => /^(s|m|l|xs|big|small|icon-btn)$/.test(c))).toEqual([]);
  });
});

describe('shortcuts', () => {
  it('names the key in the tooltip, with the Command mark on a Mac', () => {
    expect(toolTitle('Bold', 'bold', false)).toBe('Bold (Ctrl+B)');
    expect(toolTitle('Link', 'link', false)).toBe('Link (Ctrl+K)');
    expect(toolTitle('Strikethrough', 'strike', true)).toBe('Strikethrough (⌘⇧X)');
    expect(toolTitle('Quote', 'quote', false)).toBe('Quote');
    expect(chordText({ key: 'i' }, true)).toBe('⌘I');
    expect(isMac('MacIntel')).toBe(true);
    expect(isMac('Win32')).toBe(false);
    expect(isMac(undefined)).toBe(false);
  });
  it('runs bold, italic, link and strike from the keys', () => {
    expect(toolForKey(key('b', { ctrl: true }))).toBe('bold');
    expect(toolForKey(key('B', { meta: true }))).toBe('bold');
    expect(toolForKey(key('i', { ctrl: true }))).toBe('italic');
    expect(toolForKey(key('k', { ctrl: true }))).toBe('link');
    expect(toolForKey(key('x', { ctrl: true, shift: true }))).toBe('strike');
  });
  it('leaves every other press alone', () => {
    expect(toolForKey(key('b'))).toBeNull();
    expect(toolForKey(key('b', { ctrl: true, alt: true }))).toBeNull();
    expect(toolForKey(key('k', { ctrl: true, shift: true }))).toBeNull();
    expect(toolForKey(key('x', { ctrl: true }))).toBeNull();
    expect(toolForKey(key('a', { ctrl: true }))).toBeNull();
  });
});

describe('@channel and @here', () => {
  it('offers both for a bare @ and the one that starts with the letters', () => {
    expect(matchBroadcast('').map((o) => o.word)).toEqual(['channel', 'here']);
    expect(matchBroadcast('he').map((o) => o.word)).toEqual(['here']);
    expect(matchBroadcast('ch').map((o) => o.word)).toEqual(['channel']);
    expect(matchBroadcast('zz')).toEqual([]);
  });
});

describe('commands a screen brings', () => {
  const commands: LocalCommand[] = [
    { name: 'new', summary: 'New chat', run: () => undefined },
    { name: 'model', summary: 'Model', run: () => undefined },
  ];
  it('lists the commands while the first word is typed', () => {
    expect(matchLocalCommands(commands, '/').map((c) => c.name)).toEqual(['new', 'model']);
    expect(matchLocalCommands(commands, '/mo').map((c) => c.name)).toEqual(['model']);
    expect(matchLocalCommands(commands, '/model smart')).toEqual([]);
    expect(matchLocalCommands(commands, 'hello /new')).toEqual([]);
  });
  it('runs a finished command with the words after it and posts anything else as typed', () => {
    expect(parseLocalCommand(commands, '/new')?.command.name).toBe('new');
    expect(parseLocalCommand(commands, '/model  smart ')).toMatchObject({ arg: 'smart' });
    expect(parseLocalCommand(commands, '/unknown')).toBeNull();
    expect(parseLocalCommand(commands, 'see /new')).toBeNull();
  });
});

describe('the :emoji: list', () => {
  const custom = (name: string): CustomEmoji => ({ id: `id-${name}` as CustomEmoji['id'], name: name as CustomEmoji['name'], contentType: 'image/png', size: 10, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z' });
  it('opens on a colon that starts a word and two letters', () => {
    expect(detectEmojiTrigger('good :sm', 8)).toEqual({ query: 'sm', start: 5 });
    expect(detectEmojiTrigger(':tada', 5)).toEqual({ query: 'tada', start: 0 });
    expect(detectEmojiTrigger('(:rocket', 8)).toEqual({ query: 'rocket', start: 1 });
    expect(detectEmojiTrigger('line\n:fire', 10)).toEqual({ query: 'fire', start: 5 });
  });
  it('stays shut for one letter, a time, an address, a finished name and a caret that moved on', () => {
    expect(detectEmojiTrigger(':s', 2)).toBeNull();
    expect(detectEmojiTrigger('at 10:30', 8)).toBeNull();
    expect(detectEmojiTrigger('see https://example.com', 23)).toBeNull();
    expect(detectEmojiTrigger(':smile:', 7)).toBeNull();
    expect(detectEmojiTrigger('note:abc', 8)).toBeNull();
    expect(detectEmojiTrigger(':smile there', 12)).toBeNull();
  });
  it('finds built-in emoji by a word of their name, the exact word first', () => {
    const hits = suggestEmoji('rocket', []);
    expect(hits[0]?.char).toBe('🚀');
    expect(hits[0]?.code).toBe('rocket');
    expect(suggestEmoji('thumbsup', [])[0]?.char).toBe('👍');
    expect(suggestEmoji('s', [])).toEqual([]);
    expect(suggestEmoji('smi', []).length).toBeGreaterThan(1);
    expect(suggestEmoji('smi', [], 3)).toHaveLength(3);
    // a name is listed once: the emoji several share the word `smile` show as one line, and it is the one `:smile:` sends
    const codes = suggestEmoji('smi', [], 30).map((h) => h.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(suggestEmoji('smi', [], 30).find((h) => h.code === 'smile')?.char).toBe(emojiForShortcode('smile'));
  });
  it('lists the workspace emoji with the built-in ones and before them on a tie', () => {
    const hits = suggestEmoji('party', [custom('party_parrot'), custom('unrelated')]);
    expect(hits[0]?.custom?.name).toBe('party_parrot');
    expect(hits.some((h) => h.char === '🎉')).toBe(true);
    expect(hits.some((h) => h.custom?.name === 'unrelated')).toBe(false);
  });
  it('shows an emoji once even when two groups hold it', () => {
    const chars = suggestEmoji('heart', []).map((h) => h.char);
    expect(new Set(chars).size).toBe(chars.length);
  });
});

describe('ComposerToolbar', () => {
  const draw = () =>
    renderToStaticMarkup(createElement(ComposerToolbar, { mac: false, onRun: () => undefined, onCodeBlock: () => undefined, emojiOpen: false, emojiRef: createRef<HTMLButtonElement>() }));
  it('draws a labelled toolbar with the shortcut in each tooltip, one tab stop, and the old accessible names', () => {
    const html = draw();
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Formatting"');
    expect(html).toContain('title="Bold (Ctrl+B)"');
    expect(html).toContain('title="Link (Ctrl+K)"');
    expect(html).toContain('aria-label="Insert a code block"');
    expect(html).not.toContain('aria-label="Ask a poll"');
    expect(html).not.toContain('composer-format-toggle');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).not.toContain('composer-more');
    // the twelve tools, in the shared order
    expect([...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]).slice(1)).toEqual(['Bold', 'Italic', 'Strikethrough', 'Code', 'Insert a code block', 'Quote', 'Bulleted list', 'Numbered list', 'Link', 'Mention a person', 'Link a channel', 'Emoji']);
  });
});
