import type { PluginContext, PluginTx, RepoProvider } from '@manythreads/sdk';
import { TeamMeetingsConfig, type MeetingsSettings, type MeetingTranscribeMode, type MeetingTranscription } from '@manythreads/shared';
import { parse as parseYaml } from 'yaml';

// What may be turned on in a room: the lower of two caps (docs/plugins/meetings.md).
//   * the workspace switch, `app.meeting_settings.transcribe_cap` (default `on_device`), set by a workspace admin;
//   * the team's `TEAM.md`, under `meetings` in the frontmatter:
//       meetings:
//         transcribe: on-device      on-device (the default), server, or off
// A key that is LEFT OUT means the default. A key that is PRESENT but cannot be read (not YAML, `meetings` not a mapping, a value outside its choices) is not
// "nothing said": it reads as `off`, so a typo can never open what the team meant to keep closed. Nothing here throws.
// A direct-message call has no team, so only the workspace switch applies.

/** Lowest to highest: what each cap allows. */
const RANK: Record<MeetingTranscription, number> = { off: 0, on_device: 1, server: 2 };

export const lowerCap = (a: MeetingTranscription, b: MeetingTranscription): MeetingTranscription => (RANK[a] <= RANK[b] ? a : b);

const TEAM_VALUE: Record<TeamMeetingsConfig['transcribe'], MeetingTranscription> = { 'on-device': 'on_device', server: 'server', off: 'off' };

const frontmatterOf = (text: string): string | null => {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m ? (m[1] as string) : null;
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The most the team's `TEAM.md` lets a room turn on. No file, no frontmatter or no `meetings` key: `on_device`. Present but unreadable: `off`. */
export function readTeamTranscribeCap(teamMd: string | null): MeetingTranscription {
  if (teamMd === null) return 'on_device';
  const block = frontmatterOf(teamMd);
  if (block === null) return 'on_device';
  let doc: unknown;
  try {
    doc = parseYaml(block, { maxAliasCount: 20 });
  } catch {
    return 'off';
  }
  if (doc === null || doc === undefined) return 'on_device';
  if (!isRecord(doc)) return 'off';
  const meetings = doc['meetings'];
  if (meetings === undefined || meetings === null) return 'on_device';
  if (!isRecord(meetings)) return 'off';
  const parsed = TeamMeetingsConfig.safeParse(meetings);
  if (!parsed.success) return 'off';
  return TEAM_VALUE[parsed.data.transcribe];
}

/** The team's cap from the TEAM.md at the head of its repository (main) (as the transaction's actor). No repository yet or no file: `on_device`; a file that cannot be read: `off`. */
export async function loadTeamTranscribeCap(ctx: PluginContext, tx: PluginTx, teamId: string): Promise<MeetingTranscription> {
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) return readTeamTranscribeCap(null);
  try {
    const blob = await repo.blob(tx, teamId, 'TEAM.md', 'main', 256 * 1024);
    return readTeamTranscribeCap(new TextDecoder().decode(blob.content));
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (status === 404) return readTeamTranscribeCap(null);
    return 'off';
  }
}

/** The workspace switch (default `on_device` when an admin never set it). */
export async function loadWorkspaceTranscribeCap(tx: PluginTx): Promise<MeetingTranscription> {
  const row = (await tx.query<{ transcribe_cap: MeetingTranscription }>('SELECT transcribe_cap FROM app.meeting_settings WHERE workspace_id = app.workspace_id()')).rows[0];
  return row?.transcribe_cap ?? 'on_device';
}

/** The workspace switches as the settings screen shows them (defaults for what an admin never set). */
export async function loadMeetingsSettings(tx: PluginTx): Promise<MeetingsSettings> {
  const row = (
    await tx.query<{ transcribe_cap: MeetingTranscription; room_cap: number; recording_cap: 'off' | 'on'; notetaker_allowed: boolean }>(
      'SELECT transcribe_cap, room_cap, recording_cap, notetaker_allowed FROM app.meeting_settings WHERE workspace_id = app.workspace_id()',
    )
  ).rows[0];
  return { transcribeCap: row?.transcribe_cap ?? 'on_device', roomCap: row?.room_cap ?? 25, recordingCap: row?.recording_cap ?? 'off', notetakerAllowed: row?.notetaker_allowed ?? true };
}

/** Why nothing may be turned on, in plain words, naming who closed it. */
export function reasonFor(workspace: MeetingTranscription, team: MeetingTranscription | null): string {
  if (workspace === 'off') return 'Transcription is switched off for this workspace. A workspace admin can allow it.';
  if (team === 'off') return 'Transcription is switched off for this team. A team lead can allow it in the team’s TEAM.md.';
  return 'Transcription is not allowed here.';
}

/** The modes a room may turn on under `cap`, the device first. */
export function allowedModes(cap: MeetingTranscription): MeetingTranscribeMode[] {
  return cap === 'server' ? ['on_device', 'server'] : cap === 'on_device' ? ['on_device'] : [];
}

export interface TranscribeLimits {
  allowed: MeetingTranscribeMode[];
  reason: string | null;
}

/** What the caller may turn on in a room of this team (`teamId` null for a direct-message call). */
export async function transcribeLimits(ctx: PluginContext, tx: PluginTx, teamId: string | null): Promise<TranscribeLimits> {
  const workspace = await loadWorkspaceTranscribeCap(tx);
  const team = teamId === null ? null : await loadTeamTranscribeCap(ctx, tx, teamId);
  const cap = team === null ? workspace : lowerCap(workspace, team);
  const allowed = allowedModes(cap);
  return { allowed, reason: allowed.length === 0 ? reasonFor(workspace, team) : null };
}
