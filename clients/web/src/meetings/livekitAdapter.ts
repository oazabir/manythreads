import { Room, RoomEvent, Track, type Participant, type RemoteTrack } from 'livekit-client';
import type { MeetingJoin } from '@manythreads/shared';
import type { AdapterEvents, AudioOptions, DeviceInfo, DeviceLists, MediaAdapter, VideoTile } from './media';

/*
 * The real media adapter: livekit-client (pinned in package.json), loaded only when a person joins a room (media.ts imports this file lazily, so the library is a
 * chunk of its own). The microphone is asked for with the browser's echo cancellation, noise suppression and level control on. A camera and a shared screen
 * (P35-08) are tiles the page draws: this file reports which there are (`videos`) and attaches one to a `<video>` when asked.
 * What this file cannot show without a LiveKit server is listed in docs/plugins/meetings.md ("Only a live server shows").
 */

const toInfo = (d: MediaDeviceInfo, fallback: string): DeviceInfo => ({ id: d.deviceId, label: d.label !== '' ? d.label : fallback });

export function createLivekitAdapter(): MediaAdapter {
  let room: Room | null = null;
  let options: AudioOptions | null = null;
  let deafened = false;
  let inputId: string | null = null;
  let outputId: string | null = null;
  // the sound of each remote person plays from an element we keep, so deafening is one switch
  const sinks = new Map<string, HTMLMediaElement>();
  let holder: HTMLDivElement | null = null;
  let events: AdapterEvents | null = null;

  const SOURCES: ReadonlyArray<[Track.Source, VideoTile['source']]> = [
    [Track.Source.Camera, 'camera'],
    [Track.Source.ScreenShare, 'screen'],
  ];
  /** The video track of a tile key (`<identity>:<camera|screen>`), local or remote, when it is there and not muted. */
  const trackOf = (key: string) => {
    const r = room;
    if (!r) return undefined;
    const [identity, source] = key.split(':');
    const who: Participant | undefined = identity === r.localParticipant.identity ? r.localParticipant : r.remoteParticipants.get(identity ?? '');
    const lk = SOURCES.find(([, s]) => s === source)?.[0];
    if (!who || lk === undefined) return undefined;
    const pub = who.getTrackPublication(lk);
    return pub && !pub.isMuted ? pub.track : undefined;
  };
  /** Every camera and screen in the room now, this person's first. */
  const tiles = (): VideoTile[] => {
    const r = room;
    if (!r) return [];
    const out: VideoTile[] = [];
    for (const p of [r.localParticipant, ...r.remoteParticipants.values()] as Participant[]) {
      for (const [lk, source] of SOURCES) {
        const pub = p.getTrackPublication(lk);
        if (pub?.track && !pub.isMuted) out.push({ key: `${p.identity}:${source}`, actorId: p.identity, source, local: p === r.localParticipant });
      }
    }
    return out;
  };
  const report = (): void => events?.videos(tiles());

  const attach = (track: RemoteTrack, key: string): void => {
    if (track.kind !== Track.Kind.Audio) return;
    const el = track.attach();
    el.muted = deafened;
    holder ??= makeHolder();
    holder.append(el);
    sinks.set(key, el);
  };
  const detach = (track: RemoteTrack, key: string): void => {
    if (track.kind !== Track.Kind.Audio) return;
    track.detach().forEach((el) => el.remove());
    sinks.delete(key);
  };

  return {
    async connect(join: MeetingJoin, audio: AudioOptions, ev: AdapterEvents): Promise<void> {
      options = audio;
      events = ev;
      inputId = audio.inputId;
      outputId = audio.outputId;
      const r = new Room({
        // cameras and screens (P35-08): each viewer gets the size its tile shows, and a layer nobody watches is not sent
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: audio.echoCancellation,
          noiseSuppression: audio.noiseSuppression,
          autoGainControl: audio.autoGainControl,
          ...(audio.inputId ? { deviceId: audio.inputId } : {}),
        },
        ...(audio.outputId ? { audioOutput: { deviceId: audio.outputId } } : {}),
      });
      room = r;
      r.on(RoomEvent.ActiveSpeakersChanged, (speakers) => ev.speakers(speakers.map((s) => s.identity)));
      r.on(RoomEvent.Reconnecting, () => ev.connection('reconnecting'));
      r.on(RoomEvent.Reconnected, () => ev.connection('connected'));
      r.on(RoomEvent.Disconnected, (reason) => ev.connection('disconnected', reason === undefined ? undefined : String(reason)));
      r.on(RoomEvent.MediaDevicesChanged, () => ev.devices());
      r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        attach(track, `${participant.identity}:${track.sid}`);
        if (track.kind === Track.Kind.Video) report();
      });
      r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        detach(track, `${participant.identity}:${track.sid}`);
        if (track.kind === Track.Kind.Video) report();
      });
      r.on(RoomEvent.TrackMuted, report);
      r.on(RoomEvent.TrackUnmuted, report);
      r.on(RoomEvent.LocalTrackPublished, report);
      r.on(RoomEvent.LocalTrackUnpublished, report);
      r.on(RoomEvent.ParticipantDisconnected, report);
      r.on(RoomEvent.MediaDevicesError, (err) => ev.micFailed(err instanceof Error ? err.message : 'The microphone could not be opened.'));
      await r.connect(join.url, join.token, { autoSubscribe: true });
      // browsers hold audio back until the person has done something on the page: joining was that
      await r.startAudio().catch(() => undefined);
      ev.connection('connected');
    },

    async setMic(on: boolean): Promise<void> {
      if (!room) return;
      if (!on) {
        await room.localParticipant.setMicrophoneEnabled(false);
        return;
      }
      await room.localParticipant.setMicrophoneEnabled(true, {
        echoCancellation: options?.echoCancellation ?? true,
        noiseSuppression: options?.noiseSuppression ?? true,
        autoGainControl: options?.autoGainControl ?? true,
        ...(inputId ? { deviceId: inputId } : {}),
      });
    },

    async setCamera(on: boolean): Promise<void> {
      if (!room) return;
      await room.localParticipant.setCameraEnabled(on);
      report();
    },

    async setScreen(on: boolean): Promise<void> {
      if (!room) return;
      // the tab's sound goes with it when the browser offers it; this page itself is not offered (it would show itself, endlessly)
      await room.localParticipant.setScreenShareEnabled(on, on ? { audio: true, selfBrowserSurface: 'exclude', surfaceSwitching: 'include' } : undefined);
      report();
    },

    attachVideo(key: string, el: HTMLVideoElement): () => void {
      const track = trackOf(key);
      if (!track) return () => undefined;
      track.attach(el);
      return () => {
        track.detach(el);
      };
    },

    setDeafened(on: boolean): void {
      deafened = on;
      for (const el of sinks.values()) el.muted = on;
    },

    async devices(): Promise<DeviceLists> {
      // no permission prompt here: names appear once the microphone has been opened once
      const [ins, outs] = await Promise.all([Room.getLocalDevices('audioinput', false).catch(() => []), Room.getLocalDevices('audiooutput', false).catch(() => [])]);
      return {
        inputs: ins.map((d, i) => toInfo(d, `Microphone ${i + 1}`)),
        outputs: outs.map((d, i) => toInfo(d, `Speaker ${i + 1}`)),
        inputId: room?.getActiveDevice('audioinput') ?? inputId,
        outputId: room?.getActiveDevice('audiooutput') ?? outputId,
      };
    },

    async useInput(id: string): Promise<void> {
      inputId = id;
      if (room) await room.switchActiveDevice('audioinput', id);
    },

    async useOutput(id: string): Promise<void> {
      outputId = id;
      if (room) await room.switchActiveDevice('audiooutput', id);
    },

    async disconnect(): Promise<void> {
      const r = room;
      room = null;
      events = null;
      for (const el of sinks.values()) el.remove();
      sinks.clear();
      holder?.remove();
      holder = null;
      if (r) {
        r.removeAllListeners();
        await r.disconnect().catch(() => undefined);
      }
    },
  };
}

function makeHolder(): HTMLDivElement {
  const div = document.createElement('div');
  div.setAttribute('data-testid', 'call-audio');
  div.hidden = true;
  document.body.append(div);
  return div;
}
