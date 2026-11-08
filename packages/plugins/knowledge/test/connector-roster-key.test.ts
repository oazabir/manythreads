import { describe, expect, it } from 'vitest';
import type { TeamMemberAddress } from '../src/access-rule.ts';
import { recheckKey, rosterKey } from '../src/connector-sync.ts';

// The fingerprint of a team that keys the follow-up recheck of a connector pass (a recheck already running must not make the one for a changed team a copy).
const person = (email: string, extra: Partial<TeamMemberAddress> = {}): TeamMemberAddress => ({ email, verified: true, others: [], kind: 'person', ...extra });

describe('the team fingerprint of a connector pass', () => {
  it('is the same for the same people in any order and any letter case', () => {
    expect(rosterKey([person('a@x.example'), person('b@x.example')])).toBe(rosterKey([person('B@x.example'), person('a@x.example')]));
  });

  it('changes when somebody joins, leaves, or their verified address changes', () => {
    const base = [person('a@x.example'), person('b@x.example')];
    expect(rosterKey([...base, person('c@x.example')])).not.toBe(rosterKey(base));
    expect(rosterKey([base[0] as TeamMemberAddress])).not.toBe(rosterKey(base));
    expect(rosterKey([person('a@x.example'), person('b@x.example', { verified: false })])).not.toBe(rosterKey(base));
    expect(rosterKey([person('a@x.example'), person('b@x.example', { others: ['b2@x.example'] })])).not.toBe(rosterKey(base));
    expect(rosterKey([person('a@x.example'), person('b@x.example', { kind: 'guest' })])).not.toBe(rosterKey(base));
  });

  it('keys the recheck by source and team, so a changed team never dedupes against the recheck that is running', () => {
    const before = [person('a@x.example')];
    const after = [...before, person('b@x.example')];
    expect(recheckKey('s1', before)).not.toBe(recheckKey('s1', after));
    expect(recheckKey('s1', after)).toBe(recheckKey('s1', [...after].reverse()));
    expect(recheckKey('s1', after)).not.toBe(recheckKey('s2', after));
    expect(recheckKey('s1', after)).not.toBe('knowledge.connector:s1:recheck');
  });
});
