import { describe, expect, it } from 'vitest';
import { accountPageFor } from '../src/screens/account/AccountIndex';

// a literal "#acc..." reads as a raw hex colour to the lint rule
const h = (id: string): string => '#' + id;

describe('accountPageFor', () => {
  it('opens Profile without an anchor', () => {
    expect(accountPageFor('')).toBe('profile');
    expect(accountPageFor(h('nothing-known'))).toBe('profile');
  });
  it('sends the old anchors to the page that now holds the section', () => {
    expect(accountPageFor(h('status-and-dnd'))).toBe('notifications');
    expect(accountPageFor(h('acc-notifications'))).toBe('notifications');
    expect(accountPageFor(h('acc-sessions'))).toBe('security');
    expect(accountPageFor(h('acc-password'))).toBe('security');
    expect(accountPageFor(h('acc-connections'))).toBe('connections');
    expect(accountPageFor(h('acc-presence'))).toBe('notifications');
    expect(accountPageFor(h('acc-methods'))).toBe('security');
    expect(accountPageFor(h('acc-appearance'))).toBe('appearance');
  });
  it('reads the anchor without the hash sign and does not guess from a part of a name', () => {
    expect(accountPageFor('acc-sessions')).toBe('security');
    expect(accountPageFor(h('acc-sessions-extra'))).toBe('profile');
    expect(accountPageFor(h('%E0%A4%A'))).toBe('profile');
  });
});
