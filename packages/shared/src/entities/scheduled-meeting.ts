import { z } from 'zod';
import { IsoDateTime } from '../common/time.ts';
import { ActorId, ChannelId, MeetingId, PersonId, ScheduledMeetingId, TeamId, WorkspaceId } from '../ids.ts';
import { MeetingTitle } from './meeting.ts';

// A voice room planned ahead (PLAN Bundle D, P16-05, plugin `meetings`, docs/plugins/meetings.md "Bundle D contracts"). A plan is not a room: the room is made when someone
// presses Start at the time (or opens the join link), and that room remembers its plan. Enums match the SQL CHECKs in plugins/meetings/migrations/0005 exactly.

/** `scheduled`: waiting for its time. `cancelled`: the organizer (or the calendar) took it away. `started`: a room was opened from it. */
export const ScheduledMeetingStatus = z.enum(['scheduled', 'cancelled', 'started']);
export type ScheduledMeetingStatus = z.infer<typeof ScheduledMeetingStatus>;

/** Which calendar service carries the event at the organizer's own calendar. */
export const ScheduledMeetingProvider = z.enum(['google', 'microsoft']);
export type ScheduledMeetingProvider = z.infer<typeof ScheduledMeetingProvider>;

/** The lengths the dialog offers, in minutes. */
export const SCHEDULED_MEETING_LENGTHS = [15, 30, 45, 60, 90] as const;
/** A title is at most this long (the calendar event's title); an agenda at most this many characters. */
export const SCHEDULED_TITLE_MAX = 120;
export const SCHEDULED_AGENDA_MAX = 8000;
/** The most people one planned room invites (workspace people and outside addresses together). */
export const SCHEDULED_ATTENDEES_MAX = 50;
/** The most planned rooms waiting in one channel. */
export const SCHEDULED_PER_CHANNEL_MAX = 100;
/** The reminder goes out this long before the start (minutes). */
export const SCHEDULED_REMINDER_MINUTES = 5;
/** How far ahead a room can be planned (days) and how long one can be (hours). */
export const SCHEDULED_MAX_AHEAD_DAYS = 366;
export const SCHEDULED_MAX_HOURS = 24;

export const ScheduledMeetingTitle = MeetingTitle.max(SCHEDULED_TITLE_MAX, `A title can have at most ${SCHEDULED_TITLE_MAX} characters`);

/** One planned room as a reader of its channel sees it. Outside people are only a count: their addresses are never kept. */
export const ScheduledMeeting = z.object({
  id: ScheduledMeetingId,
  workspaceId: WorkspaceId,
  teamId: TeamId.nullable(),
  channelId: ChannelId,
  title: z.string().min(1).max(SCHEDULED_TITLE_MAX),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
  agendaMd: z.string().max(SCHEDULED_AGENDA_MAX),
  status: ScheduledMeetingStatus,
  provider: ScheduledMeetingProvider,
  organizerId: ActorId,
  /** The organizer's name as the workspace shows it; null when the organizer is no longer shown. */
  organizerName: z.string().nullable(),
  /** The people of the workspace invited (a count of the list below the caller can read), and the people outside it (a count only). */
  attendeeCount: z.number().int().min(0).max(SCHEDULED_ATTENDEES_MAX),
  outsideCount: z.number().int().min(0).max(SCHEDULED_ATTENDEES_MAX),
  attendeePersonIds: z.array(PersonId).max(SCHEDULED_ATTENDEES_MAX),
  /** The room that was opened from this plan, while it is live or after; null before. */
  meetingId: MeetingId.nullable(),
  /** The address that opens this plan: `/join/<id>`. */
  joinPath: z.string().max(100),
  createdAt: IsoDateTime,
});
export type ScheduledMeeting = z.infer<typeof ScheduledMeeting>;

/** What `/join/:id` says to someone who may not read the channel: the state of the plan, never its title or agenda. */
export const ScheduledMeetingGate = z.object({
  /** Whether the caller can read the channel (and so see the plan). */
  readable: z.boolean(),
  status: ScheduledMeetingStatus,
  /** The channel's name when it is public or the caller reads it; null for a private channel the caller is not in. */
  channelName: z.string().nullable(),
  organizerName: z.string().nullable(),
});
export type ScheduledMeetingGate = z.infer<typeof ScheduledMeetingGate>;
