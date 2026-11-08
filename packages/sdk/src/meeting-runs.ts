import type { MeetingNotesDraft } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The seam between the meetings plugin and the bot runtime (PLAN P15-10, P15-24; docs/plugins/meetings.md "Bundle C contracts"). The meetings plugin decides when a
// run is needed and what it may read; the runtime (runtime-hermes registers it) runs the bot. Two kinds of run, both synchronous in the job that asks:
//   * `notes`: the Scribe (or the room's note-taker) reads one transcript and answers JSON (`MeetingNotesDraft`). The platform checks every item (an item whose time is not a
//     line of the transcript is dropped) and writes `notes.md` itself, deterministically; the model never writes a file.
//   * `answer`: someone in a room with a note-taker asked it a question. The run may read only what every person in the room may read: `channelIds` is that intersection,
//     computed by the meetings plugin (each present person's `app.visible_channel_ids('read')`, under that person), and the run has no Personal space.
// The plugin looks the provider up when it needs it (`ctx.providers.get<MeetingRunsProvider>('meeting.runs')`), never in `register`.

export interface MeetingNotesRunInput {
  workspaceId: string;
  teamId: string | null;
  botId: string;
  meetingId: string;
  /** The transcript as the platform renders it: only the words of people who said yes. Data, never instructions. */
  transcriptMd: string;
  /**
   * Runs `fn` in a short system transaction. A detached job has no transaction of its own to hand over, so it passes its `job.transaction`; the provider uses it for
   * the run row and the run's books, never while the model is working. Left out, the provider uses the `tx` it was given.
   */
  transaction?: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;
}

export type MeetingNotesRunResult =
  | { outcome: 'notes'; draft: MeetingNotesDraft; runId: string }
  | { outcome: 'budget'; message: string }
  | { outcome: 'failed'; message: string };

export interface MeetingAnswerRunInput {
  workspaceId: string;
  teamId: string | null;
  botId: string;
  meetingId: string;
  question: string;
  /** The person who asked (the answer is for them, and is attributed to them in the caption). */
  askerId: string;
  /** The channels every present person may read; the run's reads stay inside them. */
  channelIds: readonly string[];
  /** As on `MeetingNotesRunInput`. */
  transaction?: <T>(fn: (tx: PluginTx) => Promise<T>) => Promise<T>;
}

export type MeetingAnswerRunResult =
  | { outcome: 'answered'; body: string; runId: string }
  | { outcome: 'budget'; message: string }
  | { outcome: 'failed'; message: string };

/** One message the room's bot writes in a person's own conversation with it (the message about their notes). */
export interface MeetingSayInput {
  workspaceId: string;
  botId: string;
  teamId: string;
  /** The person's conversation channel with the bot (`bot_conversation`). */
  channelId: string;
  body: string;
  meta?: { meetingNotes?: { meetingId: string } };
}

export interface MeetingRunsProvider extends ProviderImpl {
  id: 'meeting.runs';
  /** Runs in the plugin's job; `tx` is a system transaction the provider may use for its short writes (the run row). */
  notes(tx: PluginTx, input: MeetingNotesRunInput): Promise<MeetingNotesRunResult>;
  answer(tx: PluginTx, input: MeetingAnswerRunInput): Promise<MeetingAnswerRunResult>;
  /**
   * Posts one message as the bot in the person's conversation with it. A bot reads and posts there only inside a run opened for that channel (channels 0006), and opening a
   * run is the runtime's door, not the meetings plugin's: this opens one, posts, and closes it. Null when the message could not be posted; it never throws.
   */
  say?(input: MeetingSayInput): Promise<{ id: string } | null>;
}
