import { FileMeta } from '@manythreads/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRange } from '../src/routes.ts';
import { createWorld, ensureChannels, personas, type FilesWorld } from './world.ts';

// Owner, 2026-11-23 (screen recordings play in messages): the file bytes are served by byte range when a range is asked for, as every browser asks to play and
// seek a video (Safari asks only for ranges): 206 with Content-Range, the exact bytes, 416 for a range past the end, and the whole file without a Range header.

const { nadia } = personas;
let w: FilesWorld;
let dev = '';

beforeAll(async () => {
  w = await createWorld();
  await ensureChannels(w);
  dev = await w.channelId('engineering', 'dev');
}, 180_000);
afterAll(async () => {
  await w?.close();
});

describe('byte ranges', () => {
  it('reads the range a header asks for', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull();
    expect(parseRange('items=0-1', 100)).toBeNull();
  });

  it('serves 206 with the exact bytes, 416 past the end, and the whole file without a range', async () => {
    const body = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const file = FileMeta.parse((await w.upload(nadia, dev, body, { name: 'bytes.txt', type: 'text/plain' })).body);
    const get = (range?: string) =>
      fetch(`${w.server.url}/api/files/${file.id}/content`, {
        headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: nadia.actorId, workspaceId: nadia.workspaceId }), ...(range ? { range } : {}) },
      });
    const whole = await get();
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(await whole.text()).toBe(body.toString());
    const part = await get('bytes=10-15');
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 10-15/${body.length}`);
    expect(part.headers.get('content-length')).toBe('6');
    expect(await part.text()).toBe('abcdef');
    const tail = await get('bytes=-3');
    expect(await tail.text()).toBe('xyz');
    const past = await get(`bytes=${body.length}-`);
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${body.length}`);
  });
});
