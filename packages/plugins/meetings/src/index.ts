import { registerMeetingSpaceRoutes } from './routes-spaces.ts';
import { registerAppointmentReminder, registerAppointmentRoutes } from './routes-appointments.ts';
import { registerSeriesJobs, registerSeriesRoutes } from './series.ts';
import { definePlugin } from '@manythreads/sdk';
import { registerAudioRoutes } from './routes-audio.ts';
import { registerCaptions } from './captions.ts';
import { registerMeetingConsumers } from './consumers.ts';
import { registerLimits } from './limits.ts';
import { registerListener } from './listener.ts';
import { registerMemory } from './memory.ts';
import { registerNotes } from './notes.ts';
import { registerNotesRoutes } from './routes-notes.ts';
import { registerNotetaker } from './notetaker.ts';
import { registerQuestions } from './questions.ts';
import { registerAssistant } from './assistant.ts';
import { registerRecording } from './recording.ts';
import { registerScheduled } from './scheduled.ts';
import { registerScheduledJobs } from './scheduled-jobs.ts';
import { registerScheduledRoutes } from './routes-scheduled.ts';
import { registerSearch } from './search.ts';
import { registerSegments } from './segments.ts';
import { registerShares } from './shares.ts';
import { registerTranscriptRoutes } from './routes-transcript.ts';
import { registerTranscriptWriter } from './writer.ts';
import { registerConsentRoutes } from './routes-consent.ts';
import { registerRingEndJob } from './live.ts';
import { registerMeetingJobs } from './jobs.ts';
import { registerMeetingRoutes } from './routes.ts';
import { registerCallCardRoutes } from './routes-cards.ts';
import { registerInviteRoutes } from './invites.ts';
import { registerShareRequestRoutes } from './share-requests.ts';
import { registerGuestRoutes } from './guests.ts';
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
      emits: [
        'meetings.appointment.changed',
        'meetings.appointment.starting_soon',
        // meeting series (P17-05): made, changed or stopped; ids only
        'meetings.series.changed',
        'meetings.meeting.started',
        'meetings.meeting.ended',
        'meetings.participant.joined',
        'meetings.participant.left',
        'meetings.consent.changed',
        'meetings.transcript.written',
        'meetings.notes.written',
        'meetings.notes.shared',
        'meetings.notes.saved',
        'meetings.notetaker.added',
        'meetings.notetaker.removed',
        'meetings.recording.started',
        'meetings.recording.stopped',
        // the people asked to a call (P15-27); the notifications plugin tells them
        'meetings.invite.sent',
        // "Ask to share" (P17-02): a request for a turn to share a screen, and its answer
        'meetings.share_request.answered',
        // guest links and the waiting room (P17-04): ids and times only, never a guest's name or address
        'meetings.guest_link.created',
        'meetings.guest_link.revoked',
        'meetings.guest.asked',
        'meetings.guest.admitted',
        'meetings.guest.denied',
        'meetings.guest.removed',
        'meetings.guest.left',
        // a guest's answer to "Transcribe my voice?" (P17-04 step 2)
        'meetings.guest.answered',
        // Bundle D (docs/plugins/meetings.md "Bundle D contracts"): rooms planned ahead on a calendar
        'meetings.scheduled.created',
        'meetings.scheduled.changed',
        'meetings.scheduled.cancelled',
        'meetings.scheduled.starting_soon',
        // the organizer's first conversation with the note-taker is made when it tells them their notes are ready (P15-21), the way the conversations plugin makes it
        'channel.channel.created',
      ],
      // channel.message.posted and channel.message.transcribed: a voice message in a call thread becomes a line (P15-14; one of the current client when the server has written its
      // words, P32), and a mention of the note-taker in it is a question (P15-24).
      // meetings.meeting.ended and meetings.transcript.written: the transcript writer and the Scribe start from them (P15-09, P15-10).
      consumes: ['channel.channel.archived', 'channel.member.removed', 'team.member.removed', 'channel.message.posted', 'channel.message.transcribed', 'meetings.meeting.ended', 'meetings.transcript.written'],
    },
    // The Scribe's and the note-taker's tools (P15-10, P15-24) and the search over what was said (P15-13). A bot gets them by listing them in its BOT.md.
    capabilities: [
      { name: 'meetings.read', destructive: false },
      { name: 'meetings.write_notes', destructive: false },
      { name: 'meetings.search', destructive: false },
    ],
    // channels: rooms hang off channels and use app.visible_channel_ids; files and bots: the transcript file and the note-taker bot (later tasks) are foreign keys.
    dependsOn: ['channels', 'files', 'bots'],
    migrations: 'migrations',
  },
  register(ctx) {
    registerMeetingRoutes(ctx);
    registerMeetingSpaceRoutes(ctx);
    registerAppointmentRoutes(ctx);
    registerAppointmentReminder(ctx);
    registerSeriesRoutes(ctx);
    registerSeriesJobs(ctx);
    registerCallCardRoutes(ctx);
    registerInviteRoutes(ctx);
    registerShareRequestRoutes(ctx);
    registerGuestRoutes(ctx);
    registerConsentRoutes(ctx);
    registerRingEndJob(ctx);
    registerMediaWebhook(ctx);
    registerMeetingJobs(ctx);
    registerMeetingConsumers(ctx);
    // Bundle C (docs/plugins/meetings.md "Bundle C contracts"): one call per module.
    registerSegments(ctx);
    registerTranscriptRoutes(ctx);
    registerCaptions(ctx);
    registerLimits(ctx);
    registerTranscriptWriter(ctx);
    registerAudioRoutes(ctx);
    registerNotes(ctx);
    registerNotesRoutes(ctx);
    registerMemory(ctx);
    registerShares(ctx);
    registerNotetaker(ctx);
    registerListener(ctx);
    registerQuestions(ctx);
    // the meeting assistant (P17-06): Ask and Catch me up
    registerAssistant(ctx);
    registerRecording(ctx);
    registerSearch(ctx);
    // Bundle D: one call per module, each a stub until its work package fills it in.
    registerScheduled(ctx);
    registerScheduledJobs(ctx);
    registerScheduledRoutes(ctx);
  },
});
