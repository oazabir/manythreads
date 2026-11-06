import { describe, expect, it } from 'vitest';
import type { FileSummary, VoiceMeta } from '@manythreads/shared';
import {
  barHeights, clampPosition, formatClock, nextSpeed, playedBars, positionAt, seekBy, seekForKey, speedAria, speedLabel, transcriptNote, valueText,
  voiceClip, voiceHitLength, withoutClip,
} from '../src/channels/voice/playerFormat';

const voice = (over: Partial<VoiceMeta> = {}): VoiceMeta => ({ fileId: '00000000-0000-7000-8000-000000000001', durationMs: 42_000, language: 'en', transcript: 'device', peaks: [], ...over }) as VoiceMeta;
const file = (id: string): FileSummary => ({ id, name: 'voice.webm', mime: 'audio/webm' }) as FileSummary;

describe('voice player format (P14-17)', () => {
  it('writes times as minutes and two-digit seconds', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7_400)).toBe('0:07');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(300_000)).toBe('5:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });

  it('reads the slider as "0:12 of 0:42"', () => {
    expect(valueText(12_000, 42_000)).toBe('0:12 of 0:42');
  });

  it('keeps every position inside the clip', () => {
    expect(clampPosition(-1, 42_000)).toBe(0);
    expect(clampPosition(99_000, 42_000)).toBe(42_000);
    expect(seekBy(40_000, 5_000, 42_000)).toBe(42_000);
    expect(seekBy(2_000, -5_000, 42_000)).toBe(0);
    expect(positionAt(0.5, 42_000)).toBe(21_000);
    expect(positionAt(2, 42_000)).toBe(42_000);
    expect(positionAt(Number.NaN, 42_000)).toBe(0);
  });

  it('moves five seconds per arrow and to the ends with Home and End', () => {
    expect(seekForKey('ArrowRight', 10_000, 42_000)).toBe(15_000);
    expect(seekForKey('ArrowLeft', 10_000, 42_000)).toBe(5_000);
    expect(seekForKey('Home', 10_000, 42_000)).toBe(0);
    expect(seekForKey('End', 10_000, 42_000)).toBe(42_000);
    expect(seekForKey('a', 10_000, 42_000)).toBeNull();
  });

  it('cycles the speed 1x, 1.5x, 2x and names it in words', () => {
    expect(nextSpeed(1)).toBe(1.5);
    expect(nextSpeed(1.5)).toBe(2);
    expect(nextSpeed(2)).toBe(1);
    expect(nextSpeed(3)).toBe(1);
    expect(speedLabel(1.5)).toBe('1.5×');
    expect(speedAria(1.5)).toBe('Playback speed 1.5 times');
    expect(speedAria(2)).toBe('Playback speed 2 times');
  });

  it('draws 64 bars from any number of loudness values, each at least a small stub', () => {
    expect(barHeights([], 64)).toHaveLength(64);
    const flat = barHeights([0, 0, 0], 64);
    expect(Math.min(...flat)).toBeGreaterThan(0);
    const loud = barHeights([255], 64);
    expect(loud.every((h) => h === 1)).toBe(true);
    const squeezed = barHeights(Array.from({ length: 128 }, (_, i) => (i === 3 ? 255 : 0)), 64);
    expect(squeezed[1]).toBe(1);
    expect(squeezed[0]).toBeLessThan(0.2);
    expect(barHeights([10], 0)).toEqual([]);
  });

  it('counts the played bars from the position', () => {
    expect(playedBars(0, 42_000)).toBe(0);
    expect(playedBars(21_000, 42_000)).toBe(32);
    expect(playedBars(42_000, 42_000)).toBe(64);
    expect(playedBars(5, 0)).toBe(0);
  });

  it('finds the clip among the attachments and leaves the other files', () => {
    const v = voice();
    const clip = voiceClip(v, [file('other'), file(v.fileId)]);
    expect(clip?.file.id).toBe(v.fileId);
    expect(voiceClip(v, [file('other')])).toBeNull();
    expect(voiceClip(undefined, [file(v.fileId)])).toBeNull();
    expect(withoutClip([file('other'), file(v.fileId)], clip).map((f) => f.id)).toEqual(['other']);
    expect(withoutClip(undefined, null)).toEqual([]);
  });

  it('says where a transcript came from, and nothing when there is none', () => {
    expect(transcriptNote(voice({ transcript: 'device', language: 'en' }))).toBe("Transcript in English, written on the sender's device");
    expect(transcriptNote(voice({ transcript: 'edited', language: null }))).toBe('Transcript, corrected by hand');
    expect(transcriptNote(voice({ transcript: 'none' }))).toBeNull();
  });

  it('recognises the stand-in line of a voice message with no transcript in a search hit', () => {
    expect(voiceHitLength('Voice message (0:42)')).toBe('0:42');
    expect(voiceHitLength('Voice message (12:05)')).toBe('12:05');
    expect(voiceHitLength('Voice message (soon)')).toBeNull();
    expect(voiceHitLength('a Voice message (0:42) b')).toBeNull();
  });
});
