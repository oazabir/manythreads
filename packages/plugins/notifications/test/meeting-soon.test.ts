import { describe, expect, it } from 'vitest';
import { meetingSoonPreview } from '../src/meeting-soon.ts';
import { prefKey } from '../src/prefs.ts';

// P16-05: the line a person reads five minutes before a planned room. The whole path (the reminder job, the event, one row for each invited person) is in meetings/test/scheduled-reminders.test.ts.

describe('the "starts in 5 minutes" notification', () => {
  it('names the meeting and says when', () => {
    expect(meetingSoonPreview('Design review')).toBe('Design review starts in 5 minutes');
  });

  it('collapses white space and has a word for an empty title', () => {
    expect(meetingSoonPreview('  Design \n  review ')).toBe('Design review starts in 5 minutes');
    expect(meetingSoonPreview('   ')).toBe('A meeting starts in 5 minutes');
  });

  it('stays short whatever the title is, and keeps its tail', () => {
    const line = meetingSoonPreview('x'.repeat(500));
    expect(line.length).toBeLessThanOrEqual(140);
    expect(line.endsWith(' starts in 5 minutes')).toBe(true);
  });

  it('is switched with the same setting as a mention', () => {
    expect(prefKey('meeting_soon')).toBe('mention');
  });
});
