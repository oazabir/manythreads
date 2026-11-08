import type { MeetingConsent, MeetingTranscriptLine } from '@manythreads/shared';

// The transcript as a reader sees it (PLAN P15-05). One rule decides what a reader may see of a line: the speaker's answer to "Transcribe my voice" NOW. A speaker who
// is not a "yes" (said no, or never answered) is shown only as "<name> spoke (not transcribed)" with the times of the stretch they spoke; their words are never part
// of the answer, even if some were stored before they answered no (the database blanks those too when they answer; this is the second guard). The same function feeds
// the live captions and the transcript file, so a rule changed here changes both.

export interface SegmentFacts {
  /** The stored line's id; absent for a line that is not stored (a test's, a caption's). */
  id?: string;
  speakerId: string;
  startMs: number;
  endMs: number;
  text: string;
  final: boolean;
}

export interface SpeakerFacts {
  displayName: string;
  consent: MeetingConsent;
}

/** Stretches of a silent speaker closer together than this are one "spoke (not transcribed)" line. */
export const PLACEHOLDER_MERGE_GAP_MS = 5_000;

export const notTranscribedText = (name: string): string => `${name} spoke (not transcribed)`;

/** Orders by start time (then end time, then speaker, so the order never depends on how rows came out of the database). */
const byTime = (a: SegmentFacts, b: SegmentFacts): number => a.startMs - b.startMs || a.endMs - b.endMs || (a.speakerId < b.speakerId ? -1 : a.speakerId > b.speakerId ? 1 : 0);

export function renderTranscript(segments: readonly SegmentFacts[], speakers: ReadonlyMap<string, SpeakerFacts>): MeetingTranscriptLine[] {
  const lines: MeetingTranscriptLine[] = [];
  for (const s of [...segments].filter((x) => x.final).sort(byTime)) {
    const who = speakers.get(s.speakerId);
    const name = who?.displayName ?? 'Someone';
    if (who?.consent === 'yes') {
      const text = s.text.trim();
      if (text === '') continue;
      lines.push({
        segmentId: (s.id ?? null) as MeetingTranscriptLine['segmentId'],
        speakerId: s.speakerId as MeetingTranscriptLine['speakerId'],
        speakerName: name,
        startMs: s.startMs,
        endMs: Math.max(s.endMs, s.startMs),
        text,
        transcribed: true,
        editable: false,
      });
      continue;
    }
    const last = lines.at(-1);
    if (last && !last.transcribed && last.speakerId === s.speakerId && s.startMs - last.endMs <= PLACEHOLDER_MERGE_GAP_MS) {
      last.endMs = Math.max(last.endMs, s.endMs);
      continue;
    }
    lines.push({
      segmentId: null,
      speakerId: s.speakerId as MeetingTranscriptLine['speakerId'],
      speakerName: name,
      startMs: s.startMs,
      endMs: Math.max(s.endMs, s.startMs),
      text: notTranscribedText(name),
      transcribed: false,
      editable: false,
    });
  }
  return lines;
}
