import type { MeetingJoin } from '@manythreads/shared';

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
};

export type AudioOptions = {
  /** Always true: the browser's own echo cancellation, noise suppression and level control are on for the microphone. */
  echoCancellation: true;
  noiseSuppression: true;
  autoGainControl: true;
  inputId: string | null;
  outputId: string | null;
};

export const AUDIO_DEFAULTS: AudioOptions = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, inputId: null, outputId: null };

export interface MediaAdapter {
  /** Connects to the room with the join token. The microphone stays closed until `setMic(true)`. */
  connect(join: MeetingJoin, options: AudioOptions, events: AdapterEvents): Promise<void>;
  /** Opens (true) or closes (false) the microphone. Opening may ask the person for permission and rejects if it is refused. */
  setMic(on: boolean): Promise<void>;
  /** Deafened: nothing of the room is played to the person. */
  setDeafened(on: boolean): void;
  devices(): Promise<DeviceLists>;
  useInput(deviceId: string): Promise<void>;
  useOutput(deviceId: string): Promise<void>;
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
