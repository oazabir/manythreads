import { definePlugin } from '@manythreads/sdk';
import { registerMeetingConsumers } from './consumers.ts';
import { registerConsentRoutes } from './routes-consent.ts';
import { registerRingEndJob } from './live.ts';
import { registerMeetingJobs } from './jobs.ts';
import { registerMeetingRoutes } from './routes.ts';
import { registerMediaWebhook } from './webhook.ts';

/**
 * Voice rooms (PLAN P15-03): one live room per channel, opened from the channel (a DM call uses the DM's channel). The plugin owns the room, who is in it and
 * the routes; the audio is carried by whichever `provider.media` plugin `MANYTHREADS_MEDIA_PROVIDER` names (media-livekit by default). Without a media server
 * every route that needs one answers 409 with a plain reason. docs/plugins/meetings.md.
 */
export default definePlugin({
  manifest: {
    name: 'meetings',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit', 'event.subscribe', 'job.register'],
    events: {
      emits: ['meetings.meeting.started', 'meetings.meeting.ended', 'meetings.participant.joined', 'meetings.participant.left', 'meetings.consent.changed'],
      consumes: ['channel.member.removed', 'team.member.removed'],
    },
    // channels: rooms hang off channels and use app.visible_channel_ids; files and bots: the transcript file and the note-taker bot (later tasks) are foreign keys.
    dependsOn: ['channels', 'files', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerMeetingRoutes(ctx);
    registerConsentRoutes(ctx);
    registerRingEndJob(ctx);
    registerMediaWebhook(ctx);
    registerMeetingJobs(ctx);
    registerMeetingConsumers(ctx);
  },
});
