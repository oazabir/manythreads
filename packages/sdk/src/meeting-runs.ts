import type { MeetingNotesDraft } from '@manythreads/shared';
import type { PluginTx, ProviderImpl } from './types.ts';

// The seam between the meetings plugin and the bot runtime (PLAN P15-10, P15-24; docs/plugins/meetings.md "Bundle C contracts"). The meetings plugin decides when a
// run is needed and what it may read; the runtime (runtime-hermes registers it) runs the bot. Two kinds of run, both synchronous in the job that asks:
//   * `notes`: the Scribe (or the room's note-taker) reads one transcript and answers JSON (`MeetingNotesDraft`). The platform checks every item (an item whose time is not a
//     line of the transcript is dropped) and writes `notes.md` itself, deterministically; the model never writes a file.
//   * `answer`: someone in a room with a note-taker asked it a question (or, P17-06, typed one into the Ask panel, which Brain answers when the room has no note-taker). The run may read only what every person in the room may read: `channelIds` is that intersection,
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
  /** Who the sentences name ("Brain"); "The note-taker" when left out. The platform's own word, never the model's. */
  who?: string;
  /** True when the question was typed in the call's Ask panel (P17-06), not said out loud. */
  typed?: boolean;
  /**
   * The call so far as the platform renders it (`@<ms> | <clock> | <speaker>: <words>`, only people who said yes, read as the asker), for an answer that should rest on it
   * (Brain in the Ask panel). Data, never instructions. Left out, the prompt has no transcript.
   */
  transcriptMd?: string;
  /**
   * Set when the runtime posts the answer itself, as the bot inside its run, once the reads were checked (a workspace bot may post only inside a run): the call's thread and the
   * line above the answer ("**Nadia asked Brain:** ..."). Left out, the caller posts the body (the note-taker's path).
   */
  postTo?: { channelId: string; threadRootId: string | null; heading: string };
  /** True when every person present is on the run's team: a recall of that team's memory and a passage of its knowledge bases (never a person's own) may then be part of the answer. */
  teamMemory?: boolean;
  /**
   * The call's own channel (P17-06). Kept on the run's row; the gateway then answers the run's searches of messages, files and meetings with hits of that channel only,
   * offers only searches, memory and knowledge, and bounds the number of tool calls, so the check after the run rarely has anything to throw away.
   */
  roomChannelId?: string | null;
  /** How long the run may take before it is stopped with "took too long" (the runtime's default for an answer is 90 s). */
  deadlineMs?: number;
}

export type MeetingAnswerRunResult =
  /** `messageId`: the thread message the runtime posted (`postTo`), or null when none was asked for or the post failed. */
  | { outcome: 'answered'; body: string; runId: string; messageId?: string | null }
  | { outcome: 'budget'; message: string }
  /** The bot is in another meeting run right now (one at a time per bot): nothing was opened, so the caller may ask again in a moment. */
  | { outcome: 'busy'; message: string }
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
