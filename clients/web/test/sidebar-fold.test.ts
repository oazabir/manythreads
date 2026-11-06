import { afterEach, beforeEach, vi } from 'vitest';
import { isEditableTarget } from '../src/shell/TeamSwitch';
import { readFold, writeFold } from '../src/shell/sectionFold';
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

describe('fold saved per person and team', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('keeps one team fold apart from another and one person from another', () => {
    writeFold('p1', 'eng', ['dm']);
    expect(readFold('p1', 'eng')).toEqual(['dm']);
    expect(readFold('p1', 'ops')).toEqual([]);
    expect(readFold('p2', 'eng')).toEqual([]);
  });
  it('reads junk and a broken store as nothing folded', () => {
    store.set('mt.sidebar.fold:p1:eng', '{not json');
    expect(readFold('p1', 'eng')).toEqual([]);
    store.set('mt.sidebar.fold:p1:eng', '["dm",3,null]');
    expect(readFold('p1', 'eng')).toEqual(['dm']);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    expect(readFold('p1', 'eng')).toEqual([]);
    expect(() => writeFold('p1', 'eng', ['dm'])).not.toThrow();
  });
});

describe('team keys and the editable guard', () => {
  it('rejects Ctrl, Meta and Shift combinations and non-digit keys', () => {
    const k = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(teamIndexForKey({ ...k, code: 'Digit9' })).toBe(8);
    expect(teamIndexForKey({ ...k, ctrlKey: true, code: 'Digit1' })).toBeNull();
    expect(teamIndexForKey({ ...k, metaKey: true, code: 'Digit1' })).toBeNull();
    expect(teamIndexForKey({ ...k, shiftKey: true, code: 'Digit1' })).toBeNull();
    expect(teamIndexForKey({ ...k, code: 'KeyA' })).toBeNull();
    expect(teamIndexForKey({ ...k, code: 'Numpad1' })).toBeNull();
  });
  it('treats inputs and editors as typing, anything else not', () => {
    expect(isEditableTarget({ closest: () => ({}) })).toBe(true);
    expect(isEditableTarget({ closest: () => null })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});
