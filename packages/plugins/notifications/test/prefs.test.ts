import { DEFAULT_NOTIFICATION_PREFS } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { normalizePrefs, wantsInApp } from '../src/prefs.ts';
import { previewOf } from '../src/service.ts';

describe('normalizePrefs', () => {
  it('fills what a stored document does not say and ignores what it says wrongly', () => {
    expect(normalizePrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs([])).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(normalizePrefs({ mention: { inApp: false, browser: true }, reply: 'nope', extra: 1 })).toEqual({
      ...DEFAULT_NOTIFICATION_PREFS,
      mention: { inApp: false, browser: true },
    });
    expect(normalizePrefs({ mutedChannels: ['not-a-uuid'] }).mutedChannels).toEqual([]);
  });

  it('wantsInApp: the kind is on and the channel is not muted', () => {
    const channel = '01a0fb83-ada6-7efa-8bc6-50dade5f5784';
    const prefs = normalizePrefs({ dm: { inApp: false, browser: false }, mutedChannels: [channel] });
    expect(wantsInApp(prefs, 'mention', '01a0fb83-ada6-7efa-8bc6-50dade5f5785')).toBe(true);
    expect(wantsInApp(prefs, 'mention', channel)).toBe(false);
    expect(wantsInApp(prefs, 'dm', '01a0fb83-ada6-7efa-8bc6-50dade5f5785')).toBe(false);
  });
});

describe('previewOf', () => {
  it('is one line of at most 140 characters', () => {
    expect(previewOf('first line\n\n  second   line ')).toBe('first line second line');
    expect(previewOf('')).toBe('New message');
    expect([...previewOf('x'.repeat(500))]).toHaveLength(140);
    expect(previewOf('x'.repeat(500)).endsWith('…')).toBe(true);
    expect([...previewOf('😀'.repeat(300))]).toHaveLength(140);
  });
});
