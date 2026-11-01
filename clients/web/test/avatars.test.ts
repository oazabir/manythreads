import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AVATAR_PRESETS, Avatar, avatarLabel, avatarSrc } from '@manythreads/shared';
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
      expect(avatarSrc(`preset:${p.id}`)).toBe(`/avatars/${p.id}.webp`);
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
  it('every picture in the catalogue has its file, and no file is left out of the catalogue', () => {
    for (const p of AVATAR_PRESETS) expect(existsSync(`${dir}${p.id}.webp`), p.id).toBe(true);
    expect(readdirSync(dir).map((f) => f.replace(/\.webp$/, '')).sort()).toEqual(AVATAR_PRESETS.map((p) => p.id).sort());
  });
});
