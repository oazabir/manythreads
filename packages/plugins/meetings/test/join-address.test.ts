import type { MediaToken, PluginContext } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { joinOf } from '../src/media.ts';

// The one function that hands the media address to a browser (PLAN P38-11), as the join, renew, scheduled-room and guest routes all use it. No database.

const ctx = { runtime: { publicUrl: 'https://manythreads.example.org' } } as unknown as PluginContext;
const token = (url: string, identity = '00000000-0000-7000-8000-0000000d0001'): MediaToken => ({
  provider: 'livekit',
  url,
  token: 'jwt',
  identity,
  roomName: 'room-1',
  expiresAt: new Date('2026-11-27T10:00:00.000Z'),
});

describe('joinOf', () => {
  it('carries the token, identity, room and expiry over unchanged', () => {
    expect(joinOf(ctx, token('wss://manythreads.example.org/livekit'), undefined)).toEqual({
      provider: 'livekit',
      url: 'wss://manythreads.example.org/livekit',
      token: 'jwt',
      identity: '00000000-0000-7000-8000-0000000d0001',
      roomName: 'room-1',
      expiresAt: '2026-11-27T10:00:00.000Z',
    });
  });
  it('the path form follows the request origin: a second domain over https, a local IP with a port over http', () => {
    expect(joinOf(ctx, token('wss://manythreads.example.org/livekit'), 'https://team.other.example').url).toBe('wss://team.other.example/livekit');
    expect(joinOf(ctx, token('wss://manythreads.example.org/livekit'), 'http://10.0.0.5:3000').url).toBe('ws://10.0.0.5:3000/livekit');
  });
  it('a link guest gets the same address (and keeps its guest identity)', () => {
    const j = joinOf(ctx, token('wss://manythreads.example.org/livekit', 'guest:abc'), 'https://10.0.0.5:8443');
    expect(j.url).toBe('wss://10.0.0.5:8443/livekit');
    expect(j.identity).toBe('guest:abc');
  });
  it('a media server of its own is returned unchanged', () => {
    expect(joinOf(ctx, token('wss://media.example.org'), 'https://team.other.example').url).toBe('wss://media.example.org');
  });
  it('an untrusted origin falls back to the configured address', () => {
    expect(joinOf(ctx, token('wss://manythreads.example.org/livekit'), 'https://evil.example/x@y').url).toBe('wss://manythreads.example.org/livekit');
  });
});
