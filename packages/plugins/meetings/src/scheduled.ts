import type { PluginContext } from '@manythreads/sdk';

// Work package C (P16-05, decisions D4 to D9): planning a room ahead. The service functions behind `routes-scheduled.ts` and the jobs: make the event at the organizer's own calendar
// (`connector.calendar`, looked up when needed, never in `register`), write the plan with `app.meetings_schedule`, map invited addresses to people (D6), cancel with
// `app.meetings_cancel_scheduled`, and cancel the plans of a channel that is archived. Outside addresses are used for the invitation and forgotten: only their number is kept.
// STUB: nothing is subscribed until C fills it in.
export function registerScheduled(ctx: PluginContext): void {
  void ctx;
}
