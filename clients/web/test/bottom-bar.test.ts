import { describe, expect, it } from 'vitest';
import type { GetNotificationLevelsResponse } from '@manythreads/shared';
import { activeEntry, barPath, dmUnreadTotal, takesText } from '../src/shell/bottomBar';
import { createEdgeSwipe, EDGE_ZONE, SWIPE_MAX_DY, SWIPE_MIN_DX } from '../src/shell/useEdgeSwipe';

const el = (o: Record<string, unknown>): Element => o as unknown as Element;

describe('bottom bar paths', () => {
  it('sends Home to Threads, Messages to the DM list and Activity to its page', () => {
    expect(barPath('engineering', 'home')).toBe('/t/engineering/threads');
    expect(barPath('engineering', 'messages')).toBe('/t/engineering/dms');
    expect(barPath('engineering', 'activity')).toBe('/t/engineering/activity');
  });

  it('lights the entry the page belongs to: a conversation is Messages, the first screen is Home, a channel lights none', () => {
    expect(activeEntry('/', 'engineering')).toBe('home');
    expect(activeEntry('/t/engineering/threads', 'engineering')).toBe('home');
    expect(activeEntry('/t/engineering/dms', 'engineering')).toBe('messages');
    expect(activeEntry('/t/engineering/dm/abc', 'engineering')).toBe('messages');
    expect(activeEntry('/t/engineering/activity', 'engineering')).toBe('activity');
    expect(activeEntry('/t/engineering/c/dev', 'engineering')).toBeNull();
    expect(activeEntry('/t/marketing/threads', 'engineering')).toBeNull();
    expect(activeEntry('/settings/workspace/general', 'engineering')).toBeNull();
  });
});

describe('takesText (the keyboard is up)', () => {
  it('is true for a text box, a text area and an editable element', () => {
    expect(takesText(el({ tagName: 'TEXTAREA', readOnly: false, disabled: false }))).toBe(true);
    expect(takesText(el({ tagName: 'INPUT', type: 'search', readOnly: false, disabled: false }))).toBe(true);
    expect(takesText(el({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
  });

  it('is false for buttons, checkboxes, read-only fields and nothing at all', () => {
    expect(takesText(null)).toBe(false);
    expect(takesText(el({ tagName: 'BUTTON' }))).toBe(false);
    expect(takesText(el({ tagName: 'INPUT', type: 'checkbox' }))).toBe(false);
    expect(takesText(el({ tagName: 'INPUT', type: 'text', readOnly: true }))).toBe(false);
    expect(takesText(el({ tagName: 'TEXTAREA', disabled: true }))).toBe(false);
    expect(takesText(el({ tagName: 'DIV', isContentEditable: false }))).toBe(false);
  });
});

describe('dmUnreadTotal', () => {
  const items = [
    { channel: { id: 'a' }, unreadCount: 2 },
    { channel: { id: 'b' }, unreadCount: 0 },
    { channel: { id: 'c' }, unreadCount: 4 },
  ];

  it('adds the unread counts, preferring the live count over the one the list came with', () => {
    expect(dmUnreadTotal(items, {}, null)).toBe(6);
    expect(dmUnreadTotal(items, { a: 5, b: 1 }, null)).toBe(10);
    expect(dmUnreadTotal([], {}, null)).toBe(0);
  });

  it('leaves out a conversation set to notify about nothing', () => {
    const levels = { workspaceDefault: 'mentions', channels: [{ channelId: 'c', channelName: null, channelKind: 'dm', level: 'nothing' }] } as unknown as GetNotificationLevelsResponse;
    expect(dmUnreadTotal(items, {}, levels)).toBe(2);
  });
});

describe('edge swipe', () => {
  it('opens on a straight swipe from the left edge', () => {
    const s = createEdgeSwipe();
    s.start(4, 400);
    expect(s.move(30, 405)).toBe(false);
    expect(s.move(4 + SWIPE_MIN_DX, 410)).toBe(true);
  });

  it('fires once per touch', () => {
    const s = createEdgeSwipe();
    s.start(0, 100);
    expect(s.move(SWIPE_MIN_DX, 100)).toBe(true);
    expect(s.move(SWIPE_MIN_DX + 40, 100)).toBe(false);
  });

  it('ignores a touch that starts away from the edge', () => {
    const s = createEdgeSwipe();
    s.start(EDGE_ZONE + 1, 400);
    expect(s.move(300, 400)).toBe(false);
  });

  it('leaves a scroll alone: too much up or down drift ends the gesture for good', () => {
    const s = createEdgeSwipe();
    s.start(8, 400);
    expect(s.move(20, 400 + SWIPE_MAX_DY)).toBe(false);
    expect(s.move(200, 400)).toBe(false);
  });

  it('ends when the finger goes back left, and when it is cancelled', () => {
    const s = createEdgeSwipe();
    s.start(20, 400);
    expect(s.move(2, 400)).toBe(false);
    expect(s.move(200, 400)).toBe(false);
    s.start(8, 400);
    s.cancel();
    expect(s.move(200, 400)).toBe(false);
  });
});
