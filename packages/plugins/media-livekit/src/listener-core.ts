// The decisions of the note-taker's listener, apart from the LiveKit library, so they can be tested without a media server (PLAN P15-19). It runs inside the
// listener's worker thread (listener-worker.ts holds the LiveKit glue) and is loaded by Node itself, so it uses erasable TypeScript only: no enums, no parameter
// properties.
//
// The rules, in one place:
//  * A track is subscribed only when its owner is on the list of people to hear. A track of anyone else is never subscribed; if the library hands one over anyway
//    (a race with a list change) it is unsubscribed at once and not one sample of it is read.
//  * When the list changes, a person who left it loses their track at once, and whatever of their speech was buffered is thrown away (not sent): somebody who
//    withdrew consent must not have a last sentence transcribed.
//  * The audio is cut into chunks at pauses by the pure detector in the SDK and handed on. This file never publishes anything; the host it talks to has no way to.
import { createVadSegmenter } from '@manythreads/sdk/audio/vad';
import type { VadOptions, VadSegmenter } from '@manythreads/sdk/audio/vad';

/** What the core may do to the media library: subscribe or unsubscribe one remote audio track. There is deliberately no way to publish. */
export interface CoreHost {
  setSubscribed(trackSid: string, subscribed: boolean): void;
}

/** The samples of one subscribed track (16 kHz, mono, 16-bit), and the way to stop reading them. */
export interface CoreTrackStream {
  frames: AsyncIterable<Int16Array>;
  cancel(): void;
}

export interface CoreChunk {
  identity: string;
  samples: Int16Array;
  /** Wall clock (milliseconds since 1970) at which the person started speaking. */
  startedAtMs: number;
  durationMs: number;
}

export interface CoreEvents {
  onChunk(chunk: CoreChunk): void;
  /** The people whose audio is subscribed and being read changed. */
  onSubscriptions(identities: string[]): void;
}

interface Active {
  identity: string;
  sid: string;
  stream: CoreTrackStream;
  vad: VadSegmenter;
  stopped: boolean;
  done: Promise<void>;
}

export class ListenerCore {
  private host: CoreHost;
  private events: CoreEvents;
  private vadOptions: VadOptions;
  private now: () => number;
  private allowed: Set<string>;
  // every audio track the room has told us about: track id to its owner
  private published: Map<string, string> = new Map();
  private active: Map<string, Active> = new Map();
  private last: string = '';

  constructor(host: CoreHost, events: CoreEvents, options: { identities: readonly string[]; vad?: VadOptions; now?: () => number }) {
    this.host = host;
    this.events = events;
    this.vadOptions = options.vad ?? {};
    this.now = options.now ?? (() => Date.now());
    this.allowed = new Set(options.identities);
  }

  /** The identities with a track being read right now. */
  subscriptions(): string[] {
    return [...new Set([...this.active.values()].map((a) => a.identity))].sort();
  }

  /** Replace the list of people to hear. */
  setIdentities(identities: readonly string[]): void {
    this.allowed = new Set(identities);
    for (const [sid, a] of [...this.active]) {
      if (!this.allowed.has(a.identity)) this.drop(sid, a, false);
    }
    for (const [sid, identity] of this.published) {
      if (this.allowed.has(identity) && !this.active.has(sid)) this.host.setSubscribed(sid, true);
      else if (!this.allowed.has(identity)) this.host.setSubscribed(sid, false);
    }
    this.report();
  }

  /** A remote audio track exists (published, or seen when we joined). */
  trackPublished(identity: string, trackSid: string): void {
    this.published.set(trackSid, identity);
    if (this.allowed.has(identity)) this.host.setSubscribed(trackSid, true);
  }

  trackUnpublished(trackSid: string): void {
    this.published.delete(trackSid);
    const a = this.active.get(trackSid);
    if (a) this.drop(trackSid, a, true);
    this.report();
  }

  /** The library started delivering a track. Starts reading it if (and only if) its owner is on the list. */
  trackSubscribed(identity: string, trackSid: string, stream: CoreTrackStream): void {
    this.published.set(trackSid, identity);
    if (!this.allowed.has(identity)) {
      // not on the list: a race, or a track we never asked for. Not read, not kept.
      stream.cancel();
      this.host.setSubscribed(trackSid, false);
      return;
    }
    const old = this.active.get(trackSid);
    if (old) this.drop(trackSid, old, true);
    const a: Active = { identity, sid: trackSid, stream, vad: createVadSegmenter(this.vadOptions, 0), stopped: false, done: Promise.resolve() };
    a.done = this.read(a);
    this.active.set(trackSid, a);
    this.report();
  }

  /** The library stopped delivering a track (the person muted, left or was dropped): what they had said so far is sent. */
  trackUnsubscribed(trackSid: string): void {
    const a = this.active.get(trackSid);
    if (a) this.drop(trackSid, a, true);
    this.report();
  }

  participantDisconnected(identity: string): void {
    for (const [sid, id] of [...this.published]) {
      if (id !== identity) continue;
      this.published.delete(sid);
      const a = this.active.get(sid);
      if (a) this.drop(sid, a, true);
    }
    this.report();
  }

  /** Stop everything. Speech still buffered from people on the list is sent; then the returned promise resolves when every reader has ended. */
  async close(): Promise<void> {
    const all = [...this.active];
    for (const [sid, a] of all) this.drop(sid, a, true);
    this.report();
    await Promise.all(all.map(([, a]) => a.done));
  }

  /** Stop one track. `flush`: send the speech buffered so far (when the person is still on the list) instead of throwing it away. */
  private drop(sid: string, a: Active, flush: boolean): void {
    if (a.stopped) return;
    a.stopped = true;
    this.active.delete(sid);
    if (flush && this.allowed.has(a.identity)) this.emit(a, a.vad.flush(), a.vad.positionMs());
    else a.vad.discard();
    a.stream.cancel();
    if (!this.allowed.has(a.identity)) this.host.setSubscribed(sid, false);
  }

  private async read(a: Active): Promise<void> {
    try {
      for await (const samples of a.stream.frames) {
        if (a.stopped || !this.allowed.has(a.identity)) break;
        const chunks = a.vad.push(samples);
        if (chunks.length > 0) this.emit(a, chunks, a.vad.positionMs());
      }
    } catch {
      // the track ended badly; treat it as ended
    }
    if (!a.stopped) {
      a.stopped = true;
      if (this.active.get(a.sid) === a) this.active.delete(a.sid);
      if (this.allowed.has(a.identity)) this.emit(a, a.vad.flush(), a.vad.positionMs());
      this.report();
    }
  }

  private emit(a: Active, chunks: ReadonlyArray<{ samples: Int16Array; startMs: number; durationMs: number }>, positionMs: number): void {
    if (!this.allowed.has(a.identity)) return;
    const wall = this.now();
    for (const c of chunks) {
      // the chunk ended `positionMs - startMs - durationMs` before the end of what has been read, which is about now
      this.events.onChunk({ identity: a.identity, samples: c.samples, startedAtMs: wall - (positionMs - c.startMs), durationMs: c.durationMs });
    }
  }

  private report(): void {
    const now = this.subscriptions().join(',');
    if (now === this.last) return;
    this.last = now;
    this.events.onSubscriptions(this.subscriptions());
  }
}
