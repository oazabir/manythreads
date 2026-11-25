import type { MeetingReviewItem, MeetingTranscriptLine } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { linesForMark, markText, mergeItems, noteItemsForReview, replaceActionItems } from '../src/review.ts';

// The pure parts of Mark action item and the end-of-call review (P17-06 step 2): which lines a mark takes, its words, the merge of the notes' items and the marks, and the
// rewrite of the notes' "Action items" section that keeps everything else of the file.

const line = (startMs: number, endMs: number, speakerName: string, text: string, transcribed = true): MeetingTranscriptLine =>
  ({ segmentId: null, speakerId: '00000000-0000-4000-8000-000000000001', speakerName, startMs, endMs, text, transcribed, editable: false }) as MeetingTranscriptLine;
let n = 0;
const item = (text: string, source: 'notes' | 'mark' = 'mark'): MeetingReviewItem =>
  ({ id: `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`, source, text, ownerId: null, ownerName: null, due: null, atMs: 0 }) as MeetingReviewItem;

describe('a mark', () => {
  it('takes the lines that ended in the last 30 seconds, oldest first, never a line that was not transcribed', () => {
    const now = 100_000;
    const taken = linesForMark(
      [line(90_000, 95_000, 'Rafi', 'by Friday'), line(40_000, 60_000, 'Nadia', 'too old'), line(60_000, 72_000, 'Nadia', 'I will send the draft'), line(80_000, 81_000, 'Priya', 'Priya spoke (not transcribed)', false)],
      now,
    );
    expect(taken.map((l) => l.text)).toEqual(['I will send the draft', 'by Friday']);
  });
  it('names each speaker once per turn, and is cut at a word to 1000 characters', () => {
    expect(markText([line(0, 1, 'Nadia', 'I will send'), line(1, 2, 'Nadia', 'the draft.'), line(2, 3, 'Rafi', 'By Friday.')])).toBe('Nadia: I will send the draft. Rafi: By Friday.');
    const long = markText([line(0, 1, 'Nadia', 'word '.repeat(400))]);
    expect(long.length).toBeLessThanOrEqual(1000);
    expect(long.endsWith('word…')).toBe(true);
    expect(markText([])).toBe('');
  });
  it('takes linear time on many lines', () => {
    const many = Array.from({ length: 5000 }, (_, i) => line(i, i + 1, `P${i % 7}`, 'x'.repeat(300)));
    const t = performance.now();
    markText(linesForMark(many, 5000));
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe('the items of a review', () => {
  it('lists the notes first, then the marks, the same words once', () => {
    const merged = mergeItems([item('Send the draft', 'notes')], [item('send the DRAFT!'), item('Book the room')]);
    expect(merged.map((i) => [i.source, i.text])).toEqual([['notes', 'Send the draft'], ['mark', 'Book the room']]);
  });
  it('keeps at most 50', () => {
    expect(mergeItems(Array.from({ length: 70 }, (_, i) => item(`thing ${i}`)))).toHaveLength(50);
  });
  it('takes only the action items of the notes, with their owner and day', () => {
    const out = noteItemsForReview(
      [
        { kind: 'decision', text: 'Ship', ownerName: null, ownerId: null, due: null, atMs: 0 },
        { kind: 'action', text: 'Send the draft', ownerName: 'Priya', ownerId: '00000000-0000-4000-8000-000000000009' as never, due: '2026-11-30', atMs: 4000 },
      ],
      () => '00000000-0000-4000-8000-0000000000aa',
    );
    expect(out).toEqual([{ id: '00000000-0000-4000-8000-0000000000aa', source: 'notes', text: 'Send the draft', ownerName: 'Priya', ownerId: '00000000-0000-4000-8000-000000000009', due: '2026-11-30', atMs: 4000 }]);
  });
});

describe('the notes file after a review', () => {
  const md = ['# Planning', '', '## Summary', '', 'Edited by hand.', '', '## Action items', '', '- [ ] Old item — no owner ([00:00:01](transcript.md))', '', '## Open questions', '', '*None.*', ''].join('\n');
  it('holds the confirmed items in "Action items" and leaves the rest as it was', () => {
    const out = replaceActionItems(md, [{ text: 'Send the *draft*', ownerName: 'Priya', due: null, atMs: 65_000 }]);
    expect(out).toBe(['# Planning', '', '## Summary', '', 'Edited by hand.', '', '## Action items', '', '- [ ] Send the \\*draft\\* — owner: Priya ([00:01:05](transcript.md))', '', '## Open questions', '', '*None.*', ''].join('\n'));
  });
  it('says none when every item was removed, and adds the section to a file without one', () => {
    expect(replaceActionItems(md, [])).toContain('## Action items\n\n*None.*\n\n## Open questions');
    expect(replaceActionItems('# Planning\n', [{ text: 'Book it', ownerName: null, due: null, atMs: 0 }])).toBe('# Planning\n\n## Action items\n\n- [ ] Book it — no owner ([00:00:00](transcript.md))\n');
  });
  it('works on the last section of a file', () => {
    expect(replaceActionItems('# P\n\n## Action items\n\n- [ ] x — no owner\n', [])).toBe('# P\n\n## Action items\n\n*None.*\n');
  });
});
