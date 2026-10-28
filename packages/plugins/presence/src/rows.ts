import {
  CustomStatus,
  DEFAULT_DND_SETTINGS,
  DndSettings,
  OutOfOffice,
  PresenceCard,
  WorkingHours,
  liveOutOfOffice,
  liveStatus,
} from '@manythreads/shared';

/** A `person_status` row; `ooo_returns_on` is selected as text (`to_char`) so the date does not pass through the server's time zone. */
export interface PersonStatusRow extends Record<string, unknown> {
  person_id: string;
  status_emoji: string | null;
  status_text: string;
  status_clears_at: Date | null;
  time_zone: string | null;
  working_hours: unknown;
  ooo_active: boolean;
  ooo_returns_on: string | null;
  ooo_delegate_id: string | null;
  ooo_message: string;
}

export const PERSON_STATUS_COLUMNS =
  `s.person_id, s.status_emoji, s.status_text, s.status_clears_at, s.time_zone, s.working_hours, s.ooo_active,
   to_char(s.ooo_returns_on, 'YYYY-MM-DD') AS ooo_returns_on, s.ooo_delegate_id, s.ooo_message`;

/** The status of a row, or null when it has none or its clear time has passed. */
export function statusOf(r: PersonStatusRow, now: Date): CustomStatus | null {
  if (r.status_emoji === null && r.status_text === '') return null;
  return liveStatus(
    CustomStatus.parse({ emoji: r.status_emoji, text: r.status_text, clearsAt: r.status_clears_at ? r.status_clears_at.toISOString() : null }),
    now,
  );
}

/** Working hours as stored; a document that no longer parses (an older version wrote it) reads as none. */
export function workingHoursOf(r: PersonStatusRow): WorkingHours | null {
  const parsed = WorkingHours.safeParse(r.working_hours);
  return parsed.success ? parsed.data : null;
}

/** The out-of-office note of a row, or null while it is off or its return day has come. */
export function outOfOfficeOf(r: PersonStatusRow, now: Date): OutOfOffice | null {
  if (!r.ooo_active) return null;
  return liveOutOfOffice(
    OutOfOffice.parse({ active: true, returnsOn: r.ooo_returns_on, delegatePersonId: r.ooo_delegate_id, message: r.ooo_message }),
    r.time_zone,
    now,
  );
}

/** The one place a `person_status` row (with the heartbeat, if there is a fresh one) becomes the shared `PresenceCard`. */
export function toPresenceCard(r: PersonStatusRow | undefined, personId: string, beat: { status: string; seen_at: Date } | undefined, now: Date): PresenceCard {
  return PresenceCard.parse({
    personId,
    presence: beat ? beat.status : 'offline',
    seenAt: beat ? beat.seen_at.toISOString() : null,
    status: r ? statusOf(r, now) : null,
    timeZone: r?.time_zone ?? null,
    workingHours: r ? workingHoursOf(r) : null,
    outOfOffice: r ? outOfOfficeOf(r, now) : null,
  });
}

/** A `dnd_settings` row as the shared type; a document that no longer parses reads as "off". */
export function toDndSettings(r: { enabled: boolean; paused_until: Date | null; schedule: unknown } | undefined): DndSettings {
  if (!r) return DEFAULT_DND_SETTINGS;
  const parsed = DndSettings.safeParse({ enabled: r.enabled, pausedUntil: r.paused_until ? r.paused_until.toISOString() : null, schedule: r.schedule });
  return parsed.success ? parsed.data : { ...DEFAULT_DND_SETTINGS, enabled: r.enabled };
}
