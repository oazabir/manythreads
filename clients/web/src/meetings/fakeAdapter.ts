import type { MeetingJoin } from '@manythreads/shared';
import type { AdapterEvents, AudioOptions, DeviceLists, MediaAdapter } from './media';

/*
 * An in-memory room for the unit tests and the browser tests (the server's `fake` media provider hands out tokens for it). It records what the page asked of the
 * media layer and lets a test play the network and the other people: speakers, a drop, a return, a lost connection, a refused microphone.
 */

export interface FakeAdapter extends MediaAdapter {
  readonly joins: MeetingJoin[];
  readonly state: { connected: boolean; micOn: boolean; deafened: boolean; inputId: string | null; outputId: string | null; options: AudioOptions | null };
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
  const state: FakeAdapter['state'] = { connected: false, micOn: false, deafened: false, inputId: null, outputId: null, options: null };
  const adapter: FakeAdapter = {
    joins: [],
    state,
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
    async connect(join, options, ev) {
      if (failConnect !== null) {
        const message = failConnect;
        failConnect = null;
        throw new Error(message);
      }
      events = ev;
      adapter.joins.push(join);
      state.connected = true;
      state.options = options;
      state.inputId = options.inputId;
      state.outputId = options.outputId;
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
      events = null;
    },
  };
  control.adapters.push(adapter);
  if (typeof window !== 'undefined') (window as unknown as { __manythreadsFakeMedia?: FakeControl }).__manythreadsFakeMedia = control;
  return adapter;
}
