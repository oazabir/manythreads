// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelMessage, VoiceMeta } from '@manythreads/shared';
import { setTransport } from '../src/api/client';
import type { People } from '../src/channels/hooks';
import { MessageRow, PendingRow, type RowActions } from '../src/channels/MessageRow';
import { ChannelStore } from '../src/channels/store';
import { resetPlayed } from '../src/channels/voice/played';

// P32-06: each state of a voice message as the row draws it, and the row that is still being sent (P32-05).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uuid = (n: number): string => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ME = uuid(1);
const THEM = uuid(2);
const FILE = uuid(500);

const people: People = {
  loaded: true,
  settled: true,
  list: [],
  bots: [],
  byActor: () => undefined,
  byPerson: () => undefined,
  botAvatar: () => undefined,
  botAvatarBySlug: () => undefined,
  isBotHandle: () => false,
  me: undefined,
  canModerate: false,
};
const actions: RowActions = { react: () => undefined, edit: () => Promise.resolve(), remove: () => Promise.resolve() };

const voice = (over: Partial<VoiceMeta> = {}): VoiceMeta => ({ fileId: FILE, durationMs: 19_000, language: null, transcript: 'pending', peaks: [10, 200, 255, 90], ...over }) as VoiceMeta;
function message(v: VoiceMeta, over: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: uuid(700),
    workspaceId: uuid(901),
    channelId: uuid(900),
    authorId: ME,
    author: { actorId: ME, kind: 'person', displayName: 'Nadia' },
    body: 'Voice message (0:19)',
    bodyPlain: 'Voice message (0:19)',
    threadRootId: null,
    editedAt: null,
    deletedAt: null,
    meta: { voice: v },
    attachments: [{ id: FILE, name: 'voice.webm', size: 40, mime: 'audio/webm' }],
    createdAt: '2026-09-07T18:04:00.000Z',
    reactions: [],
    replyCount: 0,
    lastReplyAt: null,
    ...over,
  } as unknown as ChannelMessage;
}

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  resetPlayed();
  try {
    localStorage.clear();
  } catch {
    // no storage here
  }
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

async function draw(m: ChannelMessage, self: string = ME): Promise<void> {
  await act(async () => {
    root.render(createElement(MessageRow, { message: m, teamSlug: null, people, selfActor: self, canPost: true, actions }));
  });
}
const q = (id: string): HTMLElement | null => host.querySelector(`[data-testid="${id}"]`);
const text = (id: string): string => q(id)?.textContent ?? '';

describe('a voice message in a row', () => {
  it('draws one flat player row: play, waveform with a dot, the length, the played dot and the speed; no card, no second picture, no sent time', async () => {
    await draw(message(voice()));
    expect(q('voice-message')).not.toBeNull();
    expect(host.querySelector('.vp-play')).not.toBeNull();
    expect(q('voice-seek')?.getAttribute('role')).toBe('slider');
    expect(q('voice-dot')).not.toBeNull();
    expect(text('voice-time')).toBe('0:19');
    expect(q('voice-badge')?.getAttribute('aria-label')).toBe('not played yet');
    expect(q('voice-speed')).not.toBeNull();
    // the row's own avatar is the only picture; the sent time is the row's (the player does not repeat it)
    expect(host.querySelector('.vp-who, .vp-mic, .vp-sent')).toBeNull();
    expect(q('voice-sent')).toBeNull();
    expect(q('voice-player')?.querySelector('.av')).toBeNull();
    // the transcript block sits under the player, in the message's body column
    expect(q('voice-message')?.querySelector('.vt')).not.toBeNull();
    expect(q('voice-message')?.parentElement?.classList.contains('msg-main')).toBe(true);
  });

  it('a voice message that continues a run has no name or picture of its own, like a text message', async () => {
    await act(async () => {
      root.render(createElement(MessageRow, { message: message(voice()), continued: true, teamSlug: null, people, selfActor: ME, canPost: true, actions }));
    });
    expect(host.querySelector('.msg')?.classList.contains('run')).toBe(true);
    expect(host.querySelector('.msg > .av, .msg > .av-wrap')).toBeNull();
    expect(host.querySelector('.who b:not(.sr-only)')).toBeNull();
    expect(q('voice-player')).not.toBeNull();
  });

  it('pending: "Writing the transcript…" with a spinner, announced only on the sender\'s own message', async () => {
    await draw(message(voice({ transcript: 'pending' })));
    expect(text('voice-writing')).toBe('Writing the transcript…');
    expect(q('voice-writing')?.getAttribute('role')).toBe('status');
    expect(host.querySelector('.vt-spin')).not.toBeNull();
    // the stand-in line is not drawn as the words
    expect(q('voice-words')).toBeNull();
    expect(host.textContent).not.toContain('Voice message (0:19)');
    await draw(message(voice({ transcript: 'pending' })), THEM);
    expect(q('voice-writing')?.getAttribute('role')).toBeNull();
    expect(q('voice-writing')?.getAttribute('aria-live')).toBeNull();
  });

  it('server: the words drawn once, as the message text, with the caption after them', async () => {
    const m = message(voice({ transcript: 'server', durationMs: 10_400, transcriptEndMs: 10_400 }), { body: 'Hello **there**\nsecond line', bodyPlain: 'Hello there second line' });
    await draw(m);
    expect(text('voice-transcript-heading')).toBe('Transcript');
    expect(q('voice-transcript-heading')?.getAttribute('title')).toBe('Transcript · 0:00–0:10');
    // the words come first and the caption after them; no bold heading or rule
    expect(q('voice-words')?.classList.contains('txt')).toBe(true);
    expect(q('voice-words')?.compareDocumentPosition(q('voice-transcript-heading') as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(host.querySelector('.vt-head')).toBeNull();
    expect(host.querySelectorAll('[data-testid="voice-words"]')).toHaveLength(1);
    expect(q('voice-words')?.textContent).toBe('Hello **there**\nsecond line');
    expect(q('voice-first-seconds')).toBeNull();
    // the words are inside the transcript block, and the body is not drawn a second time under the card
    expect(q('voice-transcript')?.contains(q('voice-words'))).toBe(true);
    expect(host.textContent?.split('second line').length).toBe(2);
  });

  it('server, a clip longer than 20 seconds: says the transcript is of the first 20 seconds', async () => {
    await draw(message(voice({ transcript: 'server', durationMs: 95_000, transcriptEndMs: 20_000 }), { body: 'Words.' }));
    expect(text('voice-transcript-heading')).toBe('Transcript of the first 20 seconds');
    expect(text('voice-first-seconds')).toBe(' of the first 20 seconds');
  });

  it('edited: the caption says so and nothing about a range', async () => {
    await draw(message(voice({ transcript: 'edited' }), { body: 'Corrected words.', editedAt: '2026-09-07T18:10:00.000Z' }));
    expect(text('voice-transcript-heading')).toBe('Transcript (edited)');
    expect(text('voice-words')).toContain('Corrected words.');
    expect(host.querySelectorAll('[data-testid="voice-words"]')).toHaveLength(1);
  });

  it('failed: "No transcript" with the note; Try again for the author only when the server says a retry can help', async () => {
    const failed = message(voice({ transcript: 'failed', transcriptNote: 'The speech model is not ready.', transcriptRetry: true }));
    await draw(failed);
    expect(text('voice-no-transcript')).toBe('No transcript.');
    expect(text('voice-fail-note')).toBe('The speech model is not ready.');
    expect(q('voice-try-again')).not.toBeNull();
    await draw(failed, THEM);
    expect(q('voice-try-again')).toBeNull();
    await draw(message(voice({ transcript: 'failed', transcriptNote: 'Too quiet to make out.', transcriptRetry: false })));
    expect(text('voice-fail-note')).toBe('Too quiet to make out.');
    expect(q('voice-try-again')).toBeNull();
  });

  it('Try again asks the server and the row goes back to pending; a refusal is shown in words', async () => {
    const seen: string[] = [];
    setTransport(async (req) => {
      seen.push(`${req.method} ${req.url}`);
      return { status: 200, body: message(voice({ transcript: 'pending' })) };
    });
    const spy = vi.spyOn(ChannelStore.prototype, 'retryTranscript');
    await draw(message(voice({ transcript: 'failed', transcriptRetry: true })));
    await act(async () => q('voice-try-again')?.click());
    expect(spy).toHaveBeenCalled();
    expect(seen).toEqual([`POST /api/messages/${uuid(700)}/voice/transcribe`]);
    spy.mockRejectedValueOnce(new Error('x'));
    await act(async () => q('voice-try-again')?.click());
    expect(text('voice-retry-error')).toBe('Could not ask again. Try again in a moment.');
  });

  it('after Try again the keyboard goes to the words that say the transcript is being written', async () => {
    setTransport(async () => ({ status: 200, body: message(voice({ transcript: 'pending' })) }));
    await draw(message(voice({ transcript: 'failed', transcriptRetry: true })), ME);
    const button = q('voice-try-again') as HTMLElement;
    button.focus();
    await act(async () => button.click());
    await draw(message(voice({ transcript: 'pending' })), ME);
    expect(q('voice-writing')).not.toBeNull();
    expect(document.activeElement).toBe(q('voice-writing'));
  });

  it('none and device: as before, with no "Add a transcript" anywhere', async () => {
    await draw(message(voice({ transcript: 'none' })));
    expect(text('voice-no-transcript')).toBe('No transcript');
    await draw(message(voice({ transcript: 'device', language: 'en' }), { body: 'Written on the phone.' }));
    expect(text('voice-words')).toContain('Written on the phone.');
    expect(text('voice-note')).toBe("Transcript in English, written on the sender's device");
    expect(host.textContent).not.toContain('Add a transcript');
  });

  it('the dot is filled until this reader plays the message, then it is a ring and says played', async () => {
    const m = message(voice());
    await draw(m);
    expect(q('voice-badge')?.classList.contains('heard')).toBe(false);
    const { markPlayed } = await import('../src/channels/voice/played');
    await act(async () => markPlayed(m.id));
    expect(q('voice-badge')?.getAttribute('aria-label')).toBe('played');
    expect(q('voice-badge')?.classList.contains('heard')).toBe(true);
  });
});

describe('a voice message still being sent', () => {
  const pending = { localId: 'p1', body: '', attachments: [], status: 'sending' as const, createdAt: '2026-09-07T18:04:00.000Z', clip: { blob: new Blob([]), mime: 'audio/webm', durationMs: 7_000, peaks: [10, 255, 90] } };
  const drawPending = async (p: typeof pending | (Omit<typeof pending, 'status'> & { status: 'failed' }), onRetry = vi.fn(), onDiscard = vi.fn()) => {
    await act(async () => {
      root.render(createElement(PendingRow, { pending: p, name: 'Nadia', onRetry, onDiscard }));
    });
    return { onRetry, onDiscard };
  };

  it('shows the waveform and the length with "Sending…" at once', async () => {
    await drawPending(pending);
    expect(q('voice-pending')).not.toBeNull();
    expect(text('voice-pending-length')).toBe('0:07');
    expect(host.querySelector('.send-state')?.textContent).toBe('Sending…');
    expect(q('voice-writing')).toBeNull();
  });

  it('a sending row that continues the run has no name or picture, as the delivered message will (P32-11)', async () => {
    await act(async () => {
      root.render(createElement(PendingRow, { pending, name: 'Nadia', continued: true, onRetry: vi.fn(), onDiscard: vi.fn() }));
    });
    expect(host.querySelector('.msg')?.classList.contains('run')).toBe(true);
    expect(host.querySelector('.msg > .av, .msg > .av-wrap')).toBeNull();
    expect(host.querySelector('.who b:not(.sr-only)')).toBeNull();
    expect(q('voice-pending')).not.toBeNull();
    await drawPending(pending);
    expect(host.querySelector('.msg')?.classList.contains('run')).toBe(false);
    expect(host.querySelector('.who b')).not.toBeNull();
  });

  it('draws no picture or file card under the voice row, whatever is attached to it', async () => {
    const withFile = { ...pending, attachments: [{ id: FILE, name: 'voice.webm', size: 40, mime: 'audio/webm' }, { id: uuid(501), name: 'shot.png', size: 9, mime: 'image/png' }] };
    await drawPending(withFile as unknown as typeof pending);
    expect(q('voice-pending')).not.toBeNull();
    expect(host.querySelector('.atts')).toBeNull();
    expect(host.querySelector('img')).toBeNull();
  });

  it('a failed one offers Try again and Delete; Delete asks first and throws the clip away', async () => {
    const { onRetry, onDiscard } = await drawPending({ ...pending, status: 'failed' });
    const buttons = [...host.querySelectorAll('.send-state button')].map((b) => b.textContent);
    expect(buttons).toEqual(['Try again', 'Delete']);
    await act(async () => (host.querySelectorAll('.send-state button')[0] as HTMLElement).click());
    expect(onRetry).toHaveBeenCalledOnce();
    await act(async () => (host.querySelectorAll('.send-state button')[1] as HTMLElement).click());
    expect(host.querySelector('.send-state')?.textContent).toContain('Throw this voice message away? The recording is lost.');
    expect(onDiscard).not.toHaveBeenCalled();
    await act(async () => ([...host.querySelectorAll('.send-state button')].find((b) => b.textContent === 'Yes, delete') as HTMLElement).click());
    expect(onDiscard).toHaveBeenCalledOnce();
  });
});
