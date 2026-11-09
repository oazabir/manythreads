// Helpers of the harness tests: a PNG writer and small journeys.
import { deflateSync } from 'node:zlib';
import { defineJourney, type JourneyDeclaration, type Persona, type StepDeclaration } from '../journey.ts';

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGB PNG of `width` x `height` whose pixel colour is `colourAt(x, y)`. */
export function makePng(width: number, height: number, colourAt: (x: number, y: number) => [number, number, number]): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colourAt(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A picture of a busy screen: a gradient, 256+ distinct colours. */
export const busyPng = (): Buffer => makePng(40, 40, (x, y) => [x * 6, y * 6, (x * y) % 256]);
/** A blank page: one colour. */
export const blankPng = (): Buffer => makePng(40, 40, () => [255, 255, 255]);
/** A nearly blank page: a handful of colours. */
export const fewColoursPng = (): Buffer => makePng(40, 40, (x) => [x % 5 === 0 ? 0 : 255, 255, 255]);

export const step = (id: string, extra: Partial<StepDeclaration> = {}): StepDeclaration => ({ id, expect: 'app-frame', run: async () => undefined, ...extra });

export function journey(persona: Persona, id: string, steps: StepDeclaration[], extra: Partial<JourneyDeclaration> = {}): JourneyDeclaration {
  return defineJourney({ id, persona, goal: 'A goal.', markers: [], steps, outcome: async () => undefined, ...extra });
}
