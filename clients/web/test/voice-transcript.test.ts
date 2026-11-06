import { describe, expect, it } from 'vitest';
import type { ChannelMessage } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import { canAddTranscript } from '../src/channels/messageActions';
import { ChannelStore, channelKey } from '../src/channels/store';
import { LateTranscripts } from '../src/channels/voice/late';
import { buildVoiceSend } from '../src/channels/voice/send';
import {
  CHECK_NOTE,
  FAILED_TAIL,
  TranscriptRun,
  WEAK_TAIL,
  fallbackNotice,
  progressLine,
  showsFirstUseNote,
  transcriptToSend,
  type TranscriptState,
} from '../src/channels/voice/transcribe';
import { SpeechError, TOO_WEAK_REASON, createFakeEngine, noneEngine, type SpeechEngine, type Transcript } from '../src/speech';

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const FILE = uuid(40) as never;
const blob = new Blob(['x'], { type: 'audio/webm' });
const transcript = (text: string, language: string | null = 'en'): Transcript => ({ segments: [{ text, startMs: 0, endMs: 1000 }], text, language });
const engineOf = (fn: SpeechEngine['transcribe']): SpeechEngine => ({ kind: 'whisper', model: 'tiny', transcribe: fn });
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the lines the preview shows', () => {
  it('says what is going on, with a percentage only once there is one', () => {
    expect(progressLine('model', 0)).toBe('Getting the speech model ready…');
    expect(progressLine('model', 0.34)).toBe('Getting the speech model ready… 34%');
    expect(progressLine('listening', 0.6)).toBe('Writing it out on this device… 60%');
    expect(progressLine('listening', 1)).toBe('Writing it out on this device…');
    expect(progressLine('listening', Number.NaN)).toBe('Writing it out on this device…');
  });

  it('shows the one-time download note only while the model is being fetched', () => {
    expect(showsFirstUseNote({ phase: 'working', stage: 'model', fraction: 0.2 })).toBe(true);
    expect(showsFirstUseNote({ phase: 'working', stage: 'listening', fraction: 0.2 })).toBe(false);
    expect(showsFirstUseNote({ phase: 'ready', text: 'a', language: null })).toBe(false);
    expect(CHECK_NOTE).toBe('Check the words before you send. Only the text and the clip leave your device.');
  });

  it('says what happens next when the device cannot write it out', () => {
    expect(fallbackNotice(new SpeechError('unavailable', TOO_WEAK_REASON), null)).toBe(`${TOO_WEAK_REASON}${WEAK_TAIL}`);
    expect(WEAK_TAIL).toBe(' It will be sent without a transcript; you can add one later from another device.');
    const failed = fallbackNotice(new SpeechError('unavailable', "Couldn't write this one out."), engineOf(() => Promise.reject(new Error('x'))));
    expect(failed).toBe(`Couldn't write this one out.${FAILED_TAIL}`);
    expect(fallbackNotice(new Error('boom'), null)).toContain('Writing it out did not work.');
  });
});

describe('what Send posts', () => {
  const ready: TranscriptState = { phase: 'ready', text: 'hello there', language: 'en' };
  it('sends the device words as they are, or as corrected', () => {
    expect(transcriptToSend(ready, 'hello there')).toEqual({ text: 'hello there', language: 'en', edited: false });
    expect(transcriptToSend(ready, '  hello there  ')).toEqual({ text: 'hello there', language: 'en', edited: false });
    expect(transcriptToSend(ready, 'Hello, there')).toEqual({ text: 'Hello, there', language: 'en', edited: true });
  });

  it('sends nothing while working, after a failure, or when the box was emptied', () => {
    expect(transcriptToSend({ phase: 'working', stage: 'model', fraction: 0 }, 'x')).toBeNull();
    expect(transcriptToSend({ phase: 'none', notice: 'n' }, 'x')).toBeNull();
    expect(transcriptToSend(ready, '   ')).toBeNull();
  });

  it('turns that into the message: device, edited, or none with the stand-in line', () => {
    const base = { fileId: FILE, durationMs: 42_000, peaks: [1, 2] };
    expect(buildVoiceSend({ ...base, transcript: { text: 'hello there', language: 'en' } })).toMatchObject({ body: 'hello there', voice: { transcript: 'device', language: 'en' } });
    expect(buildVoiceSend({ ...base, transcript: { text: 'Hello, there', language: 'en', edited: true } })).toMatchObject({ body: 'Hello, there', voice: { transcript: 'edited', language: 'en' } });
    expect(buildVoiceSend({ ...base, transcript: null })).toMatchObject({ body: 'Voice message (0:42)', voice: { transcript: 'none', language: null } });
    expect(buildVoiceSend({ ...base, transcript: { text: '  ', language: 'en', edited: true } }).voice.transcript).toBe('none');
  });
});

describe('a transcript run', () => {
  it('goes from working to ready with the words and the language, passing progress on', async () => {
    const seen: TranscriptState[] = [];
    const run = new TranscriptRun(blob, async () =>
      engineOf(async (_b, o) => {
        o?.onProgress?.({ stage: 'model', fraction: 0.5 });
        o?.onProgress?.({ stage: 'listening', fraction: 0.25 });
        return transcript('  hi there ');
      }),
    );
    run.subscribe(() => seen.push(run.getState()));
    run.start();
    expect(run.getState()).toMatchObject({ phase: 'working' });
    await expect(run.done).resolves.toMatchObject({ language: 'en' });
    expect(seen).toContainEqual({ phase: 'working', stage: 'model', fraction: 0.5 });
    expect(run.getState()).toEqual({ phase: 'ready', text: 'hi there', language: 'en' });
  });

  it('works with the fake engine the browser tests use', async () => {
    const run = new TranscriptRun(blob, async () => createFakeEngine());
    run.start();
    await run.done;
    expect(run.getState()).toMatchObject({ phase: 'ready', text: 'This is a test voice message.', language: 'en' });
  });

  it('falls back to no transcript, with the reason, on a device that cannot', async () => {
    const run = new TranscriptRun(blob, async () => noneEngine(TOO_WEAK_REASON));
    run.start();
    await expect(run.done).resolves.toBeNull();
    expect(run.getState()).toEqual({ phase: 'none', notice: `${TOO_WEAK_REASON}${WEAK_TAIL}` });
  });

  it('falls back to no transcript when the work fails, and never rejects', async () => {
    const run = new TranscriptRun(blob, async () => engineOf(() => Promise.reject(new SpeechError('unavailable', "Couldn't get the speech model. Check your connection and try again."))));
    run.start();
    await expect(run.done).resolves.toBeNull();
    expect(run.getState()).toEqual({ phase: 'none', notice: `Couldn't get the speech model. Check your connection and try again.${FAILED_TAIL}` });
  });

  it('a cancel stops it quietly and a new start begins again', async () => {
    let aborted = false;
    let calls = 0;
    const run = new TranscriptRun(blob, async () =>
      engineOf((_b, o) => {
        calls += 1;
        if (calls > 1) return Promise.resolve(transcript('second time'));
        return new Promise((_ok, fail) => o?.signal?.addEventListener('abort', () => { aborted = true; fail(new SpeechError('aborted', 'Writing it out was cancelled.')); }));
      }),
    );
    run.start();
    await flush();
    run.cancel();
    await expect(run.done).resolves.toBeNull();
    expect(aborted).toBe(true);
    expect(run.getState().phase).toBe('working'); // a cancel is not a failure: no notice
    run.start();
    await run.done;
    expect(run.getState()).toMatchObject({ phase: 'ready', text: 'second time' });
  });

  it('can fetch the clip lazily (a clip already on the server)', async () => {
    let fetched = 0;
    const run = new TranscriptRun(async () => { fetched += 1; return blob; }, async () => engineOf(async () => transcript('late words')));
    run.start();
    run.start(); // a second start while running does nothing
    await run.done;
    expect(fetched).toBe(1);
    expect(run.getState()).toMatchObject({ phase: 'ready', text: 'late words' });
  });
});

describe('send without waiting', () => {
  it('saves the words once the message is posted and the words are ready, in either order', async () => {
    const saved: string[] = [];
    const late = new LateTranscripts();
    late.setApplier(async (t, text) => { saved.push(`${t.messageId}:${text}`); });
    // words first, then the post
    late.watch('f1', Promise.resolve(transcript(' words one ')));
    await flush();
    expect(saved).toEqual([]);
    late.posted('f1', { channelId: 'c', rootId: null, messageId: 'm1' });
    expect(saved).toEqual(['m1:words one']);
    // post first, then the words
    let finish: (t: Transcript) => void = () => undefined;
    late.watch('f2', new Promise<Transcript>((r) => { finish = r; }));
    late.posted('f2', { channelId: 'c', rootId: 'r', messageId: 'm2' });
    expect(saved).toHaveLength(1);
    finish(transcript('words two'));
    await flush();
    expect(saved).toEqual(['m1:words one', 'm2:words two']);
    expect(late.watching('f1')).toBe(false);
  });

  it('saves nothing when the device found no words or failed, and ignores clips it was not told about', async () => {
    const saved: string[] = [];
    const late = new LateTranscripts();
    late.setApplier(async (_t, text) => { saved.push(text); });
    late.watch('a', Promise.resolve(null));
    late.watch('b', Promise.resolve(transcript('   ')));
    late.watch('c', Promise.reject(new Error('x')));
    await flush();
    for (const id of ['a', 'b', 'c', 'other']) late.posted(id, { channelId: 'c', rootId: null, messageId: 'm' });
    expect(saved).toEqual([]);
  });

  it('a failing save does not throw', async () => {
    const late = new LateTranscripts();
    late.setApplier(() => Promise.reject(new Error('offline')));
    late.watch('a', Promise.resolve(transcript('x')));
    late.posted('a', { channelId: 'c', rootId: null, messageId: 'm' });
    await flush();
    expect(late.watching('a')).toBe(false);
  });
});

describe('late words in the store', () => {
  const WS = uuid(901);
  const CH = uuid(900);
  const voiceMsg = (transcriptKind: 'none' | 'edited'): ChannelMessage =>
    ({
      id: uuid(101), workspaceId: WS, channelId: CH, authorId: uuid(1), body: 'Voice message (0:42)', bodyPlain: 'Voice message (0:42)', threadRootId: null, editedAt: null, deletedAt: null,
      meta: { voice: { fileId: FILE, durationMs: 42_000, language: null, transcript: transcriptKind, peaks: [] } }, createdAt: '2026-09-07T08:11:00.000Z', reactions: [], replyCount: 0, lastReplyAt: null,
    }) as unknown as ChannelMessage;

  it('edits a clip that still has no transcript, and the message then reads as edited', async () => {
    const m = voiceMsg('none');
    const patches: unknown[] = [];
    setTransport(async (req) => {
      if (req.method === 'PATCH') {
        patches.push(req.body);
        const edited = { ...m, body: 'the words', bodyPlain: 'the words', editedAt: '2026-09-07T08:12:00.000Z', meta: { voice: { ...m.meta.voice, transcript: 'edited' } } };
        return { status: 200, body: edited };
      }
      return { status: 200, body: { items: [m], nextCursor: null } };
    });
    const store = new ChannelStore();
    await store.loadChannel(CH);
    await store.addLateTranscript(CH, null, m.id, 'the words');
    expect(patches.map((p) => JSON.parse(p as string))).toEqual([{ body: 'the words' }]);
    expect(store.get(channelKey(CH)).items[0]).toMatchObject({ body: 'the words', meta: { voice: { transcript: 'edited' } } });
  });

  it('leaves a message alone that the author already corrected by hand', async () => {
    const m = voiceMsg('edited');
    const patches: unknown[] = [];
    setTransport(async (req) => {
      if (req.method === 'PATCH') patches.push(req.body);
      return { status: 200, body: { items: [m], nextCursor: null } };
    });
    const store = new ChannelStore();
    await store.loadChannel(CH);
    await store.addLateTranscript(CH, null, m.id, 'the words');
    expect(patches).toEqual([]);
  });
});

describe('the message menu', () => {
  const voice = { fileId: FILE, durationMs: 1000, language: null, transcript: 'none', peaks: [] } as never;
  it('offers "Add a transcript" on the author\'s own clip without words only', () => {
    expect(canAddTranscript({ own: true, deleted: false, voice })).toBe(true);
    expect(canAddTranscript({ own: false, deleted: false, voice })).toBe(false);
    expect(canAddTranscript({ own: true, deleted: true, voice })).toBe(false);
    expect(canAddTranscript({ own: true, deleted: false, voice: { ...(voice as object), transcript: 'device' } as never })).toBe(false);
    expect(canAddTranscript({ own: true, deleted: false, voice: undefined })).toBe(false);
  });
});
