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
}

export type MeetingAnswerRunResult =
  | { outcome: 'answered'; body: string; runId: string }
  | { outcome: 'budget'; message: string }
  | { outcome: 'failed'; message: string };

export interface MeetingRunsProvider extends ProviderImpl {
  id: 'meeting.runs';
  /** Runs in the plugin's job; `tx` is a system transaction the provider may use for its short writes (the run row). */
  notes(tx: PluginTx, input: MeetingNotesRunInput): Promise<MeetingNotesRunResult>;
  answer(tx: PluginTx, input: MeetingAnswerRunInput): Promise<MeetingAnswerRunResult>;
}
