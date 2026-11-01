import { describe, expect, it } from 'vitest';
import {
  AddCustomEmojiRequest,
  BROADCAST_CONFIRM_ABOVE,
  CUSTOM_EMOJI_NAME_PATTERN,
  SaveDraftRequest,
  broadcastSentence,
  broadcastWordsIn,
  CUSTOM_EMOJI_MAX_FRAMES,
  Message,
  MessageBody,
  PostMessageRequest,
  customEmojiNameOf,
  emojiImageInfo,
  emojiImageProblem,
  emojiToken,
  sniffEmojiImage,
} from '../src/index.ts';

const bytes = (hex: string, pad = 16): Uint8Array => Uint8Array.from([...Buffer.from(hex, 'hex'), ...new Array<number>(pad).fill(0)]);

describe('custom emoji names and pictures (P14-02)', () => {
  it('a name is 2 to 32 lower-case letters, digits or underscores, starting with a letter', () => {
    for (const good of ['ok', 'party_parrot', 'a1', 'x'.repeat(32)]) expect(CUSTOM_EMOJI_NAME_PATTERN.test(good), good).toBe(true);
    for (const bad of ['a', 'Ab', '1a', '_a', 'a-b', 'a b', 'a:b', 'x'.repeat(33), '']) expect(CUSTOM_EMOJI_NAME_PATTERN.test(bad), bad).toBe(false);
  });

  it('writes and reads the :name: form', () => {
    expect(emojiToken('wave')).toBe(':wave:');
    expect(customEmojiNameOf(':wave:')).toBe('wave');
    for (const not of ['wave', ':wave', 'wave:', '::', ':a:', ':Wave:', '👍', ':10:30:']) expect(customEmojiNameOf(not), not).toBeNull();
  });

  it('knows a picture by its first bytes, and nothing else', () => {
    expect(sniffEmojiImage(bytes('89504e470d0a1a0a'))).toBe('image/png');
    expect(sniffEmojiImage(bytes('ffd8ff'))).toBe('image/jpeg');
    expect(sniffEmojiImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(12)]))).toBe('image/gif');
    expect(sniffEmojiImage(Buffer.concat([Buffer.from('GIF87a'), Buffer.alloc(12)]))).toBe('image/gif');
    expect(sniffEmojiImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(8)]))).toBe('image/webp');
    expect(sniffEmojiImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffEmojiImage(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffEmojiImage(Buffer.from('RIFF....WAVEfmt  '))).toBeNull();
    expect(sniffEmojiImage(bytes('89504e47', 0))).toBeNull(); // too short to be a picture
  });

  it('the add request is strict about its fields', () => {
    const good = { name: 'wave', contentType: 'image/png', data: 'A'.repeat(24) };
    expect(AddCustomEmojiRequest.safeParse(good).success).toBe(true);
    expect(AddCustomEmojiRequest.safeParse({ ...good, contentType: 'image/svg+xml' }).success).toBe(false);
    expect(AddCustomEmojiRequest.safeParse({ ...good, name: 'Wave' }).success).toBe(false);
    expect(AddCustomEmojiRequest.safeParse({ ...good, extra: 1 }).success).toBe(false);
  });
});

describe('@here and @channel (P14-02)', () => {
  it('finds the two words as mentions, channel first', () => {
    expect(broadcastWordsIn('hello @here')).toEqual(['here']);
    expect(broadcastWordsIn('@here and @channel, @Channel')).toEqual(['channel', 'here']);
    expect(broadcastWordsIn('nothing to see, @rafi')).toEqual([]);
  });

  it('does not take words inside code, links or addresses', () => {
    expect(broadcastWordsIn('use `@channel` here')).toEqual([]);
    expect(broadcastWordsIn('```\n@here\n```')).toEqual([]);
    expect(broadcastWordsIn('mail me@here.example')).toEqual([]);
    expect(broadcastWordsIn('see https://example.com/@channel')).toEqual([]);
  });

  it('says it in one plain sentence', () => {
    expect(broadcastSentence(['channel'], 52)).toBe('@channel will notify 52 people.');
    expect(broadcastSentence(['here'], 1)).toBe('@here will notify 1 person.');
    expect(broadcastSentence(['channel', 'here'], 30)).toBe('@channel and @here will notify 30 people.');
    expect(broadcastSentence(['channel'], 500)).toBe('@channel will notify 500 people.');
    expect(broadcastSentence(['channel'], 730)).toBe('@channel will notify up to 500 of the 730 people who can read this.');
    expect(BROADCAST_CONFIRM_ABOVE).toBe(20);
  });
});

describe('server drafts (P14-02)', () => {
  it('a save names the text and, for a thread, its first message', () => {
    expect(SaveDraftRequest.safeParse({ body: 'half' }).success).toBe(true);
    expect(SaveDraftRequest.safeParse({ body: 'half', threadRootId: '019a0000-0000-7000-8000-000000000000' }).success).toBe(true);
    expect(SaveDraftRequest.safeParse({ body: 'x'.repeat(40_001) }).success).toBe(false);
    expect(SaveDraftRequest.safeParse({ body: 'half', who: 'me' }).success).toBe(false);
  });
});

describe('picture headers (P14-02)', () => {
  const png = (w: number, h: number): Buffer => {
    const b = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000' + '00', 'hex');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  it('reads the size of a PNG, a GIF, a JPEG and a WebP from the header', () => {
    expect(emojiImageInfo(png(32, 48))).toMatchObject({ type: 'image/png', width: 32, height: 48, frames: 1 });
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(8)]);
    gif.writeUInt16LE(20, 6);
    gif.writeUInt16LE(30, 8);
    expect(emojiImageInfo(gif)).toMatchObject({ type: 'image/gif', width: 20, height: 30 });
    const jpeg = Buffer.from('ffd8ffc00011080000000003011100021101031101', 'hex');
    jpeg.writeUInt16BE(40, 7);
    jpeg.writeUInt16BE(50, 9);
    expect(emojiImageInfo(jpeg)).toMatchObject({ type: 'image/jpeg', width: 50, height: 40 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBPVP8X', 8, 'latin1');
    webp.writeUInt32LE(10, 16);
    webp.writeUIntLE(63, 24, 3);
    webp.writeUIntLE(31, 27, 3);
    expect(emojiImageInfo(webp)).toMatchObject({ type: 'image/webp', width: 64, height: 32 });
  });
  it('says what is wrong in a plain sentence: too big, too many frames, unreadable', () => {
    expect(emojiImageProblem(emojiImageInfo(png(512, 512))!)).toBeNull();
    expect(emojiImageProblem(emojiImageInfo(png(513, 20))!)).toMatch(/513 by 20 pixels/);
    expect(emojiImageProblem({ type: 'image/gif', width: 10, height: 10, frames: CUSTOM_EMOJI_MAX_FRAMES + 1 })).toMatch(/more than 100 frames/);
    expect(emojiImageProblem({ type: 'image/png', width: null, height: null, frames: 1 })).toMatch(/could not be read/);
    expect(emojiImageInfo(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
  });
  it('a truncated header never throws', () => {
    expect(emojiImageInfo(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(6, 1)]))).toMatchObject({ width: null });
    expect(emojiImageInfo(Buffer.from('ffd8ff', 'hex').subarray(0, 3))).toBeNull();
    expect(() => emojiImageInfo(Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(20, 0xff)]))).not.toThrow();
  });
});

describe('a null character is refused with a sentence (P14-02)', () => {
  it('in a message body, a post request and a draft', () => {
    expect(MessageBody.safeParse('fine').success).toBe(true);
    const bad = MessageBody.safeParse('a\u0000b');
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/null character/);
    expect(SaveDraftRequest.safeParse({ body: 'a\u0000b' }).success).toBe(false);
    expect(Message.shape.body.safeParse('a\u0000').success).toBe(false);
    expect(PostMessageRequest.safeParse({ channelId: '019a0000-0000-7000-8000-000000000000', body: 'a\u0000', threadRootId: null }).success).toBe(false);
  });
});
