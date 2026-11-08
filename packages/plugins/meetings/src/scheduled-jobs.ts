import type { PluginContext } from '@manythreads/sdk';

// Work package C (P16-05, decisions D7, D8): the two jobs of planned rooms. `meetings.scheduled-reminders` (every minute) finds the plans that start within five minutes and have not been
// reminded, marks `reminded_at` and emits `meetings.scheduled.starting_soon` once. `meetings.scheduled-sync` (every ten minutes, plans starting within 48 hours, at most 50 a pass) asks the
// organizer's calendar for each event with `getEvent` and copies a changed time or title, or cancels a plan whose event is gone; a grant that is gone leaves the plan as it is.
// STUB: no job is registered until C fills it in.
export const SCHEDULED_REMINDERS_QUEUE = 'meetings.scheduled-reminders';
export const SCHEDULED_SYNC_QUEUE = 'meetings.scheduled-sync';

export function registerScheduledJobs(ctx: PluginContext): void {
  void ctx;
}
