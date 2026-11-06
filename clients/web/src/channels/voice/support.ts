/**
 * What the recorder needs from the browser, as plain functions with the browser objects passed in (so each rule has a unit test):
 * whether recording can work at all, which container to ask for, what to call the file, and the sentence for each way the microphone fails.
 */

/** Containers to ask MediaRecorder for, best first: Opus in WebM (Chrome, Edge, Firefox), then MP4 (Safari), then Ogg. */
export const MIME_CANDIDATES: readonly string[] = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

/** The first container the browser can record, or undefined to let it choose. */
export function pickMimeType(isTypeSupported: ((type: string) => boolean) | undefined): string | undefined {
  if (!isTypeSupported) return undefined;
  return MIME_CANDIDATES.find((t) => {
    try {
      return isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/** `audio/webm;codecs=opus` -> `audio/webm`. The upload declares the plain type; the server keeps it when the bytes are that container. */
export const baseMime = (type: string): string => (type.split(';')[0] ?? '').trim().toLowerCase();

/** The type to upload for what MediaRecorder produced: audio only (a browser that reports `video/webm` for a voice clip still means audio). */
export function clipMime(recorded: string): string {
  const base = baseMime(recorded);
  if (base === 'video/webm') return 'audio/webm';
  if (base === 'video/mp4') return 'audio/mp4';
  return base.startsWith('audio/') ? base : 'audio/webm';
}

export function clipFileName(mime: string, at: Date = new Date()): string {
  const ext = mime === 'audio/mp4' ? 'm4a' : mime === 'audio/ogg' ? 'ogg' : 'webm';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `voice-message-${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}.${ext}`;
}

/** The slice of the browser the check reads. */
export type RecorderEnv = {
  hasMediaRecorder: boolean;
  hasGetUserMedia: boolean;
  isSecureContext: boolean;
};

export function readRecorderEnv(): RecorderEnv {
  const g = globalThis as unknown as { MediaRecorder?: unknown; navigator?: { mediaDevices?: { getUserMedia?: unknown } }; isSecureContext?: boolean };
  return {
    hasMediaRecorder: typeof g.MediaRecorder === 'function',
    hasGetUserMedia: typeof g.navigator?.mediaDevices?.getUserMedia === 'function',
    isSecureContext: g.isSecureContext === true,
  };
}

/** Whether the mic button is offered at all: a browser that cannot record (or a page that is not https) never shows a button that cannot work. */
export const recorderSupported = (env: RecorderEnv = readRecorderEnv()): boolean => env.hasMediaRecorder && env.hasGetUserMedia && env.isSecureContext;

export const BLOCKED_TEXT = "Your browser blocked the microphone. Allow it in the address bar's site settings, then try again.";
export const NO_MIC_TEXT = 'No microphone was found on this device.';
export const BUSY_TEXT = 'The microphone is in use by another app. Close it there, then try again.';
export const FAILED_TEXT = 'The microphone could not be started.';
export const TOO_SHORT_TEXT = 'That was too short. Hold the button a little longer, or tap it to start and tap it again to stop.';
export const LOST_TEXT = 'The recording stopped because the microphone was lost.';
export const ALLOWED_TEXT = 'The microphone is allowed now. Press the button again to record.';

/** The one sentence for a failed `getUserMedia` (by the error's name, which is all browsers agree on). */
export function micErrorText(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return BLOCKED_TEXT;
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return NO_MIC_TEXT;
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return BUSY_TEXT;
    default:
      return FAILED_TEXT;
  }
}
