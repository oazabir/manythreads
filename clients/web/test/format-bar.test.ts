// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { focusStaysInside, formatBarVisible, stillInside } from '../src/channels/formatBar';

// P37-01 (owner): the formatting bar shows whenever the person is in the composer, and folds away when focus leaves and the box is empty.

describe('when the formatting bar is drawn', () => {
  const off = { pinned: false, focusInside: false, hasText: false };
  it('is hidden when nothing asks for it', () => {
    expect(formatBarVisible(off)).toBe(false);
  });
  it('shows while focus is in the composer, while the box has text, while the emoji picker is open, and when pinned', () => {
    expect(formatBarVisible({ ...off, focusInside: true })).toBe(true);
    expect(formatBarVisible({ ...off, hasText: true })).toBe(true);
    expect(formatBarVisible({ ...off, emojiOpen: true })).toBe(true);
    expect(formatBarVisible({ ...off, pinned: true })).toBe(true);
  });
});

describe('focus leaving an element of the composer', () => {
  const root = document.createElement('div');
  const inner = document.createElement('button');
  root.append(inner);
  const outside = document.createElement('div');

  it('stays inside when it moves to another part of the composer', () => {
    expect(focusStaysInside(inner, root, false)).toBe(true);
  });
  it('leaves when it moves outside the composer', () => {
    expect(focusStaysInside(outside, root, false)).toBe(false);
    expect(focusStaysInside(outside, root, true)).toBe(false);
  });
  it('goes to nowhere: a press on the bar does not leave, anything else does', () => {
    expect(focusStaysInside(null, root, true)).toBe(true);
    expect(focusStaysInside(null, root, false)).toBe(false);
  });
  it('after a press, the person is still inside only if focus is in the composer', () => {
    expect(stillInside(inner, root)).toBe(true);
    expect(stillInside(document.body, root)).toBe(false);
    expect(stillInside(null, root)).toBe(false);
    expect(stillInside(inner, null)).toBe(false);
  });
});
