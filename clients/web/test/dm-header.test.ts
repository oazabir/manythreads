import type { DirectMessageSummary } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { dmHeaderTitle } from '../src/dms/store';
import { localTimeThere } from '../src/presence/profileModel';

// The pure parts of the conversation header (P21-06): "7:32 pm there" and who the title names.

describe('localTimeThere', () => {
  const at = new Date('2026-03-10T19:32:00Z');
  it('words the clock in the person zone, 12 hours with am or pm', () => {
    expect(localTimeThere(at, 'UTC')).toBe('7:32 pm there');
    expect(localTimeThere(at, 'Asia/Dubai')).toBe('11:32 pm there');
    expect(localTimeThere(at, 'Asia/Karachi')).toBe('12:32 am there');
    expect(localTimeThere(new Date('2026-03-10T00:05:00Z'), 'UTC')).toBe('12:05 am there');
    expect(localTimeThere(new Date('2026-03-10T12:00:00Z'), 'UTC')).toBe('12:00 pm there');
  });
  it('says nothing for no zone or one the runtime does not know', () => {
    expect(localTimeThere(at, null)).toBeNull();
    expect(localTimeThere(at, undefined)).toBeNull();
    expect(localTimeThere(at, '')).toBeNull();
    expect(localTimeThere(at, 'Mars/Olympus')).toBeNull();
  });
});

const dm = (people: Array<[string, string]>, dmKey: string | null = null): DirectMessageSummary =>
  ({ channel: { dmKey }, participants: people.map(([personId, displayName]) => ({ personId, displayName })), lastMessage: null, unreadCount: 0 }) as unknown as DirectMessageSummary;

describe('dmHeaderTitle', () => {
  it('names the other person of a one-to-one', () => {
    expect(dmHeaderTitle(dm([['me', 'Nadia'], ['p2', 'Rafi']]), 'me')).toEqual({ kind: 'person', personId: 'p2', name: 'Rafi' });
  });
  it('names a group without the reader', () => {
    expect(dmHeaderTitle(dm([['me', 'Nadia'], ['p2', 'Rafi'], ['p3', 'Omar']]), 'me')).toEqual({ kind: 'group', name: 'Rafi, Omar' });
  });
  it('keeps Notes to self plain', () => {
    expect(dmHeaderTitle(dm([['me', 'Nadia']]), 'me')).toEqual({ kind: 'plain', name: 'Notes to self' });
  });
});
