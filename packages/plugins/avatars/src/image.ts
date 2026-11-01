// What the server knows about an uploaded photo without decoding it: its kind from its first bytes (never from the type the browser declared) and the
// size it claims in its own header. A small file can still describe a huge bitmap, and every other person's browser would have to decode it, so a photo
// whose header claims more than `MAX_SIDE` pixels a side (or cannot be read) is refused. Linear time: each reader looks at a bounded stretch of bytes.

export type PhotoType = 'image/png' | 'image/jpeg' | 'image/webp';
export const MAX_SIDE = 1024;

export function sniffPhoto(b: Uint8Array): PhotoType | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
const u16be = (b: Uint8Array, i: number): number => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u32be = (b: Uint8Array, i: number): number => (((b[i] ?? 0) * 2 ** 24) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)));
const u24le = (b: Uint8Array, i: number): number => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16);

/** The width and height the header declares, or null when it cannot be read. */
export function declaredSize(b: Uint8Array, type: PhotoType): { width: number; height: number } | null {
  if (type === 'image/png') {
    if (b.length < 24 || ascii(b, 12, 16) !== 'IHDR') return null;
    return { width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (type === 'image/jpeg') {
    // walk the segments until a start-of-frame marker
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1] ?? 0;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = u16be(b, i + 2);
      if (len < 2) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
      i += 2 + len;
    }
    return null;
  }
  // WebP: a simple lossy (VP8 ), lossless (VP8L) or extended (VP8X) file
  const kind = ascii(b, 12, 16);
  if (kind === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) * 2 ** 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: ((b[26] ?? 0) | ((b[27] ?? 0) << 8)) & 0x3fff, height: ((b[28] ?? 0) | ((b[29] ?? 0) << 8)) & 0x3fff };
  }
  return null;
}
