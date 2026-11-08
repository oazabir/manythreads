import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { MEETINGS_SEARCH_CAPABILITY, MeetingsSearchInput, MeetingsSearchOutput } from '@manythreads/shared';

// Work package S7 (P15-13): the `meetings.search` capability. It answers a bot with the lines of meetings the person it acts for may read, and the notes of those meetings: the
// same answer that person's own search gets (`GET /api/search`, kind meetings). The database decides, never this file: `app.search_meetings` (search 0007) is SECURITY INVOKER, so it
// reads `meetings`, `meeting_segments`, `meeting_participants` and `meeting_notes` through their policies as the asking actor (a bot's transaction takes its asker's visibility), keeps
// only the words of a speaker whose answer to "Transcribe my voice" is yes, and leaves out a note-taker's transcript while it is still the organizer's own.

type Row = {
  meeting_id: string;
  title: string;
  team_id: string | null;
  channel_id: string | null;
  at_ms: number;
  speaker_name: string | null;
  snippet: string;
  in_notes: boolean;
  started_at: Date;
};

/** The hits for words, best first, as the actor of `tx` may read them. A text under two characters finds nothing. */
export async function searchMeetingLines(tx: PluginTx, input: MeetingsSearchInput): Promise<MeetingsSearchOutput> {
  const query = input.query.split('\u0000').join('').replace(/\s+/g, ' ').trim();
  const res = await tx.query<Row>('SELECT meeting_id, title, team_id, channel_id, at_ms, speaker_name, snippet, in_notes, started_at FROM app.search_meetings($1, $2, $3)', [
    query,
    input.teamId ?? null,
    input.limit,
  ]);
  return MeetingsSearchOutput.parse({
    hits: res.rows.map((r) => ({
      meetingId: r.meeting_id,
      title: r.title,
      teamId: r.team_id,
      channelId: r.channel_id,
      atMs: r.at_ms,
      speakerName: r.speaker_name,
      snippet: r.snippet.slice(0, 300),
      where: r.in_notes ? 'notes' : 'transcript',
      startedAt: r.started_at.toISOString(),
    })),
  });
}

export function registerSearch(ctx: PluginContext): void {
  ctx.capabilities.register(MEETINGS_SEARCH_CAPABILITY, async (input, tx) => searchMeetingLines(tx, MeetingsSearchInput.parse(input)));
}
