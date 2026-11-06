import { describe, expect, it } from 'vitest';
import { isFolded, toggleFold } from '../src/shell/sectionFold';
import { teamIndexForKey } from '../src/shell/TeamSwitch';
import { unreadLook } from '../src/shell/unreadLook';

describe('sectionFold', () => {
  it('follows the default until the person chooses', () => {
    expect(isFolded([], 'bots', true)).toBe(true);
    expect(isFolded([], 'dm')).toBe(false);
  });
  it('opening a folded-by-default section on purpose sticks', () => {
    const opened = toggleFold([], 'bots', true);
    expect(opened).toEqual(['!bots']);
    expect(isFolded(opened, 'bots', true)).toBe(false);
    expect(isFolded(toggleFold(opened, 'bots', true), 'bots', true)).toBe(true);
  });
  it('folding then opening returns to open', () => {
    const folded = toggleFold([], 'dm');
    expect(isFolded(folded, 'dm')).toBe(true);
    expect(isFolded(toggleFold(folded, 'dm'), 'dm')).toBe(false);
  });
});

describe('unreadLook', () => {
  it('gives a direct message the mention badge and a muted one the quiet badge', () => {
    expect(unreadLook(2, null, 'c1', 'dm').badge).toBe('mention');
    expect(unreadLook(2, null, 'c1', 'channel').badge).toBe('unread');
    expect(unreadLook(2, null, 'c1', 'channel', true).badge).toBe('mention');
    expect(unreadLook(0, null, 'c1', 'channel').badge).toBeNull();
  });
});

describe('teamIndexForKey', () => {
  it('maps Alt+1..9 only', () => {
    const k = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(teamIndexForKey({ ...k, code: 'Digit1' })).toBe(0);
    expect(teamIndexForKey({ ...k, code: 'Digit0' })).toBeNull();
    expect(teamIndexForKey({ ...k, altKey: false, code: 'Digit1' })).toBeNull();
  });
});
