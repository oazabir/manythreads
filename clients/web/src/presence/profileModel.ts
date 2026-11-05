import { isValidTimeZone, localClock, localTimeText, withinWorkingHours, type PresenceCard } from '@manythreads/shared';
import type { CustomStatus } from '@manythreads/shared';
import { hoursText, oooNow, presenceWord, returnText, statusNow, statusText } from './format';

/*
 * What a dot beside a name and a profile card say about a person (PLAN P14-01), as plain functions: no network, no DOM, so the dot, the card and the
 * tests agree. The server decides who may be seen at all (it serves a card only for people the reader may see); this file only words what it was given.
 */

/**
 * Whether presence of `personId` may be drawn for this reader: the cards are current, and a guest is shown only themself (the server serves a guest only
 * their own card, so for anybody else "no card" would be read as "Offline" when it only means "not allowed to know").
 */
export function mayShowPresence(live: boolean, readerRole: string, readerId: string, personId: string | null | undefined): boolean {
  if (!live || !personId) return false;
  return readerRole !== 'guest' || personId === readerId;
}

/** The words for a dot: `Active`, `Away` or `Offline`, then the status in words and `Out of office` when it applies. Used as the tooltip and the accessible name. */
export function dotLabel(card: PresenceCard | undefined, now: Date): string {
  const status = statusNow(card, now);
  const parts: string[] = [presenceWord(card)];
  if (status) parts.push(statusText(status));
  if (oooNow(card, now)) parts.push('Out of office');
  return parts.join(', ');
}

/**
 * The emoji drawn beside a name: the first grapheme of the status emoji, and only when it is a picture. A long string, text or a lone letter typed into
 * the emoji field is not drawn there (the profile card and the tooltip still have the whole status).
 */
export function dotEmoji(status: CustomStatus | null): string | null {
  const raw = status?.emoji?.trim();
  if (!raw) return null;
  let first: string | undefined;
  try {
    first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(raw)[Symbol.iterator]().next().value?.segment;
  } catch {
    first = Array.from(raw)[0];
  }
  return first !== undefined && /\p{Extended_Pictographic}/u.test(first) ? first : null;
}

/** `New York (UTC-4)` for `America/New_York`: the city part of the name and the offset now. `UTC` stays `UTC`. */
export function zoneLabel(zone: string, at: Date): string {
  if (zone === 'UTC') return 'UTC';
  const city = (zone.split('/').pop() ?? zone).replaceAll('_', ' ');
  let offset = '';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    offset = part.replace(/^GMT/, 'UTC').replace(/[+-]0(:00)?$/, '');
  } catch {
    offset = '';
  }
  return offset ? `${city} (${offset})` : city;
}

/**
 * How far ahead of (or behind) another zone a zone is right now: `same time as you`, `3 h ahead of you`, `4 h 30 min behind you`. Read from the two
 * wall clocks at this instant, so a daylight-saving change is included. Empty when either zone is not one the runtime knows.
 */
export function offsetText(zone: string, ownZone: string | null, at: Date): string {
  if (ownZone === null || !isValidTimeZone(zone) || !isValidTimeZone(ownZone)) return '';
  const week = 7 * 24 * 60;
  const there = localClock(at, zone);
  const here = localClock(at, ownZone);
  let diff = (there.weekday * 1440 + there.minutes - (here.weekday * 1440 + here.minutes)) % week;
  if (diff > week / 2) diff -= week;
  if (diff < -week / 2) diff += week;
  if (diff === 0) return 'same time as you';
  const abs = Math.abs(diff);
  const [h, m] = [Math.floor(abs / 60), abs % 60];
  const amount = [h > 0 ? `${h} h` : '', m > 0 ? `${m} min` : ''].filter(Boolean).join(' ');
  return `${amount} ${diff > 0 ? 'ahead of' : 'behind'} you`;
}

/** What the profile card lists. A field is `null` when the person shared nothing for it. */
export type ProfileFacts = {
  presence: 'Active' | 'Away' | 'Offline';
  status: string | null;
  outOfOffice: { returns: string | null; message: string; delegatePersonId: string | null } | null;
  /** `14:32` in the person's zone, with the zone's name and how it compares with the reader's; null when no zone is shared. */
  localTime: { clock: string; zone: string; offset: string } | null;
  workingHours: string | null;
  /** Whether it is inside their working hours now; null when no hours (or no zone) are shared. */
  inHours: boolean | null;
};

export function profileFacts(card: PresenceCard | undefined, now: Date, ownZone: string | null): ProfileFacts {
  const status = statusNow(card, now);
  const ooo = oooNow(card, now);
  const zone = card?.timeZone && isValidTimeZone(card.timeZone) ? card.timeZone : null;
  const hours = card?.workingHours ?? null;
  return {
    presence: presenceWord(card),
    status: status ? statusText(status) : null,
    outOfOffice: ooo ? { returns: ooo.returnsOn ? `Back ${returnText(ooo.returnsOn)}` : null, message: ooo.message, delegatePersonId: ooo.delegatePersonId } : null,
    localTime: zone ? { clock: localTimeText(now, zone), zone: zoneLabel(zone, now), offset: offsetText(zone, ownZone, now) } : null,
    workingHours: hours ? hoursText(hours) : null,
    inHours: hours && zone ? withinWorkingHours(hours, zone, now) : null,
  };
}

/** `7:32 pm there`: the clock in `zone` as a short phrase for a conversation header; null when no zone is shared or the runtime does not know it. */
export function localTimeThere(at: Date, zone: string | null | undefined): string | null {
  if (!zone || !isValidTimeZone(zone)) return null;
  const { minutes } = localClock(at, zone);
  const h24 = Math.floor(minutes / 60);
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(minutes % 60).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'} there`;
}
