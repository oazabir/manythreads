import { describe, expect, it } from 'vitest';
import { asCode, cleanInbound, cleanLabel, cut, outboundLine } from '../src/text.ts';

const chars = (...codes: number[]): string => String.fromCharCode(...codes);

describe('text from a chat app is hostile', () => {
  it('drops control and direction characters, keeps newline and tab', () => {
    const dirty = `a${chars(0x07)}b${chars(0x202e)}c${chars(0x200b)}d${chars(0x2028)}e\tf\ng${chars(0xfeff)}`;
    expect(cleanInbound(dirty)).toBe('abcde\tf\ng');
  });

  it('turns carriage returns into newlines and collapses long runs of them', () => {
    expect(cleanInbound('a\r\nb\rc')).toBe('a\nb\nc');
    expect(cleanInbound('a\n\n\n\n\n\nb')).toBe('a\n\n\nb');
  });

  it('defuses @channel, @here and @everyone in any case', () => {
    for (const word of ['@channel', '@HERE', '@Everyone']) {
      const out = cleanInbound(`hello ${word} now`);
      expect(out).not.toContain(word);
      expect(out.toLowerCase()).not.toMatch(/@(channel|here|everyone)/);
      expect(out.replace(chars(0x2060), '')).toBe(`hello ${word} now`);
    }
  });

  it('removes a lone surrogate and cuts to 4000 characters', () => {
    expect(cleanInbound(`a${chars(0xd800)}b`)).toBe('ab');
    const long = cleanInbound('x'.repeat(9000));
    expect(Array.from(long)).toHaveLength(4000);
    expect(long.endsWith('…')).toBe(true);
  });

  it('answers an empty string for invisible-only text', () => {
    expect(cleanInbound(`${chars(0x200b, 0x202e, 0x07)}   `)).toBe('');
  });

  it('keeps a pair of code points whole when it cuts', () => {
    const face = String.fromCodePoint(0x1f600);
    expect(cut(face.repeat(10), 5)).toBe(`${face.repeat(4)}…`);
  });

  it('makes a label one short line', () => {
    expect(cleanLabel(`Ann\n${chars(0x202e)}Lee\t`)).toBe('Ann Lee');
    expect(Array.from(cleanLabel('y'.repeat(500)))).toHaveLength(120);
  });

  it('shapes the outgoing line as "Name: text" with a fallback name', () => {
    expect(outboundLine('Nadia', 'Release at five')).toBe('Nadia: Release at five');
    expect(outboundLine(`${chars(0x202e)}`, 'x')).toBe('Someone: x');
    expect(Array.from(outboundLine('N', 'z'.repeat(9000)))).toHaveLength(4000);
  });

  it('reads a code only when it is eight digits', () => {
    expect(asCode('12345678')).toBe('12345678');
    expect(asCode(' 1234 5678 ')).toBe('12345678');
    expect(asCode('1234-5678')).toBe('12345678');
    expect(asCode('code: 12345678')).toBe('12345678');
    expect(asCode('1234567')).toBeNull();
    expect(asCode('123456789')).toBeNull();
    expect(asCode('1234567a')).toBeNull();
    expect(asCode('call 12345678 now')).toBeNull();
  });
});
