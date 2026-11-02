import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AVATAR_PRESETS, Avatar, OFFERED_AVATAR_PRESETS, avatarLabel, avatarSrc } from '@manythreads/shared';
import { creditLine } from '../src/avatars/credit';
import { squareBox } from '../src/avatars/photo';
import { initialsOf } from '../src/components/ui';

// P14-23: the initials drawn when there is no picture, the address of a picture, and the square a photo is cut to.

describe('initials (no avatar, no photo)', () => {
  it('two or more words: the first and the last initial; one word: its first two letters', () => {
    expect(initialsOf('Omar Al Zabir')).toBe('OZ');
    expect(initialsOf('Brain')).toBe('BR');
    expect(initialsOf('  nadia   khan ')).toBe('NK');
    expect(initialsOf('x')).toBe('X');
    expect(initialsOf('')).toBe('');
  });
});

describe('where a picture is loaded from', () => {
  it('a built-in picture is a file of the web app; a photo is the person\'s photo route with its hash', () => {
    expect(avatarSrc('preset:hijab-30-formal')).toBe('/avatars/hijab-30-formal.svg');
    expect(avatarSrc('preset:bot-noto-t-rex')).toBe('/avatars/bot-noto-t-rex.svg');
    // a picture of the first library keeps drawing from its WebP file
    expect(avatarSrc('preset:woman-3')).toBe('/avatars/woman-3.webp');
    expect(avatarSrc('photo:0123456789abcdef', '0192a3b4-0000-7000-8000-000000000001')).toBe('/api/people/0192a3b4-0000-7000-8000-000000000001/avatar?v=0123456789abcdef');
  });

  it('nothing, an unknown picture or a photo without a person gives no address (so the initials are drawn)', () => {
    expect(avatarSrc(null)).toBeNull();
    expect(avatarSrc(undefined)).toBeNull();
    expect(avatarSrc('preset:does-not-exist')).toBeNull();
    expect(avatarSrc('photo:0123456789abcdef')).toBeNull();
    expect(avatarSrc('something else')).toBeNull();
  });

  it('every id in the catalogue is a valid stored value, has a label and a picture address', () => {
    for (const p of AVATAR_PRESETS) {
      expect(Avatar.safeParse(`preset:${p.id}`).success, p.id).toBe(true);
      expect(avatarLabel(`preset:${p.id}`)).toBe(p.label);
      expect(avatarSrc(`preset:${p.id}`)).toBe(`/avatars/${p.id}.${p.retired ? 'webp' : 'svg'}`);
    }
    expect(avatarLabel('photo:0123456789abcdef')).toBe('Profile photo');
    expect(avatarLabel(null)).toBeNull();
  });

  it('refuses a stored value that is neither shape', () => {
    for (const bad of ['', 'preset:', 'preset:UPPER', 'photo:xyz', 'photo:0123456789abcdeg', 'http://example.com/x.png', 'preset:a/b']) expect(Avatar.safeParse(bad).success, bad).toBe(false);
  });
});

describe('the square a photo is cut to', () => {
  it('is the largest centred square', () => {
    expect(squareBox(800, 600)).toEqual({ sx: 100, sy: 0, size: 600 });
    expect(squareBox(600, 800)).toEqual({ sx: 0, sy: 100, size: 600 });
    expect(squareBox(512, 512)).toEqual({ sx: 0, sy: 0, size: 512 });
    expect(squareBox(1, 1)).toEqual({ sx: 0, sy: 0, size: 1 });
  });
});

describe('the picture files', () => {
  const dir = fileURLToPath(new URL('../public/avatars/', import.meta.url));
  it('every picture in the catalogue has its file, and no picture file is left out of the catalogue', () => {
    for (const p of AVATAR_PRESETS) expect(existsSync(`${dir}${p.id}.${p.retired ? 'webp' : 'svg'}`), p.id).toBe(true);
    const pictures = readdirSync(dir).filter((f) => /\.(svg|webp)$/.test(f)).map((f) => f.replace(/\.(svg|webp)$/, ''));
    expect(pictures.sort()).toEqual(AVATAR_PRESETS.map((p) => p.id).sort());
  });

  it('the Noto Emoji licence stays beside the animal pictures', () => {
    expect(readFileSync(`${dir}LICENSE-noto-emoji.txt`, 'utf8')).toContain('Apache License');
  });

  it('a picture file is an image only: no script, no outside address to load', () => {
    for (const p of OFFERED_AVATAR_PRESETS) {
      const svg = readFileSync(`${dir}${p.id}.svg`, 'utf8');
      expect(svg, p.id).toMatch(/<svg[\s>]/);
      expect(svg, p.id).not.toMatch(/<script|\son\w+\s*=|<foreignObject|javascript:/i);
      expect(svg.replace(/xmlns(:\w+)?="[^"]*"/g, ''), p.id).not.toMatch(/href\s*=\s*"https?:/i);
    }
  });
});

describe('the picker', () => {
  it('offers 25 pictures to people and 25 to bots, and the retired ones are not among them', () => {
    expect(OFFERED_AVATAR_PRESETS).toHaveLength(50);
    expect(OFFERED_AVATAR_PRESETS.some((p) => p.retired)).toBe(false);
    expect(new Set(OFFERED_AVATAR_PRESETS.map((p) => p.label)).size).toBe(50);
  });

  it('credits the makers of what is on offer, and Flaticon only while a first-library picture is in use', () => {
    expect(creditLine(true, null)).toContain('Pablo Stanley');
    expect(creditLine(true, null)).not.toContain('Flaticon');
    expect(creditLine(true, 'preset:man-3')).toContain('Flaticon');
    expect(creditLine(false, null)).toContain('Noto Emoji');
    expect(creditLine(false, 'preset:bot-brain-chip')).not.toContain('Flaticon');
  });
});
