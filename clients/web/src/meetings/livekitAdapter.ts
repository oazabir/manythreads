import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import type { MeetingJoin } from '@manythreads/shared';
import type { AdapterEvents, AudioOptions, DeviceInfo, DeviceLists, MediaAdapter } from './media';

/*
 * The real media adapter: livekit-client (pinned in package.json), loaded only when a person joins a room (media.ts imports this file lazily, so the library is a
 * chunk of its own). Voice only: no camera, no screen. The microphone is asked for with the browser's echo cancellation, noise suppression and level control on.
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
      inputId = audio.inputId;
      outputId = audio.outputId;
      const r = new Room({
        // voice only: nothing to adapt, nothing to simulcast
        adaptiveStream: false,
        dynacast: false,
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
      r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => attach(track, `${participant.identity}:${track.sid}`));
      r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => detach(track, `${participant.identity}:${track.sid}`));
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
