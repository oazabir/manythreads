import { VOICE_TRANSCRIPT_MAX_MS, VoiceMeta, voiceFallbackBody } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { decideVoice, transcribedRangeMs, transcriptBody } from '../src/voice-rules.ts';

// The posting rules of a voice message (P32-02): the server decides the transcript state and the body; only an old client's `device` words are kept.

const FILE = '00000000-0000-7000-8000-000000000001';
const sent = (over: Record<string, unknown> = {}): VoiceMeta => VoiceMeta.parse({ fileId: FILE, durationMs: 42_000, language: 'en', transcript: 'none', peaks: [1, 2, 3], ...over });

describe('what the server keeps of a voice message a person sent', () => {
  it('on: pending, the stand-in body, no language and none of the server-side fields', () => {
    const d = decideVoice(sent({ transcript: 'server', transcriptEndMs: 9000, transcriptNote: 'x', transcriptRetry: true }), 'whatever the client wrote', true);
    expect(d).toEqual({ voice: { fileId: FILE, durationMs: 42_000, language: null, transcript: 'pending', peaks: [1, 2, 3] }, body: voiceFallbackBody(42_000), queue: true });
  });

  it('off: none, the stand-in body, no job', () => {
    const d = decideVoice(sent({ transcript: 'pending' }), voiceFallbackBody(42_000), false);
    expect(d).toEqual({ voice: { fileId: FILE, durationMs: 42_000, language: null, transcript: 'none', peaks: [1, 2, 3] }, body: voiceFallbackBody(42_000), queue: false });
  });

  it('an old client\'s device words are kept as sent, with the switch on or off', () => {
    for (const on of [true, false]) {
      const d = decideVoice(sent({ transcript: 'device' }), 'Hello, this is what I said.', on);
      expect(d).toEqual({ voice: { fileId: FILE, durationMs: 42_000, language: 'en', transcript: 'device', peaks: [1, 2, 3] }, body: 'Hello, this is what I said.', queue: false });
    }
  });

  it('a device send that carries only the stand-in line (no words) is treated as a new send', () => {
    expect(decideVoice(sent({ transcript: 'device' }), voiceFallbackBody(42_000), true)).toMatchObject({ voice: { transcript: 'pending' }, queue: true });
  });

  it('a client cannot claim edited, failed, server or pending', () => {
    for (const transcript of ['edited', 'failed', 'server', 'pending']) {
      expect(decideVoice(sent({ transcript }), 'words', true).voice.transcript, transcript).toBe('pending');
    }
  });
});

describe('the transcribed range', () => {
  it('is at most 20 seconds and never more than the clip', () => {
    expect(transcribedRangeMs(42_000)).toBe(VOICE_TRANSCRIPT_MAX_MS);
    expect(transcribedRangeMs(7_300)).toBe(7_300);
    expect(transcribedRangeMs(20_000)).toBe(20_000);
  });

  it('adds " …" to the body only when the clip is longer than the range', () => {
    expect(transcriptBody('  Hello there. ', 7_000)).toBe('Hello there.');
    expect(transcriptBody('Hello there.', 20_000)).toBe('Hello there.');
    expect(transcriptBody('Hello there.', 20_001)).toBe('Hello there. …');
  });
});

describe('the shared schema', () => {
  it('takes the new states and bounds the new fields', () => {
    for (const transcript of ['pending', 'server', 'failed', 'device', 'edited', 'none']) expect(() => sent({ transcript })).not.toThrow();
    expect(() => sent({ transcriptEndMs: 20_001 })).toThrow();
    expect(() => sent({ transcriptEndMs: -1 })).toThrow();
    expect(() => sent({ transcriptNote: 'x'.repeat(201) })).toThrow();
    expect(sent({ transcriptNote: 'x'.repeat(200), transcriptEndMs: 20_000, transcriptRetry: true }).transcriptRetry).toBe(true);
    expect(() => sent({ transcript: 'unknown' })).toThrow();
  });
});
