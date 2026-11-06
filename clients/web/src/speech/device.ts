/*
 * The device check: which Whisper model a device can carry, or that it is too weak to write out voice messages.
 * The thresholds live in one table, DEVICE_TABLE, so the speech spike (docs/spikes/speech.md) can move them in one place.
 */
import type { WhisperModelName } from './types';

export const DEVICE_TABLE = {
  /** The larger model needs a graphics-card adapter (WebGPU) and at least this much memory, in GB as the browser reports it (capped at 8). */
  baseMinMemoryGb: 4,
  /** The smaller model needs this many processor threads... */
  tinyMinCores: 4,
  /** ...and this much memory, when the browser tells (Safari and Firefox do not; unknown passes). */
  tinyMinMemoryGb: 2,
  /** A phone-sized screen with a touch pointer never goes above the small model. */
  phoneMaxWidth: 768,
} as const;

export const TOO_WEAK_REASON = 'This device is too slow to write out voice messages.';

/** What the check looks at; plain values so a test can hand in any device. */
export interface DeviceFacts {
  webgpu: boolean;
  /** `navigator.deviceMemory` in GB, or null when the browser does not say. */
  memoryGb: number | null;
  cores: number;
  phone: boolean;
}

export type ModelChoice = { model: WhisperModelName; reason?: undefined } | { model: null; reason: string };

export function chooseModel(f: DeviceFacts): ModelChoice {
  if (f.webgpu && !f.phone && f.memoryGb !== null && f.memoryGb >= DEVICE_TABLE.baseMinMemoryGb) return { model: 'base' };
  const memoryOk = f.memoryGb === null || f.memoryGb >= DEVICE_TABLE.tinyMinMemoryGb;
  if (f.cores >= DEVICE_TABLE.tinyMinCores && memoryOk) return { model: 'tiny' };
  return { model: null, reason: TOO_WEAK_REASON };
}

/** The slice of the browser the facts come from. */
export interface DeviceEnv {
  navigator?: {
    deviceMemory?: number;
    hardwareConcurrency?: number;
    gpu?: { requestAdapter(): Promise<unknown> };
  };
  innerWidth?: number;
  matchMedia?: (query: string) => { matches: boolean };
}

async function hasWebGpu(nav: DeviceEnv['navigator']): Promise<boolean> {
  if (!nav?.gpu) return false;
  try {
    return (await nav.gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

export async function readDeviceFacts(env: DeviceEnv = globalThis as unknown as DeviceEnv): Promise<DeviceFacts> {
  const nav = env.navigator;
  const coarse = env.matchMedia?.('(pointer: coarse)').matches ?? false;
  const width = env.innerWidth ?? Number.POSITIVE_INFINITY;
  return {
    webgpu: await hasWebGpu(nav),
    memoryGb: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : null,
    cores: nav?.hardwareConcurrency ?? 1,
    phone: coarse && width < DEVICE_TABLE.phoneMaxWidth,
  };
}

/** Whether the pieces the real engine stands on (a worker and audio decoding) exist at all. */
export function hasSpeechPlatform(g: object = globalThis): boolean {
  const w = g as { Worker?: unknown; AudioContext?: unknown; webkitAudioContext?: unknown };
  return typeof w.Worker !== 'undefined' && (typeof w.AudioContext !== 'undefined' || typeof w.webkitAudioContext !== 'undefined');
}
