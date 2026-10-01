import { describe, expect, it } from 'vitest';
import { Message, PostMessageRequest, PostMessageResponse, postMessageRoute } from '../src/index.ts';
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
