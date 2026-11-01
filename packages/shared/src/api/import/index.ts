import { z } from 'zod';
import type { ApiRoute } from '../client/route.ts';
import { IsoDateTime } from '../../common/time.ts';
import { ActorId, TeamId } from '../../ids.ts';

// Import from Slack and Mattermost (PLAN P14-13, docs/plugins/import.md): a workspace admin uploads an export, reads a dry-run report that
// writes nothing, then starts the import, which runs in the background and ends with a plain-language report.

export const IMPORT_SOURCES = ['slack', 'mattermost'] as const;
export const ImportSource = z.enum(IMPORT_SOURCES);
export type ImportSource = z.infer<typeof ImportSource>;

/**
 * Where a run is. `uploaded`: the archive is stored and nothing has been read. `analysing`: the dry run is reading it. `analysed`: a dry-run report
 * exists (and the admin may start). `queued` and `running`: the import. `done`, `failed` and `cancelled` end the run (the stored archive is deleted).
 */
export const IMPORT_STATUSES = ['uploaded', 'analysing', 'analysed', 'queued', 'running', 'done', 'failed', 'cancelled'] as const;
export const ImportStatus = z.enum(IMPORT_STATUSES);
export type ImportStatus = z.infer<typeof ImportStatus>;

/** The largest archive an admin may upload (bytes) unless the server is set otherwise with `MANYTHREADS_IMPORT_MAX_BYTES`. */
export const IMPORT_MAX_BYTES_DEFAULT = 1024 * 1024 * 1024;
/** A message longer than this is shortened (the platform's own message limit). */
export const IMPORT_MESSAGE_MAX_CHARS = 40_000;

/** Why something in the archive is left out. The words are fixed; the report says each with a count. */
export const IMPORT_SKIP_REASONS = [
  'app_message',
  'huddle',
  'canvas',
  'system_message',
  'empty_message',
  'channel_without_members',
  'dm_not_matched',
  'private_channel_unknown_members',
  'malformed_entry',
  'refused_entry',
  'line_too_long',
  'orphan_reply',
  'file_not_in_export',
  'message_shortened',
  'reaction_unknown_person',
] as const;
export const ImportSkipReason = z.enum(IMPORT_SKIP_REASONS);
export type ImportSkipReason = z.infer<typeof ImportSkipReason>;

const Count = z.number().int().nonnegative();

/** What a channel of the archive becomes: made now (`create`), made by an earlier run of the same archive (`exists`) or left out (`skip`). */
export const ImportChannelOutcome = z.enum(['create', 'exists', 'skip']);
export type ImportChannelOutcome = z.infer<typeof ImportChannelOutcome>;

export const ImportChannelLine = z.object({
  /** The channel's name in the archive (a direct conversation has no name: its members are counted instead). */
  name: z.string().max(120),
  kind: z.enum(['public', 'private', 'direct']),
  messages: Count,
  outcome: ImportChannelOutcome,
  /** Why a skipped channel is left out; null otherwise. */
  reason: ImportSkipReason.nullable(),
  /** The name it gets here (it may differ from the archive's when that name is taken). Null for a direct conversation or a skipped channel. */
  becomes: z.string().max(80).nullable(),
});
export type ImportChannelLine = z.infer<typeof ImportChannelLine>;

/**
 * What an archive holds and what an import does with it. The same shape is the dry-run report (what would happen) and the final report (what
 * happened): `messages.imported` counts the messages written by this run, `alreadyImported` the ones an earlier run of the same archive wrote.
 */
export const ImportReport = z.object({
  people: z.object({
    total: Count,
    /** Found here by email address: their messages are theirs. */
    matched: Count,
    /** Not found: a placeholder keeps their name on their messages until someone signs in with the same email. */
    placeholders: Count,
    /** The archive has no email for them, so nobody can ever claim their placeholder. */
    withoutEmail: Count,
    /** Matched people who are not on the chosen team, so they are left out of private channels. */
    matchedNotOnTeam: Count,
  }),
  channels: z.object({
    total: Count,
    public: Count,
    private: Count,
    direct: Count,
    imported: Count,
    skipped: Count,
  }),
  messages: z.object({
    total: Count,
    imported: Count,
    alreadyImported: Count,
    threads: Count,
    replies: Count,
    reactions: Count,
    mentions: Count,
  }),
  files: z.object({
    total: Count,
    /** Files whose bytes were in the archive. */
    inArchive: Count,
    /** Files the archive only names: the message keeps a note with the file's name. */
    notInArchive: Count,
  }),
  skipped: z.array(z.object({ reason: ImportSkipReason, count: Count })).max(IMPORT_SKIP_REASONS.length),
  channelLines: z.array(ImportChannelLine).max(200),
  /** Plain sentences the admin reads first (at most 40). */
  lines: z.array(z.string().max(300)).max(40),
});
export type ImportReport = z.infer<typeof ImportReport>;

export const ImportProgress = z.object({
  phase: z.enum(['people', 'channels', 'messages', 'finishing']),
  messagesDone: Count,
  messagesTotal: Count,
  channelsDone: Count,
  channelsTotal: Count,
});
export type ImportProgress = z.infer<typeof ImportProgress>;

export const ImportRun = z.object({
  id: z.uuid(),
  source: ImportSource,
  status: ImportStatus,
  /** The archive's file name as the admin gave it (shown to admins only; never in the audit log). */
  fileName: z.string().max(200),
  size: z.number().int().nonnegative(),
  teamId: TeamId,
  teamSlug: z.string().max(80),
  createdBy: ActorId,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  finishedAt: IsoDateTime.nullable(),
  /** The dry-run report; null until a dry run has finished. */
  dryRun: ImportReport.nullable(),
  /** The final report; null until the import has ended. */
  result: ImportReport.nullable(),
  progress: ImportProgress.nullable(),
  /** In plain words, why a run failed; null otherwise. */
  error: z.string().max(500).nullable(),
  cancelRequested: z.boolean(),
});
export type ImportRun = z.infer<typeof ImportRun>;

export const ImportRunPathParams = z.object({ runId: z.uuid() });
export type ImportRunPathParams = z.infer<typeof ImportRunPathParams>;

/** Query of the upload: the archive itself is the request body (any content type), so the choices ride in the address. */
export const UploadImportQuery = z.object({
  source: ImportSource,
  /** The slug of the team the channels are made in. */
  team: z.string().min(1).max(80),
  name: z.string().min(1).max(200).optional(),
});
export type UploadImportQuery = z.infer<typeof UploadImportQuery>;
export const uploadImportRoute = { method: 'POST', path: '/api/admin/imports' } as const satisfies ApiRoute;

export const ListImportsResponse = z.object({ items: z.array(ImportRun) });
export type ListImportsResponse = z.infer<typeof ListImportsResponse>;
export const listImportsRoute = { method: 'GET', path: '/api/admin/imports' } as const satisfies ApiRoute;

export const getImportRoute = { method: 'GET', path: '/api/admin/imports/:runId' } as const satisfies ApiRoute;
/** Reads the stored archive and writes the dry-run report. Nothing else is written. */
export const dryRunImportRoute = { method: 'POST', path: '/api/admin/imports/:runId/dry-run' } as const satisfies ApiRoute;
/** Starts the import; refused until a dry run has finished. */
export const startImportRoute = { method: 'POST', path: '/api/admin/imports/:runId/start' } as const satisfies ApiRoute;
/** Asks a queued or running import to stop after the batch it is on. What it already wrote stays. */
export const cancelImportRoute = { method: 'POST', path: '/api/admin/imports/:runId/cancel' } as const satisfies ApiRoute;
export const DeleteImportResponse = z.object({ deleted: z.boolean() });
export type DeleteImportResponse = z.infer<typeof DeleteImportResponse>;
/** Removes a run that is not running, and the archive stored with it. Imported messages stay. */
export const deleteImportRoute = { method: 'DELETE', path: '/api/admin/imports/:runId' } as const satisfies ApiRoute;

/**
 * Any text as a channel name: lowercase letters, digits and single hyphens, 1 to 56 characters, starting with a letter or digit ("Dev Ops!" becomes
 * "dev-ops"; text with no letter or digit becomes "channel"). The channels plugin makes imported channels with it, and the dry run shows the result.
 */
export const importChannelName = (text: string): string => {
  const slug = text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 56).replace(/-+$/g, '');
  return slug === '' ? 'channel' : slug;
};

/** The plain-language name of a skip reason, as the report and the screen say it. */
export const IMPORT_SKIP_WORDS: Record<ImportSkipReason, string> = {
  app_message: 'messages sent by apps and bots',
  huddle: 'huddles',
  canvas: 'canvases',
  system_message: 'join, leave and rename notices',
  empty_message: 'messages with no text and no file',
  channel_without_members: 'private channels with nobody who has an account here',
  dm_not_matched: 'direct conversations where someone has no account here',
  private_channel_unknown_members: 'private channels whose members the archive does not list',
  malformed_entry: 'entries that could not be read',
  refused_entry: 'archive entries refused for safety',
  line_too_long: 'lines that were too long to read',
  orphan_reply: 'replies whose first message is not in the archive (posted on their own)',
  file_not_in_export: 'files the archive names but does not contain',
  message_shortened: 'messages shortened to the length limit',
  reaction_unknown_person: 'reactions by people the archive does not describe',
};

/** The same, for exactly one of them ("1 huddle", "1 reply whose first message is not in the archive"). */
export const IMPORT_SKIP_WORDS_ONE: Record<ImportSkipReason, string> = {
  app_message: 'message sent by an app or bot',
  huddle: 'huddle',
  canvas: 'canvas',
  system_message: 'join, leave or rename notice',
  empty_message: 'message with no text and no file',
  channel_without_members: 'private channel with nobody who has an account here',
  dm_not_matched: 'direct conversation where someone has no account here',
  private_channel_unknown_members: 'private channel whose members the archive does not list',
  malformed_entry: 'entry that could not be read',
  refused_entry: 'archive entry refused for safety',
  line_too_long: 'line that was too long to read',
  orphan_reply: 'reply whose first message is not in the archive (posted on its own)',
  file_not_in_export: 'file the archive names but does not contain',
  message_shortened: 'message shortened to the length limit',
  reaction_unknown_person: 'reaction by a person the archive does not describe',
};

/** What was left out, with the count in front, in the right number: "1 huddle", "3 huddles". */
export const importSkipPhrase = (reason: ImportSkipReason, count: number): string =>
  `${count.toLocaleString('en-US')} ${count === 1 ? IMPORT_SKIP_WORDS_ONE[reason] : IMPORT_SKIP_WORDS[reason]}`;
