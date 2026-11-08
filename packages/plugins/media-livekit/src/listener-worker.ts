// The listener's worker thread (PLAN P15-19, decision C13): joins one room with a hidden, subscribe-only token, subscribes to the audio of the people it is told to
// hear, cuts their speech into chunks at pauses and posts the chunks to the server thread. One thread per room, so a crash of the media library costs one room's
// note-taker and nothing else. `@livekit/rtc-node` (a native library) is loaded here and nowhere else, and only when a note-taker is added.
//
// It never publishes: this file does not use the library's publishing calls (a test reads this file's text for them), and the token it was given cannot publish.
// Loaded by Node itself, so it holds erasable TypeScript only.
import { parentPort, workerData } from 'node:worker_threads';
import { ListenerCore } from './listener-core.ts';

export interface WorkerInput {
  url: string;
  token: string;
  identities: string[];
}
// messages from the server thread:  { type: 'identities', identities } · { type: 'close' }
// messages to the server thread:    { type: 'ready' } · { type: 'subscriptions', identities } · { type: 'chunk', identity, samples, startedAtMs, durationMs }
//                                   · { type: 'closed', reason: 'closed' | 'room_ended' | 'error', message? }

if (!parentPort) throw new Error('listener-worker.ts is a worker thread');
const port = parentPort;
const input = workerData as WorkerInput;
const post = (message: Record<string, unknown>, transfer: ArrayBuffer[] = []): void => port.postMessage(message, transfer);

async function main(): Promise<void> {
  let lk: typeof import('@livekit/rtc-node');
  try {
    lk = await import('@livekit/rtc-node');
  } catch {
    post({ type: 'closed', reason: 'error', message: 'The audio library could not be loaded.' });
    return;
  }
  const room = new lk.Room();
  const publications = new Map<string, import('@livekit/rtc-node').RemoteTrackPublication>();
  let closing = false;
  let finished = false;

  const finish = (reason: 'closed' | 'room_ended' | 'error', message?: string): void => {
    if (finished) return;
    finished = true;
    post({ type: 'closed', reason, ...(message ? { message } : {}) });
  };

  const core = new ListenerCore(
    {
      setSubscribed(sid, on) {
        publications.get(sid)?.setSubscribed(on);
      },
    },
    {
      onChunk(c) {
        post({ type: 'chunk', identity: c.identity, samples: c.samples, startedAtMs: c.startedAtMs, durationMs: c.durationMs }, [c.samples.buffer as ArrayBuffer]);
      },
      onSubscriptions(identities) {
        post({ type: 'subscriptions', identities });
      },
    },
    { identities: input.identities },
  );

  const isVoice = (pub: import('@livekit/rtc-node').RemoteTrackPublication): boolean => pub.kind === lk.TrackKind.KIND_AUDIO && pub.source === lk.TrackSource.SOURCE_MICROPHONE;
  const seen = (pub: import('@livekit/rtc-node').RemoteTrackPublication, identity: string): void => {
    if (!isVoice(pub) || !pub.sid) return;
    publications.set(pub.sid, pub);
    core.trackPublished(identity, pub.sid);
  };

  room.on(lk.RoomEvent.TrackPublished, (pub, participant) => seen(pub, participant.identity));
  room.on(lk.RoomEvent.TrackUnpublished, (pub) => {
    if (!pub.sid) return;
    core.trackUnpublished(pub.sid);
    publications.delete(pub.sid);
  });
  room.on(lk.RoomEvent.TrackSubscribed, (track, pub, participant) => {
    if (!isVoice(pub) || !pub.sid) return;
    const stream = new lk.AudioStream(track, { sampleRate: 16_000, numChannels: 1 });
    core.trackSubscribed(participant.identity, pub.sid, {
      frames: (async function* () {
        for await (const frame of stream) yield frame.data;
      })(),
      cancel: () => {
        try {
          void stream.cancel().catch(() => undefined);
        } catch {
          // already closed
        }
      },
    });
  });
  room.on(lk.RoomEvent.TrackUnsubscribed, (_track, pub) => {
    if (pub.sid) core.trackUnsubscribed(pub.sid);
  });
  room.on(lk.RoomEvent.ParticipantDisconnected, (participant) => core.participantDisconnected(participant.identity));
  room.on(lk.RoomEvent.Disconnected, (reason) => {
    if (closing || reason === lk.DisconnectReason.CLIENT_INITIATED) return finish('closed');
    void core.close().then(() => finish(reason === lk.DisconnectReason.ROOM_DELETED || reason === lk.DisconnectReason.ROOM_CLOSED ? 'room_ended' : 'error'));
  });

  port.on('message', (m: { type: string; identities?: string[] }) => {
    if (m.type === 'identities' && Array.isArray(m.identities)) core.setIdentities(m.identities);
    if (m.type === 'close') {
      closing = true;
      void (async () => {
        try {
          await core.close();
          await room.disconnect();
          await lk.dispose();
        } catch {
          // closing: nothing more to do
        }
        finish('closed');
      })();
    }
  });

  try {
    // no automatic subscription: the core subscribes to the listed people's microphones one by one
    await room.connect(input.url, input.token, { autoSubscribe: false, dynacast: false });
  } catch {
    finish('error', 'The note-taker could not join the room.');
    return;
  }
  for (const participant of room.remoteParticipants.values()) {
    for (const pub of participant.trackPublications.values()) seen(pub, participant.identity);
  }
  post({ type: 'ready' });
}

main().catch(() => {
  port.postMessage({ type: 'closed', reason: 'error', message: 'The note-taker stopped.' });
});
