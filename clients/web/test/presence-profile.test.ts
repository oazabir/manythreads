import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { OutOfOfficeInput, UpdateMyPresenceRequest, type PresenceCard } from '@manythreads/shared';

// P14-01c: what a dot beside a name and a profile card say (words, local time and how it compares with the reader's, working hours), the
// out-of-office form, and that a refresh of everybody's cards keeps the object of a card that did not change.

vi.mock('../src/api/endpoints', () => ({ sendHeartbeat: vi.fn(), fetchPresenceCards: vi.fn(), fetchMyPresence: vi.fn(), saveMyPresence: vi.fn(), saveDnd: vi.fn() }));
vi.mock('../src/app/caches', () => ({ onPersonChange: () => undefined }));

import { dotEmoji, dotLabel, mayShowPresence, offsetText, profileFacts, zoneLabel } from '../src/presence/profileModel';
import { LEASE_MS, mayBeat, parseLease } from '../src/presence/tabLease';
import { oooNow } from '../src/presence/format';
import { EMPTY_OOO, dayAfter, oooDraftOf, oooRequest, sameOoo, todayFor } from '../src/presence/oooModel';
import { keepCards } from '../src/presence/store';

const ID = '019a0000-0000-7000-8000-000000000001';
const OTHER = '019a0000-0000-7000-8000-000000000002';
const card = (over: Partial<PresenceCard> = {}): PresenceCard => ({
  personId: ID as PresenceCard['personId'],
  presence: 'online',
  seenAt: '2026-06-10T09:00:00.000Z',
  status: null,
  timeZone: null,
  workingHours: null,
  outOfOffice: null,
  ...over,
});
// Wednesday 10 June 2026, 09:00 UTC
const NOW = new Date('2026-06-10T09:00:00.000Z');

describe('dotLabel', () => {
  it('says Active, Away or Offline, and Offline when there is no card at all', () => {
    expect(dotLabel(card(), NOW)).toBe('Active');
    expect(dotLabel(card({ presence: 'away' }), NOW)).toBe('Away');
    expect(dotLabel(card({ presence: 'offline', seenAt: null }), NOW)).toBe('Offline');
    expect(dotLabel(undefined, NOW)).toBe('Offline');
  });

  it('adds the status words and out of office; a status past its clear time is left out', () => {
    expect(dotLabel(card({ status: { emoji: '📅', text: 'In a meeting', clearsAt: null } }), NOW)).toBe('Active, 📅 In a meeting');
    expect(dotLabel(card({ status: { emoji: '📅', text: 'In a meeting', clearsAt: '2026-06-10T08:00:00.000Z' } }), NOW)).toBe('Active');
    const ooo = { active: true, returnsOn: '2026-06-20', delegatePersonId: null, message: '' } as const;
    expect(dotLabel(card({ presence: 'offline', outOfOffice: ooo }), NOW)).toBe('Offline, Out of office');
    // the return day has come: the note is not shown any more
    expect(dotLabel(card({ outOfOffice: { ...ooo, returnsOn: '2026-06-10' } }), NOW)).toBe('Active');
  });
});

describe('an unknown time zone', () => {
  it('does not throw in the dot label, the out-of-office note or the facts; it reads as UTC and shows no clock', () => {
    const ooo = { active: true, returnsOn: '2026-06-20', delegatePersonId: null, message: '' } as const;
    const odd = card({ timeZone: 'Not/AZone', outOfOffice: ooo, workingHours: { days: [1], start: '09:00', end: '17:00' } });
    expect(() => dotLabel(odd, NOW)).not.toThrow();
    expect(dotLabel(odd, NOW)).toBe('Active, Out of office');
    expect(oooNow(odd, NOW)).toEqual(ooo);
    expect(oooNow(card({ timeZone: 'Not/AZone', outOfOffice: { ...ooo, returnsOn: '2026-06-10' } }), NOW)).toBeNull();
    const facts = profileFacts(odd, NOW, 'UTC');
    expect(facts.localTime).toBeNull();
    expect(facts.inHours).toBeNull();
  });
});

describe('dotEmoji', () => {
  const st = (emoji: string | null) => ({ emoji, text: '', clearsAt: null });
  it('draws the first picture only, and only a picture', () => {
    expect(dotEmoji(st('📅'))).toBe('📅');
    expect(dotEmoji(st('📅📅📅 a very long string'))).toBe('📅');
    expect(dotEmoji(st('🏳️\u200d🌈'))).toBe('🏳️\u200d🌈');
    expect(dotEmoji(st('lunch'))).toBeNull();
    expect(dotEmoji(st('A'))).toBeNull();
    expect(dotEmoji(st('   '))).toBeNull();
    expect(dotEmoji(st(null))).toBeNull();
    expect(dotEmoji(null)).toBeNull();
  });
});

describe('zoneLabel', () => {
  it('shows the city and the offset now', () => {
    expect(zoneLabel('America/New_York', NOW)).toBe('New York (UTC-4)');
    expect(zoneLabel('Asia/Kolkata', NOW)).toBe('Kolkata (UTC+5:30)');
    expect(zoneLabel('Europe/London', new Date('2026-01-15T12:00:00.000Z'))).toBe('London (UTC)');
    expect(zoneLabel('UTC', NOW)).toBe('UTC');
    expect(profileFacts(card({ timeZone: 'Asia/Karachi' }), NOW, 'UTC').localTime?.zone).toBe('Karachi (UTC+5)');
  });
});

describe('mayShowPresence', () => {
  it('draws nothing before the cards are current, and a guest sees only themself', () => {
    expect(mayShowPresence(false, 'member', ID, OTHER)).toBe(false);
    expect(mayShowPresence(true, 'member', ID, OTHER)).toBe(true);
    expect(mayShowPresence(true, 'member', ID, null)).toBe(false);
    expect(mayShowPresence(true, 'guest', ID, OTHER)).toBe(false);
    expect(mayShowPresence(true, 'guest', ID, ID)).toBe(true);
  });
});

describe('tab lease', () => {
  const lease = { tab: 'a', at: 1_000_000 };
  it('only one tab of a browser may say away while another is in use', () => {
    expect(mayBeat('online', lease, 'b', lease.at + 1)).toBe(true);
    expect(mayBeat('away', lease, 'b', lease.at + 1_000)).toBe(false); // tab a is in use: tab b stays quiet
    expect(mayBeat('away', lease, 'a', lease.at + 1_000)).toBe(true); // the tab that holds the lease may go idle
    expect(mayBeat('away', lease, 'b', lease.at + LEASE_MS + 1)).toBe(true); // the lease ran out (tab a was closed)
    expect(mayBeat('away', null, 'b', lease.at)).toBe(true);
  });
  it('reads a stored lease and treats rubbish as none', () => {
    expect(parseLease('{"tab":"a","at":5}')).toEqual({ tab: 'a', at: 5 });
    expect(parseLease('nope')).toBeNull();
    expect(parseLease('{"tab":1}')).toBeNull();
    expect(parseLease(null)).toBeNull();
  });
});

describe('offsetText', () => {
  it('compares two zones at this instant', () => {
    expect(offsetText('Asia/Karachi', 'UTC', NOW)).toBe('5 h ahead of you');
    expect(offsetText('America/New_York', 'UTC', NOW)).toBe('4 h behind you');
    expect(offsetText('Asia/Kolkata', 'UTC', NOW)).toBe('5 h 30 min ahead of you');
    expect(offsetText('Europe/London', 'Europe/London', NOW)).toBe('same time as you');
  });

  it('follows daylight saving: London is 0 h from UTC in winter, 1 h in summer', () => {
    expect(offsetText('Europe/London', 'UTC', new Date('2026-01-15T12:00:00.000Z'))).toBe('same time as you');
    expect(offsetText('Europe/London', 'UTC', new Date('2026-07-15T12:00:00.000Z'))).toBe('1 h ahead of you');
  });

  it('is right across the date line and empty for an unknown zone or no zone of the reader', () => {
    expect(offsetText('Pacific/Auckland', 'Pacific/Honolulu', new Date('2026-06-10T12:00:00.000Z'))).toBe('22 h ahead of you');
    expect(offsetText('Nowhere/Land', 'UTC', NOW)).toBe('');
    expect(offsetText('UTC', null, NOW)).toBe('');
  });
});

describe('profileFacts', () => {
  it('lists nothing but the presence word for a person who shared nothing', () => {
    expect(profileFacts(undefined, NOW, 'UTC')).toEqual({ presence: 'Offline', status: null, outOfOffice: null, localTime: null, workingHours: null, inHours: null });
  });

  it('gives the local time, the zone, the comparison and whether it is inside their working hours', () => {
    const hours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };
    const inside = profileFacts(card({ timeZone: 'Asia/Karachi', workingHours: hours }), NOW, 'UTC');
    expect(inside.localTime).toEqual({ clock: '14:00', zone: 'Karachi (UTC+5)', offset: '5 h ahead of you' });
    expect(inside.workingHours).toBe('Mon to Fri, 09:00 to 17:00');
    expect(inside.inHours).toBe(true);
    // 09:00 UTC is 05:00 in New York: before their day starts
    expect(profileFacts(card({ timeZone: 'America/New_York', workingHours: hours }), NOW, 'UTC').inHours).toBe(false);
    // Saturday
    expect(profileFacts(card({ timeZone: 'UTC', workingHours: hours }), new Date('2026-06-13T10:00:00.000Z'), 'UTC').inHours).toBe(false);
    // hours without a zone cannot be placed on a clock
    expect(profileFacts(card({ workingHours: hours }), NOW, 'UTC').inHours).toBeNull();
  });

  it('words the status and the out-of-office note (return day, message, delegate)', () => {
    const f = profileFacts(
      card({
        presence: 'away',
        status: { emoji: '🌴', text: 'On holiday', clearsAt: null },
        outOfOffice: { active: true, returnsOn: '2026-06-15', delegatePersonId: OTHER as never, message: 'Back on the 15th' },
      }),
      NOW,
      null,
    );
    expect(f.presence).toBe('Away');
    expect(f.status).toBe('🌴 On holiday');
    // the weekday format may or may not carry a comma, depending on the runtime's locale data
    expect(f.outOfOffice?.returns).toMatch(/^Back Mon,? 15 Jun$/);
    expect(f.outOfOffice).toMatchObject({ message: 'Back on the 15th', delegatePersonId: OTHER });
  });
});

describe('out of office form', () => {
  const note = { active: true, returnsOn: '2026-06-15', delegatePersonId: OTHER as never, message: 'Away' };

  it('fills the form from the saved note and from none', () => {
    expect(oooDraftOf(null)).toEqual(EMPTY_OOO);
    expect(oooDraftOf(note)).toEqual({ on: true, returnsOn: '2026-06-15', delegate: OTHER, message: 'Away' });
    expect(sameOoo(oooDraftOf(note), { on: true, returnsOn: '2026-06-15', delegate: OTHER, message: ' Away ' })).toBe(true);
    expect(sameOoo(EMPTY_OOO, { ...EMPTY_OOO, message: 'typed while off' })).toBe(true);
  });

  it('knows today in the saved zone (UTC when none) and the day after', () => {
    const late = new Date('2026-06-10T22:30:00.000Z');
    expect(todayFor(null, late)).toBe('2026-06-10');
    expect(todayFor('Asia/Karachi', late)).toBe('2026-06-11');
    expect(dayAfter('2026-06-30')).toBe('2026-07-01');
    expect(dayAfter('2026-12-31')).toBe('2027-01-01');
  });

  it('builds a request the server schema accepts, and null to switch it off', () => {
    const on = oooRequest({ on: true, returnsOn: '2026-06-15', delegate: OTHER, message: '  Back on the 15th ' }, '2026-06-10', ID);
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.body).toEqual({ outOfOffice: { active: true, returnsOn: '2026-06-15', delegatePersonId: OTHER, message: 'Back on the 15th' } });
      expect(UpdateMyPresenceRequest.safeParse(on.body).success).toBe(true);
      expect(OutOfOfficeInput.safeParse(on.body.outOfOffice).success).toBe(true);
    }
    expect(oooRequest({ on: true, returnsOn: '', delegate: '', message: '' }, '2026-06-10', ID)).toEqual({
      ok: true,
      body: { outOfOffice: { active: true, returnsOn: null, delegatePersonId: null, message: '' } },
    });
    expect(oooRequest({ ...EMPTY_OOO, message: 'ignored' }, '2026-06-10', ID)).toEqual({ ok: true, body: { outOfOffice: null } });
  });

  it('says in words what to fix', () => {
    const base = { on: true, returnsOn: '2026-06-15', delegate: '', message: '' };
    expect(oooRequest({ ...base, returnsOn: '2026-06-10' }, '2026-06-10', ID)).toEqual({ ok: false, problem: 'Choose a return day after today.' });
    expect(oooRequest({ ...base, returnsOn: '15/06/2026' }, '2026-06-10', ID)).toEqual({ ok: false, problem: 'Choose the day you are back.' });
    expect(oooRequest({ ...base, delegate: ID }, '2026-06-10', ID)).toEqual({ ok: false, problem: 'You cannot be your own delegate.' });
    expect(oooRequest({ ...base, message: 'x'.repeat(201) }, '2026-06-10', ID)).toEqual({ ok: false, problem: 'Keep the note to 200 characters.' });
  });
});

describe('colours', () => {
  const tokens = readFileSync(fileURLToPath(new URL('../src/styles/tokens.css', import.meta.url)), 'utf8');
  const hex = (name: string): string => /#[0-9A-Fa-f]{6}/.exec(new RegExp(`--${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(tokens)?.[0] ?? '')?.[0] ?? '';
  const lum = (h: string): number => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
  it('the three marks of a dot reach 3:1 on the page and on the selected sidebar row', () => {
    for (const bg of ['surface', 'nav-on']) {
      for (const ink of ['presence-ring', 'ok', 'warn-ink']) expect(ratio(hex(ink), hex(bg)), `${ink} on ${bg}`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('keepCards', () => {
  it('keeps a card when only its last-seen time moved (an active person beats every 30 seconds)', () => {
    const a = card();
    const before = new Map([[a.personId, a]]);
    const next = keepCards(before, [{ ...a, seenAt: '2026-06-10T09:00:30.000Z' }]);
    expect(next.get(a.personId)).toBe(a);
    // a change of anything that is drawn replaces it
    expect(keepCards(before, [{ ...a, status: { emoji: '📅', text: 'x', clearsAt: null } }]).get(a.personId)).not.toBe(a);
    expect(keepCards(before, [{ ...a, timeZone: 'UTC' }]).get(a.personId)).not.toBe(a);
  });

  it('keeps the object of a card that did not change, replaces one that did, and drops people who are gone', () => {
    const a = card();
    const b = card({ personId: OTHER as never, presence: 'away' });
    const before = new Map([[a.personId, a], [b.personId, b]]);
    const next = keepCards(before, [{ ...a }, { ...b, presence: 'online' }]);
    expect(next.get(a.personId)).toBe(a);
    expect(next.get(b.personId)).not.toBe(b);
    expect(next.get(b.personId)?.presence).toBe('online');
    expect(keepCards(before, [{ ...a }]).has(b.personId)).toBe(false);
  });
});
