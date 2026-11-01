import { describe, expect, it } from 'vitest';
import { IMAGE_MAX_PIXELS, IMAGE_MAX_SIDE, imageSizeAllowed, imageSizes, sniffImage } from '../src/parse.ts';
import { expectLinear } from '@manythreads/test-utils/linear';

// A small file can still decode to a huge bitmap. The size a picture says it has is read from its own header (no decoding), and a picture that is too
// big, empty or whose header cannot be read is not kept.

const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const be16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const le16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const le32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

const png = (w: number, h: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from('IHDR'), be32(w), be32(h), Buffer.from([8, 6, 0, 0, 0]), Buffer.alloc(8)]);
const gif = (w: number, h: number): Buffer => Buffer.concat([Buffer.from('GIF89a'), le16(w), le16(h), Buffer.alloc(8)]);
const jpeg = (w: number, h: number, before: Buffer[] = []): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), be16(16), Buffer.from('JFIF\0'), Buffer.alloc(9), // APP0
    ...before,
    Buffer.from([0xff, 0xc0]), be16(17), Buffer.from([8]), be16(h), be16(w), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xda, 0, 2]),
    Buffer.alloc(8),
  ]);
const riff = (chunk: string, payload: Buffer): Buffer => Buffer.concat([Buffer.from('RIFF'), le32(4 + 8 + payload.length), Buffer.from('WEBP'), Buffer.from(chunk), le32(payload.length), payload]);
const webpLossy = (w: number, h: number): Buffer => riff('VP8 ', Buffer.concat([Buffer.from([0x10, 0x02, 0x00]), Buffer.from([0x9d, 0x01, 0x2a]), le16(w), le16(h), Buffer.alloc(8)]));
const webpLossless = (w: number, h: number): Buffer => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff('VP8L', Buffer.concat([Buffer.from([0x2f]), le32(bits >>> 0), Buffer.alloc(8)]));
};
const webpExtended = (w: number, h: number): Buffer => {
  const w3 = Buffer.from([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, ((w - 1) >> 16) & 0xff]);
  const h3 = Buffer.from([(h - 1) & 0xff, ((h - 1) >> 8) & 0xff, ((h - 1) >> 16) & 0xff]);
  return riff('VP8X', Buffer.concat([Buffer.from([0, 0, 0, 0]), w3, h3]));
};
const box = (type: string, payload: Buffer): Buffer => Buffer.concat([be32(8 + payload.length), Buffer.from(type), payload]);
const ispe = (w: number, h: number): Buffer => box('ispe', Buffer.concat([Buffer.alloc(4), be32(w), be32(h)]));
const avif = (...sizes: Array<[number, number]>): Buffer =>
  Buffer.concat([
    box('ftyp', Buffer.concat([Buffer.from('avif'), Buffer.alloc(4), Buffer.from('avifmif1')])),
    box('meta', Buffer.concat([Buffer.alloc(4), box('hdlr', Buffer.alloc(24)), box('iprp', box('ipco', Buffer.concat(sizes.map(([w, h]) => ispe(w, h)))))])),
    box('mdat', Buffer.alloc(16)),
  ]);

describe('imageSizes: the size a picture says it has', () => {
  it.each([
    ['png', 'image/png', png(640, 480), { width: 640, height: 480 }],
    ['gif', 'image/gif', gif(320, 200), { width: 320, height: 200 }],
    ['jpeg', 'image/jpeg', jpeg(1200, 630), { width: 1200, height: 630 }],
    ['jpeg after a long comment segment', 'image/jpeg', jpeg(800, 600, [Buffer.from([0xff, 0xfe]), be16(502), Buffer.alloc(500, 65)]), { width: 800, height: 600 }],
    ['jpeg with fill bytes before the marker', 'image/jpeg', jpeg(100, 50, [Buffer.from([0xff, 0xff, 0xff, 0xdb]), be16(2)]), { width: 100, height: 50 }],
    ['webp lossy', 'image/webp', webpLossy(1000, 500), { width: 1000, height: 500 }],
    ['webp lossless', 'image/webp', webpLossless(1000, 500), { width: 1000, height: 500 }],
    ['webp extended', 'image/webp', webpExtended(4000, 3000), { width: 4000, height: 3000 }],
    ['avif', 'image/avif', avif([1200, 630]), { width: 1200, height: 630 }],
  ] as const)('reads a %s', (_name, type, bytes, expected) => {
    expect(sniffImage(bytes)).toBe(type);
    expect(imageSizes(bytes, type)).toEqual([expected]);
    expect(imageSizeAllowed(bytes, type)).toBe(true);
  });

  it('reads the biggest side of a webp lossless up to 16384 pixels', () => {
    expect(imageSizes(webpLossless(16384, 16384), 'image/webp')).toEqual([{ width: 16384, height: 16384 }]);
  });

  it('reads every size an AVIF file declares', () => {
    expect(imageSizes(avif([64, 64], [8000, 8000]), 'image/avif')).toEqual([
      { width: 64, height: 64 },
      { width: 8000, height: 8000 },
    ]);
  });
});

describe('imageSizeAllowed: what is too big, empty or unreadable', () => {
  it('keeps the limits at 4096 on a side and 16 million pixels', () => {
    expect(IMAGE_MAX_SIDE).toBe(4096);
    expect(IMAGE_MAX_PIXELS).toBe(16_000_000);
    expect(imageSizeAllowed(png(4096, 3906), 'image/png')).toBe(true); // 15,998,976 pixels
    expect(imageSizeAllowed(png(4096, 3907), 'image/png')).toBe(false); // just over 16 million
    expect(imageSizeAllowed(png(4097, 10), 'image/png')).toBe(false);
    expect(imageSizeAllowed(png(10, 4097), 'image/png')).toBe(false);
  });

  it.each([
    ['png', 'image/png', (w: number, h: number) => png(w, h)],
    ['gif', 'image/gif', (w: number, h: number) => gif(w, h)],
    ['jpeg', 'image/jpeg', (w: number, h: number) => jpeg(w, h)],
    ['webp lossy', 'image/webp', (w: number, h: number) => webpLossy(w, h)],
    ['webp lossless', 'image/webp', (w: number, h: number) => webpLossless(w, h)],
    ['webp extended', 'image/webp', (w: number, h: number) => webpExtended(w, h)],
    ['avif', 'image/avif', (w: number, h: number) => avif([w, h])],
  ] as const)('refuses a huge %s of a few hundred bytes', (_name, type, make) => {
    const big = make(9000, 9000);
    expect(big.length).toBeLessThan(400);
    expect(imageSizeAllowed(big, type)).toBe(false);
    expect(imageSizeAllowed(make(100, 100), type)).toBe(true);
  });

  it('refuses a picture of no area', () => {
    expect(imageSizeAllowed(png(0, 100), 'image/png')).toBe(false);
    expect(imageSizeAllowed(png(100, 0), 'image/png')).toBe(false);
    expect(imageSizeAllowed(gif(0, 0), 'image/gif')).toBe(false);
    expect(imageSizeAllowed(jpeg(0, 10), 'image/jpeg')).toBe(false);
  });

  it('refuses an AVIF file with a big size hidden after a small one', () => {
    expect(imageSizeAllowed(avif([64, 64], [5000, 5000]), 'image/avif')).toBe(false);
  });

  it('refuses a picture whose header cannot be read', () => {
    // a PNG that does not start with IHDR
    const noHeader = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), be32(13), Buffer.from('tEXt'), Buffer.alloc(30)]);
    expect(sniffImage(noHeader)).toBe('image/png');
    expect(imageSizeAllowed(noHeader, 'image/png')).toBe(false);
    // a truncated one
    expect(imageSizeAllowed(png(10, 10).subarray(0, 20), 'image/png')).toBe(false);
    expect(imageSizeAllowed(gif(10, 10).subarray(0, 8), 'image/gif')).toBe(false);
    // a JPEG whose picture data starts before any frame header, or that ends inside a segment
    const sosFirst = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.alloc(20)]);
    expect(sniffImage(sosFirst)).toBe('image/jpeg');
    expect(imageSizeAllowed(sosFirst, 'image/jpeg')).toBe(false);
    expect(imageSizeAllowed(jpeg(10, 10).subarray(0, 26), 'image/jpeg')).toBe(false);
    // an AVIF with no ispe, one whose box says it is longer than the file
    const noIspe = Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avif')), box('meta', Buffer.alloc(40))]);
    expect(sniffImage(noIspe)).toBe('image/avif');
    expect(imageSizeAllowed(noIspe, 'image/avif')).toBe(false);
    const lying = Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avif')), be32(9999), Buffer.from('meta'), Buffer.alloc(40)]);
    expect(imageSizeAllowed(lying, 'image/avif')).toBe(false);
    // a WebP of a chunk kind that carries no size
    expect(imageSizeAllowed(riff('ABCD', Buffer.alloc(30)), 'image/webp')).toBe(false);
    expect(imageSizeAllowed(webpLossy(10, 10).subarray(0, 22), 'image/webp')).toBe(false);
  });

  it('does not take a size from a type it was not told (the caller passes what the bytes sniff as)', () => {
    expect(imageSizes(png(10, 10), 'image/gif')).not.toEqual([{ width: 10, height: 10 }]);
  });
});

describe('hostile headers cost a bounded amount', () => {
  it('a JPEG made of nothing but empty segments ends without reading forever', () => {
    const segments = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 5000 }, () => Buffer.from([0xff, 0xfe, 0x00, 0x02]))]);
    expect(imageSizes(segments, 'image/jpeg')).toEqual([]);
  });

  it('a JPEG with a zero-length segment does not loop', () => {
    expect(imageSizes(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 'image/jpeg')).toEqual([]);
  });

  it('an AVIF with thousands of empty boxes, or boxes nested deep, is cut short', () => {
    const many = Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avif')), ...Array.from({ length: 50_000 }, () => box('free', Buffer.alloc(0)))]);
    expect(imageSizes(many, 'image/avif')).toEqual([]);
    let nested = ispe(8000, 8000);
    for (let i = 0; i < 40; i += 1) nested = box('ipco', nested);
    expect(imageSizes(Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avif')), nested]), 'image/avif')).toEqual([]);
  });

  it('a long run of fill bytes is read in linear time', () => {
    expectLinear(
      (n) => Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(n, 0xff)]),
      (bytes) => imageSizes(bytes, 'image/jpeg'),
      { n: 50_000, label: 'jpeg fill bytes' },
    );
  });
});
