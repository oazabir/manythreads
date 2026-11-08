import type { PluginContext, PluginEvent, PluginTx } from '@manythreads/sdk';

// Work package C (P16-05, decision D7): "starts in 5 minutes". The meetings plugin's reminder job says `meetings.scheduled.starting_soon` once per plan, with the invited people's ids; this makes one
// notification of the kind `meeting_soon` per invited person who can still read the room's channel ("Design review starts in 5 minutes", from the organizer, opening `/join/<id>`; the row's
// reference is the plan, `ref_type = scheduled_meeting`). Like a reminder, no channel level silences it; Do not disturb holds it, and the browser push is sent like the other kinds
// (`push.ts` words the title and the link). One row per person and plan: the event delivered twice writes nothing the second time. STUB: subscribes and returns at once until C fills it in.
export function registerMeetingSoon(ctx: PluginContext): void {
  ctx.events.subscribe('meetings.scheduled.starting_soon', async (raw: PluginEvent, tx: PluginTx) => {
    void [raw, tx];
  });
}
