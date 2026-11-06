import { describe, expect, it } from 'vitest';
import { BLOCKED_TEXT, BUSY_TEXT, FAILED_TEXT, NO_MIC_TEXT, baseMime, clipFileName, clipMime, micErrorText, pickMimeType, recorderSupported } from '../src/channels/voice/support';
import { buildVoiceSend } from '../src/channels/voice/send';

describe('voice recorder support', () => {
  it('picks the first container the browser can record', () => {
    expect(pickMimeType((t) => t === 'audio/webm;codecs=opus')).toBe('audio/webm;codecs=opus');
    expect(pickMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickMimeType(() => false)).toBeUndefined();
    expect(pickMimeType(undefined)).toBeUndefined();
    expect(pickMimeType(() => { throw new Error('no'); })).toBeUndefined();
  });

  it('uploads the plain audio type and names the file by it', () => {
    expect(baseMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(clipMime('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(clipMime('video/webm')).toBe('audio/webm');
    expect(clipMime('video/mp4')).toBe('audio/mp4');
    expect(clipMime('')).toBe('audio/webm');
    const at = new Date(2026, 10, 6, 9, 5, 7);
    expect(clipFileName('audio/webm', at)).toBe('voice-message-20261106-090507.webm');
    expect(clipFileName('audio/mp4', at)).toMatch(/\.m4a$/);
    expect(clipFileName('audio/ogg', at)).toMatch(/\.ogg$/);
  });

  it('offers the button only where recording can work', () => {
    expect(recorderSupported({ hasMediaRecorder: true, hasGetUserMedia: true, isSecureContext: true })).toBe(true);
    expect(recorderSupported({ hasMediaRecorder: false, hasGetUserMedia: true, isSecureContext: true })).toBe(false);
    expect(recorderSupported({ hasMediaRecorder: true, hasGetUserMedia: false, isSecureContext: true })).toBe(false);
    expect(recorderSupported({ hasMediaRecorder: true, hasGetUserMedia: true, isSecureContext: false })).toBe(false);
  });

  it('has one sentence for each way the microphone fails', () => {
    expect(micErrorText({ name: 'NotAllowedError' })).toBe(BLOCKED_TEXT);
    expect(BLOCKED_TEXT).toBe("Your browser blocked the microphone. Allow it in the address bar's site settings, then try again.");
    expect(micErrorText({ name: 'NotFoundError' })).toBe(NO_MIC_TEXT);
    expect(micErrorText({ name: 'NotReadableError' })).toBe(BUSY_TEXT);
    expect(micErrorText(new Error('x'))).toBe(FAILED_TEXT);
    expect(micErrorText(undefined)).toBe(FAILED_TEXT);
  });
});

describe('voice send', () => {
  const fileId = '0197b9a8-0000-7000-8000-000000000001' as never;
  it('sends without a transcript: the stand-in line and transcript none', () => {
    const { body, voice } = buildVoiceSend({ fileId, durationMs: 42_400, peaks: [0, 128, 255] });
    expect(body).toBe('Voice message (0:42)');
    expect(voice).toEqual({ fileId, durationMs: 42_400, language: null, transcript: 'none', peaks: [0, 128, 255] });
  });

  it('uses a device transcript when one is given', () => {
    const { body, voice } = buildVoiceSend({ fileId, durationMs: 5_000, peaks: [], transcript: { text: '  hello there ', language: 'en' } });
    expect(body).toBe('hello there');
    expect(voice.transcript).toBe('device');
    expect(voice.language).toBe('en');
  });

  it('keeps the meta inside what the server accepts', () => {
    const { voice } = buildVoiceSend({ fileId, durationMs: 9_999_999, peaks: Array.from({ length: 80 }, () => 400), transcript: { text: 'x', language: 'English' } });
    expect(voice.durationMs).toBe(300_000);
    expect(voice.peaks).toHaveLength(64);
    expect(voice.peaks.every((p) => p === 255)).toBe(true);
    expect(voice.language).toBeNull();
    expect(buildVoiceSend({ fileId, durationMs: 10, peaks: [] }).voice.durationMs).toBe(500);
  });
});
