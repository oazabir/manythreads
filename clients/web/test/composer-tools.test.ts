import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CustomEmoji } from '@manythreads/shared';
import { ComposerToolbar } from '../src/channels/ComposerToolbar';
import {
  TOOL_ORDER, barTools, chordText, isMac, matchBroadcast, matchLocalCommands, moreTools, parseLocalCommand, toolForKey, toolTitle, type LocalCommand,
} from '../src/channels/composerTools';
import { emojiForShortcode } from '../src/channels/emoji';
import { detectEmojiTrigger, suggestEmoji } from '../src/channels/emojiSuggest';

const key = (k: string, o: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({ key: k, ctrlKey: o.ctrl ?? false, metaKey: o.meta ?? false, shiftKey: o.shift ?? false, altKey: o.alt ?? false });

describe('toolbar layouts', () => {
  it('shows every tool in a full row', () => {
    expect(barTools('full', TOOL_ORDER, false)).toEqual([...TOOL_ORDER]);
    expect(moreTools('full', TOOL_ORDER)).toEqual([]);
  });
  it('keeps the common tools in a narrow box and puts the rest under "..."', () => {
    expect(barTools('more', TOOL_ORDER, false)).toEqual(['bold', 'italic', 'code', 'link', 'mention', 'emoji']);
    expect(moreTools('more', TOOL_ORDER)).toEqual(['strike', 'codeblock', 'quote', 'bullet', 'number', 'channel', 'poll']);
    // every tool is in exactly one place
    expect([...barTools('more', TOOL_ORDER, false), ...moreTools('more', TOOL_ORDER)].sort()).toEqual([...TOOL_ORDER].sort());
  });
  it('keeps no poll where there is none', () => {
    const noPoll = TOOL_ORDER.filter((t) => t !== 'poll');
    expect(moreTools('more', noPoll)).not.toContain('poll');
  });
  it('is one Aa button on a phone until it is opened', () => {
    expect(barTools('aa', TOOL_ORDER, false)).toEqual(['mention', 'emoji']);
    expect(barTools('aa', TOOL_ORDER, true)).toEqual([...TOOL_ORDER]);
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
  const draw = (layout: 'full' | 'more' | 'aa', tools = TOOL_ORDER) =>
    renderToStaticMarkup(createElement(ComposerToolbar, { layout, tools, mac: false, onRun: () => undefined, onCodeBlock: () => undefined, emojiOpen: false, emojiRef: createRef<HTMLButtonElement>() }));
  it('draws a labelled toolbar with the shortcut in each tooltip, one tab stop, and the old accessible names', () => {
    const html = draw('full');
    expect(html).toContain('role="toolbar"');
    expect(html).toContain('aria-label="Formatting"');
    expect(html).toContain('title="Bold (Ctrl+B)"');
    expect(html).toContain('title="Link (Ctrl+K)"');
    expect(html).toContain('aria-label="Insert a code block"');
    expect(html).toContain('aria-label="Ask a poll"');
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).not.toContain('composer-more');
  });
  it('puts the rare tools under the "..." button in the thread panel', () => {
    const html = draw('more');
    expect(html).toContain('data-testid="composer-more"');
    expect(html).toContain('aria-label="Bold"');
    expect(html).not.toContain('aria-label="Quote"');
    expect(html).not.toContain('aria-label="Ask a poll"');
  });
  it('draws the Aa button with Mention and Emoji on a phone', () => {
    const html = draw('aa');
    expect(html).toContain('data-testid="composer-format-toggle"');
    expect(html).toContain('aria-label="Emoji"');
    expect(html).toContain('aria-label="Mention a person"');
    expect(html).not.toContain('aria-label="Bold"');
  });
});
