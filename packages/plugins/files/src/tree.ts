import { z } from 'zod';
import { HttpError, type PluginContext, type PluginTx, type RepoFolderEntry, type RepoProvider } from '@manythreads/sdk';
import {
  FILES_CHANNELS_DIR,
  FILES_MEMORY_DIR,
  FilesTreeEntry,
  FilesTreeFolder,
  FilesTreePathParams,
  GetFilesTreeQuery,
  GetFilesTreeResponse,
  getFilesTreeRoute,
  isGuardedRepoPath,
  repoMimeOf,
  type FilesReadOnlyReason,
} from '@manythreads/shared';
import { forbidden, notFound, route } from './http.ts';
import { FILE_COLUMNS, type FileRow } from './rows.ts';

// The Files tree (SPEC section 5.2, PLAN P4-06): one listing over the team repo (through the `repo` provider, git) and the attachments of channels
// (`channels/<name>/`, the `files` table). Both stores answer with the same row. Access is decided per folder by the stores' own rules, on every read:
// the repo by team membership (row level security on the team), `channels/<name>/` by the channel's ACL (the channels the caller can read).
// A channel the caller cannot read looks like one that does not exist (403 for both).

type TeamRow = { id: string; slug: string; can_post: boolean; can_manage: boolean };

type ChannelRow = { id: string; name: string; can_post: boolean; last_file_at: Date | null; last_uploader: string | null };

type Entry = FilesTreeEntry;
type Reason = FilesReadOnlyReason | null;

const byKindThenName = (a: Entry, b: Entry): number =>
  a.kind === b.kind ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'folder' ? -1 : 1;

const isMemoryPath = (path: string): boolean => path === FILES_MEMORY_DIR || path.startsWith(`${FILES_MEMORY_DIR}/`);

/** The team as the caller sees it. A team they cannot see is 403 (an admin sees every team, so for them a missing slug is 404). */
async function requireTeam(tx: PluginTx, slug: string): Promise<TeamRow> {
  const res = await tx.query<TeamRow>(
    "SELECT t.id, t.slug, app.can('team', t.id, 'post') AS can_post, app.can('team', t.id, 'manage') AS can_manage FROM app.teams t WHERE t.slug = $1",
    [slug],
  );
  const team = res.rows[0];
  if (team) return team;
  const admin = await tx.query<{ admin: boolean }>('SELECT app.is_workspace_admin() AS admin');
  throw admin.rows[0]?.admin === true ? notFound('Team not found') : forbidden('You are not a member of this team');
}

/** What a refusal of the repo service (it carries `status` and `code`) means over HTTP. */
function mapRepoError(err: unknown): never {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
  if (e?.name === 'RepoError' && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    throw new HttpError(e.status, (e.code ?? 'validation_failed') as never, e.message ?? 'Refused');
  }
  throw err;
}

export function registerTreeRoute(ctx: PluginContext): void {
  ctx.http.route({
    ...getFilesTreeRoute,
    schema: { query: GetFilesTreeQuery },
    handler: route(async (req, tx) => {
      const { slug } = FilesTreePathParams.parse(req.params);
      const q = GetFilesTreeQuery.parse(req.query);
      const team = await requireTeam(tx, slug);
      const segments = q.path === '' ? [] : q.path.split('/');
      const repoReason = (path: string): Reason =>
        isGuardedRepoPath(path) && !team.can_manage ? 'change_by_pull_request' : team.can_post ? null : 'no_write_access';

      const repoRow = (e: RepoFolderEntry): Entry =>
        FilesTreeEntry.parse({
          kind: e.kind,
          path: e.path,
          name: e.name,
          size: e.size,
          mime: e.kind === 'file' ? repoMimeOf(e.path) : null,
          updatedAt: e.updatedAt,
          updatedBy: e.updatedBy,
          source: 'repo',
          readOnly: repoReason(e.path) !== null,
          readOnlyReason: repoReason(e.path),
          managedBy: isMemoryPath(e.path) ? 'team_memory' : null,
          fileId: null,
          channelId: null,
          blobSha: e.blobSha,
          contentUrl: e.kind === 'file' ? `/api/teams/${encodeURIComponent(team.slug)}/repo/content?path=${encodeURIComponent(e.path)}` : null,
        });

      const channelFolder = (c: ChannelRow): Entry =>
        FilesTreeEntry.parse({
          kind: 'folder',
          path: `${FILES_CHANNELS_DIR}/${c.name}`,
          name: c.name,
          size: null,
          mime: null,
          updatedAt: c.last_file_at ? c.last_file_at.toISOString() : null,
          updatedBy: c.last_uploader,
          source: 'attachment',
          readOnly: !c.can_post,
          readOnlyReason: c.can_post ? null : 'no_write_access',
          managedBy: null,
          fileId: null,
          channelId: c.id,
          blobSha: null,
          contentUrl: null,
        });

      const repoProvider = (): RepoProvider => {
        const provider = ctx.providers.get<RepoProvider>('repo');
        if (!provider) throw new HttpError(503, 'internal', 'The team repository is not available');
        return provider;
      };

      // The channels the caller can read in this team (row level security), each with its newest upload.
      const channels = async (name?: string): Promise<ChannelRow[]> => {
        const res = await tx.query<ChannelRow>(
          `SELECT c.id, c.name,
                  c.id = ANY ((SELECT app.visible_channel_ids('post'))::uuid[]) AS can_post,
                  lf.created_at AS last_file_at, lf.uploader_id AS last_uploader
             FROM app.channels c
             LEFT JOIN LATERAL (SELECT f.created_at, f.uploader_id FROM app.files f WHERE f.channel_id = c.id ORDER BY f.id DESC LIMIT 1) lf ON true
            WHERE c.team_id = $1 AND c.kind = 'channel' AND ($2::text IS NULL OR c.name = $2)
            ORDER BY c.name COLLATE "C"`,
          [team.id, name ?? null],
        );
        return res.rows;
      };

      const finish = (folder: z.input<typeof FilesTreeFolder>, rows: Entry[]) => {
        const sorted = [...rows].sort(byKindThenName);
        const truncated = sorted.length > q.limit;
        return {
          body: GetFilesTreeResponse.parse({ path: q.path, folder: FilesTreeFolder.parse(folder), entries: truncated ? sorted.slice(0, q.limit) : sorted, truncated }),
        };
      };

      // channels/...
      if (segments[0] === FILES_CHANNELS_DIR) {
        if (segments.length === 1) {
          const rows = (await channels()).map(channelFolder);
          return finish(
            { path: FILES_CHANNELS_DIR, source: 'attachment', readOnly: true, readOnlyReason: 'attachment', managedBy: null, channelId: null },
            rows,
          );
        }
        const channel = (await channels(segments[1]))[0];
        if (!channel) throw forbidden('You cannot see this channel');
        if (segments.length > 2) throw notFound('Attachment folders have no sub-folders');
        const files = await tx.query<FileRow>(
          `SELECT ${FILE_COLUMNS} FROM app.files f WHERE f.channel_id = $1 ORDER BY f.name COLLATE "C", f.id LIMIT $2`,
          [channel.id, q.limit + 1],
        );
        const rows: Entry[] = files.rows.map((f) =>
          FilesTreeEntry.parse({
            kind: 'file',
            path: `${FILES_CHANNELS_DIR}/${channel.name}/${f.name}`,
            name: f.name,
            size: Number(f.size),
            mime: f.mime,
            updatedAt: f.created_at.toISOString(),
            updatedBy: f.uploader_id,
            source: 'attachment',
            readOnly: true,
            readOnlyReason: 'attachment',
            managedBy: null,
            fileId: f.id,
            channelId: channel.id,
            blobSha: null,
            contentUrl: `/api/files/${f.id}/content`,
          }),
        );
        return finish(
          {
            path: q.path,
            source: 'attachment',
            readOnly: !channel.can_post,
            readOnlyReason: channel.can_post ? null : 'no_write_access',
            managedBy: null,
            channelId: channel.id,
          },
          rows,
        );
      }

      // the repo (and, at the root, the channels folder beside it)
      let entries: RepoFolderEntry[];
      try {
        entries = await repoProvider().list(tx, team.id, q.path);
      } catch (err) {
        if (segments.length === 0 && err instanceof HttpError && err.status === 503) entries = [];
        else return mapRepoError(err);
      }
      const rows = entries.filter((e) => !(segments.length === 0 && e.name === FILES_CHANNELS_DIR)).map(repoRow);
      if (segments.length === 0) {
        const channelsAt = (await channels()).reduce<{ at: Date | null; by: string | null }>(
          (best, c) => (c.last_file_at && (!best.at || c.last_file_at > best.at) ? { at: c.last_file_at, by: c.last_uploader } : best),
          { at: null, by: null },
        );
        rows.push(
          FilesTreeEntry.parse({
            kind: 'folder',
            path: FILES_CHANNELS_DIR,
            name: FILES_CHANNELS_DIR,
            size: null,
            mime: null,
            updatedAt: channelsAt.at ? channelsAt.at.toISOString() : null,
            updatedBy: channelsAt.by,
            source: 'attachment',
            readOnly: true,
            readOnlyReason: 'attachment',
            managedBy: null,
            fileId: null,
            channelId: null,
            blobSha: null,
            contentUrl: null,
          }),
        );
      }
      const reason: Reason = q.path === '' ? (team.can_post ? null : 'no_write_access') : repoReason(q.path);
      return finish(
        { path: q.path, source: 'repo', readOnly: reason !== null, readOnlyReason: reason, managedBy: isMemoryPath(q.path) ? 'team_memory' : null, channelId: null },
        rows,
      );
    }),
  });
}
