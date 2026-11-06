import type { FileSummary, VoiceMeta } from '@manythreads/shared';

/*
 * The pure parts of the voice-message player (P14-17): how a time reads, how many bars the waveform draws and how tall, what the keys do,
 * and which attachment of a message is the clip. No React and no browser objects, so each rule has a plain unit test.
 */

/** Bars in the waveform; a phone narrower than 360 px hides every second one in CSS. */
export const BAR_COUNT = 64;
/** How far the arrow keys move the position. */
export const SEEK_STEP_MS = 5_000;
/** The speeds the speed button goes through, in order. */
export const SPEEDS: readonly number[] = [1, 1.5, 2];

/** `0:07`, `1:05`, `12:00`: minutes and seconds, seconds always two digits; negative or broken values read as `0:00`. */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  return `${Math.floor(total / 60)}:${s < 10 ? '0' : ''}${s}`;
}

/** What a screen reader says for the slider: `0:12 of 0:42`. */
export function valueText(positionMs: number, durationMs: number): string {
  return `${formatClock(positionMs)} of ${formatClock(durationMs)}`;
}

/** Keeps a position inside the clip. */
export function clampPosition(ms: number, durationMs: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(Math.max(0, ms), Math.max(0, durationMs));
}

/** The position `deltaMs` away from `positionMs`, kept inside the clip. */
export function seekBy(positionMs: number, deltaMs: number, durationMs: number): number {
  return clampPosition(positionMs + deltaMs, durationMs);
}

/** The position a press at `fraction` (0 to 1) of the waveform's width means. */
export function positionAt(fraction: number, durationMs: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return clampPosition(Math.round(Math.min(1, Math.max(0, fraction)) * durationMs), durationMs);
}

/** The key's effect on the position, or null when the key is not a seek key. */
export function seekForKey(key: string, positionMs: number, durationMs: number): number | null {
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return seekBy(positionMs, -SEEK_STEP_MS, durationMs);
    case 'ArrowRight':
    case 'ArrowUp':
      return seekBy(positionMs, SEEK_STEP_MS, durationMs);
    case 'Home':
      return 0;
    case 'End':
      return durationMs;
    default:
      return null;
  }
}

/** The speed after `speed` (1 to 1.5 to 2, then back to 1); an unknown value starts again at 1. */
export function nextSpeed(speed: number): number {
  const at = SPEEDS.indexOf(speed);
  return at < 0 ? 1 : (SPEEDS[(at + 1) % SPEEDS.length] ?? 1);
}

/** `1×`, `1.5×`, `2×`. */
export const speedLabel = (speed: number): string => `${speed}×`;

/** The speed button's spoken label: `Playback speed 1.5 times`. */
export const speedAria = (speed: number): string => `Playback speed ${speed} times`;

/**
 * The waveform's `count` bar heights, 0 to 1. The recorded loudness values (0 to 255) are cut into `count` equal windows and each bar takes the
 * loudest of its window, so a short list is stretched and a long one squeezed. A bar is never below a small floor (silence still draws a stub);
 * a clip with no values at all draws an even row.
 */
export function barHeights(peaks: readonly number[], count: number = BAR_COUNT): number[] {
  const floor = 0.12;
  if (count <= 0) return [];
  if (peaks.length === 0) return Array.from({ length: count }, () => 0.3);
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
    let top = 0;
    for (let j = from; j < Math.min(to, peaks.length); j += 1) top = Math.max(top, peaks[j] ?? 0);
    return floor + (1 - floor) * (Math.min(255, Math.max(0, top)) / 255);
  });
}

/** How many of the `count` bars are already played at `positionMs`. */
export function playedBars(positionMs: number, durationMs: number, count: number = BAR_COUNT): number {
  if (durationMs <= 0) return 0;
  return Math.min(count, Math.max(0, Math.floor((positionMs / durationMs) * count + 1e-9)));
}

/** The voice clip of a message: the voice record and the attached file it names, or null when the file is not among the attachments. */
export function voiceClip(voice: VoiceMeta | undefined, attachments: readonly FileSummary[] | undefined): { voice: VoiceMeta; file: FileSummary } | null {
  if (!voice) return null;
  const file = (attachments ?? []).find((f) => f.id === voice.fileId);
  return file ? { voice, file } : null;
}

/** The attachments without the clip: the player draws it, so no file card is drawn for it. */
export function withoutClip(attachments: readonly FileSummary[] | undefined, clip: { file: FileSummary } | null): FileSummary[] {
  return (attachments ?? []).filter((f) => f.id !== clip?.file.id);
}

/** The language of a transcript in words (`en` is English); null when none is known or the browser cannot name it. */
export function languageName(code: string | null): string | null {
  if (!code) return null;
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? null;
  } catch {
    return null;
  }
}

/** The line under a voice message's player that says where its text came from, or null when there is no text to explain. */
export function transcriptNote(voice: VoiceMeta): string | null {
  if (voice.transcript === 'none') return null;
  const language = languageName(voice.language);
  const what = language ? `Transcript in ${language}` : 'Transcript';
  return voice.transcript === 'device' ? `${what}, written on the sender's device` : `${what}, corrected by hand`;
}

/** The words of a search hit that is a voice message with no transcript (`Voice message (0:42)`), as its length (`0:42`); else null. */
export function voiceHitLength(snippet: string): string | null {
  const m = /^Voice message \((\d{1,2}:\d{2})\)$/.exec(snippet.trim());
  return m?.[1] ?? null;
}
