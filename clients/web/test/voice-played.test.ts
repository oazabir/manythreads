// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPlayed, markPlayed, playedKey, resetPlayed, setPlayedOwner } from '../src/channels/voice/played';

// P32-06 review: two people who share a browser do not share what they played, and a message played in another tab is seen here.

function disk(): { kept: Map<string, string>; storage: Storage } {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) } as unknown as Storage;
  return { kept, storage };
}

describe('the played list of one browser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    setPlayedOwner(null);
    resetPlayed();
  });

  it('keeps one list for each person', () => {
    const { kept, storage } = disk();
    vi.stubGlobal('localStorage', storage);
    setPlayedOwner('u1');
    markPlayed('m1');
    expect(isPlayed('m1')).toBe(true);
    setPlayedOwner('u2');
    expect(isPlayed('m1')).toBe(false);
    expect(kept.has(playedKey('u1'))).toBe(true);
    expect(kept.has(playedKey('u2'))).toBe(false);
    setPlayedOwner('u1');
    expect(isPlayed('m1')).toBe(true);
  });

  it('reads the list again when another tab wrote it', () => {
    const { kept, storage } = disk();
    vi.stubGlobal('localStorage', storage);
    setPlayedOwner('u1');
    expect(isPlayed('m9')).toBe(false);
    kept.set(playedKey('u1'), JSON.stringify(['m9']));
    window.dispatchEvent(new StorageEvent('storage', { key: playedKey('u1') }));
    expect(isPlayed('m9')).toBe(true);
  });
});
