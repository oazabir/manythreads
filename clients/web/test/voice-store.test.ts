import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, VoiceMeta } from '@manythreads/shared';
import { setTransport, type TransportRequest } from '../src/api/client';

// P32-05 / P32-06: sending a voice message from the store (no preview: a row at once, upload, then post), and the live transcript through `message.edited`.

const upload = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../src/api/endpoints', async (orig) => ({ ...(await orig<typeof import('../src/api/endpoints')>()), uploadChannelFile: upload.fn }));

import { ChannelStore, channelKey, threadKey } from '../src/channels/store';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const CH = uuid(900);
const WS = uuid(901);
const ME = uuid(1);
const FILE = uuid(500);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const clip = { blob: new Blob([new Uint8Array(40)]), mime: 'audio/webm', durationMs: 4_200, peaks: [10, 200, 255], limited: false };
const voice = (over: Partial<VoiceMeta> = {}): VoiceMeta => ({ fileId: FILE, durationMs: 4_200, language: null, transcript: 'pending', peaks: [10, 200, 255], ...over }) as VoiceMeta;

function posted(over: Partial<ChannelMessage> = {}, v: VoiceMeta = voice()): ChannelMessage {
  return {
    id: uuid(700),
    workspaceId: WS,
    channelId: CH,
    authorId: ME,
    body: 'Voice message (0:04)',
    bodyPlain: 'Voice message (0:04)',
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: { voice: v },
    createdAt: '2026-09-07T08:10:00.000Z',
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as ChannelMessage;
}

function serve(handler: (req: TransportRequest) => { status: number; body: unknown }): TransportRequest[] {
  const seen: TransportRequest[] = [];
  setTransport(async (req) => {
    seen.push(req);
    return handler(req);
  });
  return seen;
}

describe('sending a voice message', () => {
  let store: ChannelStore;
  beforeEach(() => {
    store = new ChannelStore();
    store.setSelf(ME);
    upload.fn.mockReset();
    upload.fn.mockResolvedValue({ id: FILE, name: 'voice.webm', size: 40, mime: 'audio/webm' });
  });

  it('shows a pending row holding the clip at once, uploads, then posts with the voice record', async () => {
    let release: (() => void) | undefined;
    upload.fn.mockImplementation(() => new Promise((res) => { release = () => res({ id: FILE, name: 'voice.webm', size: 40, mime: 'audio/webm' }); }));
    const seen = serve((req) => (req.method === 'GET' ? { status: 200, body: { items: [], nextCursor: null } } : { status: 201, body: posted() }));
    await store.loadChannel(CH);
    const sending = store.sendVoice(CH, null, clip);
    // before the upload is done the row is there, with the clip and the length
    const [p] = store.get(channelKey(CH)).pending;
    expect(p).toMatchObject({ status: 'sending', body: '' });
    expect(p?.clip).toMatchObject({ mime: 'audio/webm', durationMs: 4_200, peaks: [10, 200, 255] });
    release?.();
    await sending;
    const post = seen.find((r) => r.method === 'POST');
    expect(post?.url).toBe(`/api/channels/${CH}/messages`);
    const body = JSON.parse(String(post?.body)) as { body: string; attachments: string[]; voice: VoiceMeta };
    expect(body.body).toBe('Voice message (0:04)');
    expect(body.attachments).toEqual([FILE]);
    expect(body.voice).toMatchObject({ fileId: FILE, durationMs: 4_200 });
    const tl = store.get(channelKey(CH));
    expect(tl.pending).toEqual([]);
    expect(tl.items.map((m) => m.id)).toEqual([uuid(700)]);
  });

  it('a failed upload leaves the row failed with the clip kept; Try again uploads and posts, Delete removes it', async () => {
    serve((req) => (req.method === 'GET' ? { status: 200, body: { items: [], nextCursor: null } } : { status: 201, body: posted() }));
    await store.loadChannel(CH);
    upload.fn.mockRejectedValueOnce(new Error('offline'));
    await store.sendVoice(CH, null, clip);
    const [failed] = store.get(channelKey(CH)).pending;
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed?.clip?.blob).toBe(clip.blob);
    await store.retry(CH, null, failed?.localId ?? '');
    expect(upload.fn).toHaveBeenCalledTimes(2);
    expect(store.get(channelKey(CH)).pending).toEqual([]);
    expect(store.get(channelKey(CH)).items).toHaveLength(1);

    upload.fn.mockRejectedValueOnce(new Error('offline'));
    await store.sendVoice(CH, null, clip);
    const [again] = store.get(channelKey(CH)).pending;
    store.discard(CH, null, again?.localId ?? '');
    expect(store.get(channelKey(CH)).pending).toEqual([]);
  });

  it('a failed post keeps the uploaded file: Try again posts without uploading the clip twice', async () => {
    let fail = true;
    serve((req) => {
      if (req.method === 'GET') return { status: 200, body: { items: [], nextCursor: null } };
      return fail ? { status: 500, body: { error: { code: 'internal', message: 'down' } } } : { status: 201, body: posted() };
    });
    await store.loadChannel(CH);
    await store.sendVoice(CH, null, clip);
    const [failed] = store.get(channelKey(CH)).pending;
    expect(failed).toMatchObject({ status: 'failed', attachments: [{ id: FILE }] });
    fail = false;
    await store.retry(CH, null, failed?.localId ?? '');
    expect(upload.fn).toHaveBeenCalledTimes(1);
    expect(store.get(channelKey(CH)).pending).toEqual([]);
  });

  it('sends into a thread and shows the row there', async () => {
    const root = uuid(650);
    serve((req) => (req.method === 'GET' ? { status: 200, body: { items: [], nextCursor: null } } : { status: 201, body: posted({ threadRootId: root as never }) }));
    const sending = store.sendVoice(CH, root, clip);
    expect(store.get(threadKey(root)).pending).toHaveLength(1);
    await sending;
    expect(store.get(threadKey(root)).pending).toEqual([]);
  });

  it('a text message that goes out at the same time is not taken for the voice row', async () => {
    serve((req) => (req.method === 'GET' ? { status: 200, body: { items: [], nextCursor: null } } : { status: 201, body: posted() }));
    await store.loadChannel(CH);
    upload.fn.mockImplementation(() => new Promise(() => undefined)); // the clip never finishes uploading
    void store.sendVoice(CH, null, clip);
    store.handlePush({ type: 'message.posted', id: 'x', payload: { channelId: CH, messageId: uuid(701), threadRootId: null, message: posted({ id: uuid(701) as never, body: '', bodyPlain: '', meta: {} }) } });
    await tick();
    expect(store.get(channelKey(CH)).pending).toHaveLength(1);
  });
});

describe('the transcript arrives by push', () => {
  let store: ChannelStore;
  beforeEach(async () => {
    store = new ChannelStore();
    store.setSelf(ME);
    serve(() => ({ status: 200, body: { items: [posted()], nextCursor: null } }));
    await store.loadChannel(CH);
  });
  const edited = (m: ChannelMessage) => store.handlePush({ type: 'message.edited', id: 'e', payload: { channelId: CH, messageId: m.id, threadRootId: null, message: m } });
  const held = (): ChannelMessage | undefined => store.get(channelKey(CH)).items[0];

  it('moves the row from pending to the words, with the range and the body', async () => {
    edited(posted({ body: 'Hello there.', bodyPlain: 'Hello there.', editedAt: '2026-09-07T08:10:09.000Z' }, voice({ transcript: 'server', language: 'en', transcriptEndMs: 4_200 })));
    await tick();
    expect(held()?.body).toBe('Hello there.');
    expect(held()?.meta.voice).toMatchObject({ transcript: 'server', transcriptEndMs: 4_200 });
  });

  it('carries a failure with its note and whether Try again is offered', async () => {
    edited(posted({}, voice({ transcript: 'failed', transcriptNote: 'The speech model is not ready.', transcriptRetry: true })));
    await tick();
    expect(held()?.meta.voice).toMatchObject({ transcript: 'failed', transcriptNote: 'The speech model is not ready.', transcriptRetry: true });
  });

  it('an answer to our own POST that still says pending does not put the stand-in line back over the words', async () => {
    edited(posted({ body: 'Hello there.', bodyPlain: 'Hello there.' }, voice({ transcript: 'server', transcriptEndMs: 4_200 })));
    await tick();
    store.applyPosted(posted());
    expect(held()?.body).toBe('Hello there.');
    expect(held()?.meta.voice?.transcript).toBe('server');
  });

  it('Try again: the route answers with the message, pending once more, and the held row follows', async () => {
    edited(posted({}, voice({ transcript: 'failed', transcriptRetry: true })));
    await tick();
    const seen = serve(() => ({ status: 200, body: posted() }));
    await store.retryTranscript(CH, null, uuid(700));
    expect(seen[0]).toMatchObject({ method: 'POST', url: `/api/messages/${uuid(700)}/voice/transcribe` });
    expect(held()?.meta.voice?.transcript).toBe('pending');
  });

  it('Try again: a transcript pushed while the request is out is not overwritten by the older pending answer', async () => {
    edited(posted({}, voice({ transcript: 'failed', transcriptRetry: true })));
    await tick();
    let answer: (v: { status: number; body: unknown }) => void = () => undefined;
    setTransport(
      () =>
        new Promise((res) => {
          answer = res;
        }),
    );
    const asking = store.retryTranscript(CH, null, uuid(700));
    await tick();
    edited(posted({ body: 'Hello there.', bodyPlain: 'Hello there.', editedAt: '2026-09-07T08:10:09.000Z' }, voice({ transcript: 'server', transcriptEndMs: 4_200 })));
    await tick();
    answer({ status: 200, body: posted() });
    await asking;
    expect(held()?.body).toBe('Hello there.');
    expect(held()?.meta.voice?.transcript).toBe('server');
  });
});
