import { describe, expect, it } from 'vitest';
import { attentionCount, documentTitle, faviconState } from '../src/shell/tabState';

describe('documentTitle', () => {
  it('puts the count first and the team before the workspace', () => {
    expect(documentTitle({ count: 3, place: '# dev', team: 'Engineering', workspace: 'Kahf Software' })).toBe('(3) # dev — Engineering · Kahf Software');
  });
  it('has no prefix at zero and caps at 99+', () => {
    expect(documentTitle({ count: 0, place: 'Boards', team: 'Engineering', workspace: 'Kahf' })).toBe('Boards — Engineering · Kahf');
    expect(documentTitle({ count: 250, place: 'Boards', team: null, workspace: 'Kahf' })).toBe('(99+) Boards · Kahf');
  });
});

describe('attentionCount', () => {
  it('adds unread DMs and mentions', () => {
    expect(attentionCount({ dmUnread: [1, 2], mentionCount: 4, dnd: false })).toBe(7);
  });
  it('is zero under Do not disturb', () => {
    expect(attentionCount({ dmUnread: [5], mentionCount: 2, dnd: true })).toBe(0);
  });
});

describe('faviconState', () => {
  it('shows a dot only when something waits and not under Do not disturb', () => {
    expect(faviconState(2, false).dot).toBe(true);
    expect(faviconState(0, false).dot).toBe(false);
    expect(faviconState(2, true).dot).toBe(false);
  });
});
