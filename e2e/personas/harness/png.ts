import { inflateSync } from 'node:zlib';

/** What the harness needs to know about a picture: is it a PNG at all, how big, and does it show more than a blank page (PLAN block C 1: over 200 distinct colours). */
export interface PngInfo {
  valid: boolean;
  width: number;
  height: number;
  /** Counted up to {@link DISTINCT_LIMIT}: the exact number is never needed. */
  distinctColours: number;
  reason?: string;
}

export const BLANK_BELOW = 200;
export const DISTINCT_LIMIT = 4096;
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Reads the colours of a PNG as the browser writes it (8 or 16 bits, no interlace). Reads nothing outside the buffer; any surprise is `valid: false` with a reason. */
export function inspectPng(buf: Buffer): PngInfo {
  const bad = (reason: string, width = 0, height = 0): PngInfo => ({ valid: false, width, height, distinctColours: 0, reason });
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return bad('not a PNG file');
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  const data: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (body.length < length) return bad('the file ends inside a chunk');
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8]!;
      colourType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = Buffer.from(body);
    else if (type === 'IDAT') data.push(Buffer.from(body));
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  if (width === 0 || height === 0) return bad('no image header');
  if (width * height > 64_000_000) return bad('image too large to read', width, height);
  const channels = CHANNELS[colourType];
  if (!channels || (depth !== 8 && depth !== 16)) return bad(`unsupported PNG format (type ${colourType}, ${depth} bits)`, width, height);
  if (interlace !== 0) return bad('interlaced PNG', width, height);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data));
  } catch {
    return bad('the pixel data is damaged', width, height);
  }
  const bpp = (channels * depth) / 8;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) return bad('the pixel data is too short', width, height);
  const colours = new Set<number | string>();
  let prev = Buffer.alloc(stride);
  let line = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? line[x - bpp]! : 0;
      const b = prev[x]!;
      const c = x >= bpp ? prev[x - bpp]! : 0;
      let v = src[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return bad(`unknown scanline filter ${filter}`, width, height);
      line[x] = v & 0xff;
    }
    if (colours.size < DISTINCT_LIMIT) {
      for (let x = 0; x < width && colours.size < DISTINCT_LIMIT; x += 1) {
        const o = x * bpp;
        if (colourType === 3) colours.add(line[o]!);
        else if (depth === 8 && channels >= 3) colours.add((line[o]! << 16) | (line[o + 1]! << 8) | line[o + 2]!);
        else colours.add(line.subarray(o, o + Math.min(bpp, 6)).toString('hex'));
      }
    }
    [prev, line] = [line, prev];
  }
  if (colourType === 3 && !palette) return bad('indexed PNG without a palette', width, height);
  return { valid: true, width, height, distinctColours: colours.size };
}

/** Why a picture is not acceptable (empty: it is). */
export function pictureProblem(buf: Buffer): string | null {
  if (buf.length === 0) return 'the file is empty';
  const info = inspectPng(buf);
  if (!info.valid) return `not a valid picture: ${info.reason ?? 'unreadable'}`;
  if (info.distinctColours <= BLANK_BELOW) return `the picture looks blank (${info.distinctColours} distinct colours; it needs more than ${BLANK_BELOW})`;
  return null;
}
