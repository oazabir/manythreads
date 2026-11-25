import type { ConnectionQuality } from './layout';
import type { AdapterEvents, AudioOptions, DeviceLists, MediaAdapter, MediaJoin, VideoTile } from './media';

/*
 * An in-memory room for the unit tests and the browser tests (the server's `fake` media provider hands out tokens for it). It records what the page asked of the
 * media layer and lets a test play the network and the other people: speakers, a drop, a return, a lost connection, a refused microphone.
 */

export interface FakeAdapter extends MediaAdapter {
  readonly joins: MediaJoin[];
  readonly state: { connected: boolean; micOn: boolean; deafened: boolean; cameraOn: boolean; screenOn: boolean; receiveVideo: boolean; inputId: string | null; outputId: string | null; options: AudioOptions | null };
  /** Another person turned a camera or a screen on or off (P35-08). */
  remoteVideo(actorId: string, source: VideoTile['source'], on: boolean): void;
  /** What `connect` was told about video (P17-01): false when the call joined in audio only. */
  readonly joinedReceivingVideo: boolean | null;
  /** This person's connection got better or worse (P17-01). */
  quality(q: ConnectionQuality): void;
  /** Make the next `setScreen(true)` fail like a cancelled picker (once). */
  cancelScreenPicker(): void;
  /** Tile keys a `<video>` was attached to and not detached yet. */
  readonly attached: Set<string>;
  /** Make the next `connect` fail with this message (once). */
  failNextConnect(message: string): void;
  /** Make the next `setMic(true)` fail like a refused permission (once). */
  refuseMicrophone(): void;
  speak(actorIds: string[]): void;
  /** The network went away: the library tries to get back by itself. */
  drop(): void;
  /** It did. */
  recover(): void;
  /** The library gave up. */
  lose(): void;
  plug(devices: DeviceLists): void;
}

export interface FakeControl {
  readonly adapters: FakeAdapter[];
  last(): FakeAdapter | undefined;
}

const control: FakeControl = {
  adapters: [],
  last() {
    return this.adapters.at(-1);
  },
};

/** Every fake adapter made in this page, for a browser test to reach through `window.__manythreadsFakeMedia`. */
export const fakeMedia = control;

export function createFakeAdapter(): FakeAdapter {
  let events: AdapterEvents | null = null;
  let failConnect: string | null = null;
  let refuseMic = false;
  let cancelScreen = false;
  let me = '';
  const remote = new Map<string, VideoTile>();
  const tiles = (): VideoTile[] => [
    ...(state.cameraOn ? [{ key: `${me}:camera`, actorId: me, source: 'camera' as const, local: true }] : []),
    ...(state.screenOn ? [{ key: `${me}:screen`, actorId: me, source: 'screen' as const, local: true }] : []),
    // audio only: other people's video is not received
    ...(state.receiveVideo ? remote.values() : []),
  ];
  const report = (): void => events?.videos(tiles());
  let devices: DeviceLists = {
    inputs: [
      { id: 'mic-built-in', label: 'Built-in microphone' },
      { id: 'mic-headset', label: 'Headset microphone' },
    ],
    outputs: [
      { id: 'out-built-in', label: 'Built-in speakers' },
      { id: 'out-headset', label: 'Headset' },
    ],
    inputId: 'mic-built-in',
    outputId: 'out-built-in',
  };
  const state: FakeAdapter['state'] = { connected: false, micOn: false, deafened: false, cameraOn: false, screenOn: false, receiveVideo: true, inputId: null, outputId: null, options: null };
  const adapter: FakeAdapter = {
    joins: [],
    joinedReceivingVideo: null,
    state,
    attached: new Set<string>(),
    remoteVideo(actorId, source, on) {
      const key = `${actorId}:${source}`;
      if (on) remote.set(key, { key, actorId, source, local: false });
      else remote.delete(key);
      report();
    },
    quality(q) {
      events?.quality(q);
    },
    setReceiveVideo(on) {
      state.receiveVideo = on;
      report();
    },
    cancelScreenPicker() {
      cancelScreen = true;
    },
    failNextConnect(message) {
      failConnect = message;
    },
    refuseMicrophone() {
      refuseMic = true;
    },
    speak(ids) {
      events?.speakers(ids);
    },
    drop() {
      events?.connection('reconnecting');
    },
    recover() {
      events?.connection('connected');
    },
    lose() {
      state.connected = false;
      events?.connection('disconnected', 'the connection was lost');
    },
    plug(next) {
      devices = next;
      events?.devices();
    },
    async connect(join, options, ev, video) {
      if (failConnect !== null) {
        const message = failConnect;
        failConnect = null;
        throw new Error(message);
      }
      events = ev;
      me = join.identity;
      adapter.joins.push(join);
      state.connected = true;
      state.options = options;
      state.inputId = options.inputId;
      state.outputId = options.outputId;
      state.receiveVideo = video?.receiveVideo ?? true;
      (adapter as { joinedReceivingVideo: boolean | null }).joinedReceivingVideo = state.receiveVideo;
      ev.connection('connected');
    },
    async setMic(on) {
      if (on && refuseMic) {
        refuseMic = false;
        events?.micFailed('The microphone is blocked.');
        throw new Error('The microphone is blocked.');
      }
      state.micOn = on;
    },
    setDeafened(on) {
      state.deafened = on;
    },
    async setCamera(on) {
      state.cameraOn = on;
      report();
    },
    async setScreen(on) {
      if (on && cancelScreen) {
        cancelScreen = false;
        const err = new Error('Permission denied');
        err.name = 'NotAllowedError';
        throw err;
      }
      state.screenOn = on;
      report();
    },
    attachVideo(key) {
      adapter.attached.add(key);
      return () => adapter.attached.delete(key);
    },
    async devices() {
      return { ...devices, inputId: state.inputId ?? devices.inputId, outputId: state.outputId ?? devices.outputId };
    },
    async useInput(id) {
      state.inputId = id;
    },
    async useOutput(id) {
      state.outputId = id;
    },
    async disconnect() {
      state.connected = false;
      state.micOn = false;
      state.cameraOn = false;
      state.screenOn = false;
      state.receiveVideo = true;
      remote.clear();
      events = null;
    },
  };
  control.adapters.push(adapter);
  if (typeof window !== 'undefined') (window as unknown as { __manythreadsFakeMedia?: FakeControl }).__manythreadsFakeMedia = control;
  return adapter;
}
