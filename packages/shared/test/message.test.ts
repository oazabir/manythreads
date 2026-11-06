import { describe, expect, it } from 'vitest';
import { Message, PostMessageRequest, PostMessageResponse, VOICE_MAX_MS, VoiceMeta, postMessageRoute, voiceFallbackBody } from '../src/index.ts';
import { messageWire, uuid } from './fixtures.ts';

describe('Message', () => {
  it('round-trips through JSON', () => {
    const parsed = Message.parse(messageWire);
    expect(Message.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(parsed).toEqual(messageWire);
  });

  it('rejects empty body, bad ids and bad dates', () => {
    expect(Message.safeParse({ ...messageWire, body: '' }).success).toBe(false);
    expect(Message.safeParse({ ...messageWire, id: 'nope' }).success).toBe(false);
    expect(Message.safeParse({ ...messageWire, createdAt: 'yesterday' }).success).toBe(false);
  });

  it('strips unknown keys on responses', () => {
    expect(PostMessageResponse.parse({ ...messageWire, newerServerField: 1 })).toEqual(messageWire);
  });
});

describe('PostMessageRequest', () => {
  const ok = { channelId: uuid(3), body: 'hi', threadRootId: null };

  it('accepts the picked keys', () => {
    expect(PostMessageRequest.parse(ok)).toEqual(ok);
  });

  it('rejects unknown keys (strict)', () => {
    const r = PostMessageRequest.safeParse({ ...ok, authorId: uuid(4) });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('declares its route', () => {
    expect(postMessageRoute).toEqual({ method: 'POST', path: '/api/channels/:channelId/messages' });
  });
});

describe('voice messages (P14-17)', () => {
  const fileId = uuid(77);
  const voice = { fileId, durationMs: 42_000, language: 'en', transcript: 'device', peaks: [0, 128, 255] };

  it('VoiceMeta takes the documented shape and nothing more', () => {
    expect(VoiceMeta.parse(voice)).toEqual(voice);
    expect(VoiceMeta.parse({ ...voice, language: 'pt-BR', transcript: 'none' }).language).toBe('pt-BR');
    expect(VoiceMeta.parse({ ...voice, language: null }).language).toBeNull();
    expect(VoiceMeta.safeParse({ ...voice, extra: 1 }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, language: 'English' }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, transcript: 'server' }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, peaks: [256] }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, peaks: Array.from({ length: 65 }, () => 0) }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, fileId: 'nope' }).success).toBe(false);
  });

  it('the length is 0.5 s to five minutes', () => {
    expect(VOICE_MAX_MS).toBe(300_000);
    expect(VoiceMeta.safeParse({ ...voice, durationMs: 500 }).success).toBe(true);
    expect(VoiceMeta.safeParse({ ...voice, durationMs: 499 }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, durationMs: VOICE_MAX_MS }).success).toBe(true);
    expect(VoiceMeta.safeParse({ ...voice, durationMs: VOICE_MAX_MS + 1 }).success).toBe(false);
    expect(VoiceMeta.safeParse({ ...voice, durationMs: 1000.5 }).success).toBe(false);
  });

  it('a message carries meta.voice; one whose voice does not read is still a message', () => {
    expect(Message.parse({ ...messageWire, meta: { voice, attachments: [fileId] } }).meta.voice).toEqual(voice);
    expect(Message.parse({ ...messageWire, meta: { voice: { shape: 'from a newer server' } } }).meta.voice).toBeUndefined();
  });

  it('the request takes voice and stays strict', () => {
    const req = { channelId: messageWire.channelId, body: 'hi', threadRootId: null, attachments: [fileId], voice };
    expect(PostMessageRequest.parse(req).voice).toEqual(voice);
    expect(PostMessageRequest.safeParse({ ...req, voice: { ...voice, durationMs: 300_001 } }).success).toBe(false);
    expect(PostMessageRequest.safeParse({ ...req, transcript: 'x' }).success).toBe(false);
  });

  it('the stand-in body reads as minutes and seconds', () => {
    expect(voiceFallbackBody(42_000)).toBe('Voice message (0:42)');
    expect(voiceFallbackBody(5_000)).toBe('Voice message (0:05)');
    expect(voiceFallbackBody(61_400)).toBe('Voice message (1:01)');
    expect(voiceFallbackBody(300_000)).toBe('Voice message (5:00)');
    expect(voiceFallbackBody(59_600)).toBe('Voice message (1:00)');
  });
});
