import type { MeetingJoin } from '@manythreads/shared';
import type { ConnectionQuality } from './layout';

/*
 * The seam between the room and the media library (PLAN P15-04). The call controller talks to a `MediaAdapter`; which one it gets depends on the provider
 * named in the join token: `livekit` loads the real library (lazily, so the app's main bundle does not carry it), `fake` is an in-memory room used by the unit
 * tests and the browser tests. Nothing outside `livekitAdapter.ts` imports the library.
 */

export type Connection = 'connected' | 'reconnecting' | 'disconnected';

export type DeviceInfo = { id: string; label: string };
export type DeviceLists = { inputs: DeviceInfo[]; outputs: DeviceInfo[]; inputId: string | null; outputId: string | null };

/** What the adapter tells the controller. All of it is about the media connection; the roster (who is in the room) comes from the server. */
export type AdapterEvents = {
  connection(state: Connection, detail?: string): void;
  /** Actor ids of the people heard speaking right now (the media identity of a person is their actor id). */
  speakers(actorIds: string[]): void;
  /** The list of microphones or speakers changed (a headset was plugged in). */
  devices(): void;
  /** The microphone could not be opened (permission refused, no microphone). */
  micFailed(reason: string): void;
  /** The cameras and shared screens in the room changed (P35-08): one tile per person and source, this person's own included. */
  videos(tiles: VideoTile[]): void;
  /** How good this person's own connection to the media server is now (P17-01): a weak one gets "Audio only" suggested. */
  quality(q: ConnectionQuality): void;
};

/** A camera or a shared screen in the room (P35-08). `key` is what `attachVideo` takes. */
export type VideoSource = 'camera' | 'screen';
export type VideoTile = { key: string; actorId: string; source: VideoSource; local: boolean };

export type AudioOptions = {
  /** Always true: the browser's own echo cancellation, noise suppression and level control are on for the microphone. */
  echoCancellation: true;
  noiseSuppression: true;
  autoGainControl: true;
  inputId: string | null;
  outputId: string | null;
};

export const AUDIO_DEFAULTS: AudioOptions = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, inputId: null, outputId: null };

/** What the adapter connects with: a member's join (identity: their actor id) or a link guest's (identity: `guest:<id>`, P17-04). */
export type MediaJoin = Omit<MeetingJoin, 'identity'> & { identity: string };

export interface MediaAdapter {
  /**
   * Connects to the room with the join token. The microphone stays closed until `setMic(true)`. With `receiveVideo: false` (audio only, P17-01) the connection
   * takes only sound from the start: no video is subscribed, not even for a moment while joining.
   */
  connect(join: MediaJoin, options: AudioOptions, events: AdapterEvents, video?: { receiveVideo: boolean }): Promise<void>;
  /** Opens (true) or closes (false) the microphone. Opening may ask the person for permission and rejects if it is refused. */
  setMic(on: boolean): Promise<void>;
  /** Deafened: nothing of the room is played to the person. */
  setDeafened(on: boolean): void;
  devices(): Promise<DeviceLists>;
  useInput(deviceId: string): Promise<void>;
  useOutput(deviceId: string): Promise<void>;
  /** Turns this person's camera on or off (P35-08). Rejects when the camera is refused or in use. */
  setCamera(on: boolean): Promise<void>;
  /** Shares a screen, window or tab, with the tab's sound when the browser offers it (P35-08); off stops it. Rejects when the person cancels the picker. */
  setScreen(on: boolean): Promise<void>;
  /** Audio only (P17-01): false stops receiving other people's cameras and screens (and any that start later); true receives them again. */
  setReceiveVideo(on: boolean): void;
  /** Draws a tile's video in `el`; the returned function takes it off again. */
  attachVideo(key: string, el: HTMLVideoElement): () => void;
  disconnect(): Promise<void>;
}

/** Gets the adapter for a provider named in a join token. Rejects for a provider this page does not know. */
export type AdapterLoader = (provider: string) => Promise<MediaAdapter>;

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`This page cannot join a voice room that uses "${provider}".`);
    this.name = 'UnknownProviderError';
  }
}

export const loadAdapter: AdapterLoader = async (provider) => {
  if (provider === 'livekit') return (await import('./livekitAdapter')).createLivekitAdapter();
  if (provider === 'fake') return (await import('./fakeAdapter')).createFakeAdapter();
  throw new UnknownProviderError(provider);
};
