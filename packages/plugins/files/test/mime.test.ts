import { describe, expect, it } from 'vitest';
import { decideMime, sniffMime } from '../src/mime.ts';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from([...b, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3);
const MP4 = Uint8Array.from([0, 0, 0, 0x18, ...Buffer.from('ftypisom'), 0, 0, 0, 0]);
const OGG = Uint8Array.from(Buffer.from('OggS\0\u0002rest of a page'));

describe('decideMime: recordings from a browser', () => {
  it('keeps a declared audio/webm for a WebM container (which sniffs as video/webm), with or without codec parameters', () => {
    expect(sniffMime(WEBM)).toBe('video/webm');
    expect(decideMime('audio/webm', WEBM)).toBe('audio/webm');
    expect(decideMime('audio/webm;codecs=opus', WEBM)).toBe('audio/webm');
  });

  it('keeps a declared audio/mp4 for an MP4 container, and audio/ogg for Ogg', () => {
    expect(sniffMime(MP4)).toBe('video/mp4');
    expect(decideMime('audio/mp4', MP4)).toBe('audio/mp4');
    expect(decideMime('audio/ogg;codecs=opus', OGG)).toBe('audio/ogg');
  });

  it('still calls a video a video: the container wins unless audio was declared for the matching container', () => {
    expect(decideMime('video/webm', WEBM)).toBe('video/webm');
    expect(decideMime(undefined, WEBM)).toBe('video/webm');
    expect(decideMime('application/octet-stream', MP4)).toBe('video/mp4');
  });

  it('does not let audio/* hide another kind of file: audio declared for a PDF, a PNG or the wrong container stays what the bytes say', () => {
    expect(decideMime('audio/webm', Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(decideMime('audio/webm', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(decideMime('audio/webm', MP4)).toBe('video/mp4');
    expect(decideMime('audio/mp4', WEBM)).toBe('video/webm');
  });

  it('keeps what it did before for the rest', () => {
    expect(decideMime('text/plain; charset=utf-8', Buffer.from('hello'))).toBe('text/plain');
    expect(decideMime('image/png', Buffer.from('<svg/>'))).toBe('application/octet-stream');
    expect(decideMime(undefined, Buffer.from('x'))).toBe('application/octet-stream');
  });
});
