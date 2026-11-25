import { describe, expect, it } from 'vitest';
import { actionItemsPreview, reviewPreview } from '../src/meeting-actions.ts';
import { prefKey } from '../src/prefs.ts';

// P15-12: the line a person reads when a meeting's notes gave them action items. The whole path (the event, the owners, one row for each) is in meetings/test/notes.test.ts.

describe('the action-items notification', () => {
  it('counts the items given to the person, in the singular and the plural, and names the meeting', () => {
    expect(actionItemsPreview(1, 'Sprint review')).toBe('1 action item from Sprint review');
    expect(actionItemsPreview(2, 'Sprint review')).toBe('2 action items from Sprint review');
  });

  it('stays short whatever the title is', () => {
    expect(actionItemsPreview(3, 'x'.repeat(500)).length).toBeLessThanOrEqual(140);
  });

  it('asks the people of a call to review its action items (P17-06), as short', () => {
    expect(reviewPreview(3, 'Sprint review')).toBe('Review 3 action items from Sprint review');
    expect(reviewPreview(1, 'Sprint review')).toBe('Review 1 action item from Sprint review');
    const long = reviewPreview(3, 'x'.repeat(500));
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith('…')).toBe(true);
  });

  it('is switched with the same setting as a mention', () => {
    expect(prefKey('meeting_actions')).toBe('mention');
  });
});
