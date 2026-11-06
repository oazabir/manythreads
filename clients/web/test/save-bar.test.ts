import { describe, expect, it } from 'vitest';
import { issueLine, showSaveBar } from '../src/screens/bots/SaveBar';

describe('the bot page save bar (P21-17)', () => {
  it('is drawn only when something changed or the draft has a problem', () => {
    expect(showSaveBar({ dirty: false, issues: [] })).toBe(false);
    expect(showSaveBar({ dirty: true, issues: [] })).toBe(true);
    expect(showSaveBar({ dirty: false, issues: [{ path: 'name', message: 'Required' }] })).toBe(true);
  });

  it('names the first problem and counts the others', () => {
    expect(issueLine([])).toBeNull();
    expect(issueLine([{ path: 'name', message: 'Required' }])).toBe('Cannot save yet: name: Required');
    expect(issueLine([{ path: '', message: 'Bad file' }])).toBe('Cannot save yet: Bad file');
    expect(
      issueLine([
        { path: 'name', message: 'Required' },
        { path: 'role', message: 'Too long' },
        { path: 'model', message: 'Unknown' },
      ]),
    ).toBe('Cannot save yet: name: Required (+2 more)');
  });
});
