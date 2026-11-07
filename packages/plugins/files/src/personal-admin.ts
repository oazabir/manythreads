import { Readable } from 'node:stream';
import { BlobNotFoundError, type PluginContext, type PluginTx } from '@manythreads/sdk';
import {
  GetFilesTreeQuery,
  ListPersonalSpaceOpensQuery,
  ListPersonalSpaceOpensResponse,
  OpenPersonalSpaceRequest,
  OpenPersonalSpaceResponse,
  PersonFilesTreePathParams,
  PersonFilesTreeResponse,
  PersonalSpaceOpen,
  PersonalSpacePathParams,
  exportPersonalSpaceRoute,
  getPersonFilesTreeRoute,
  listPersonalSpaceOpensRoute,
  openPersonalSpaceRoute,
  type Cursor,
} from '@manythreads/shared';
import { forbidden, invalid, json, notFound, route } from './http.ts';
import { numberedName } from './names.ts';
import { listTree, requireMember } from './personal.ts';
import { wireFolder } from './rows.ts';
import { storageOf } from './routes.ts';
import { zipStream, type ZipEntry } from './zip.ts';

// P20-13: the admin side of a Personal space. An owner or admin opens one person's space for 60 minutes with a reason (the database function
// `app.open_personal_space` keeps the reason where only that person and the admin read it); while the open is live they see the tree and can
// download everything as a zip; the person sees every open in a list. Nothing here lets anyone write into the space: an open is read-only in the
// row policies themselves (files 0005).

interface LiveOpen {
  accessId: string;
  validUntil: Date;
  displayName: string;
}

/**
 * Names for the entries of an export. The archive is built from names a person chose, and an admin unpacks it on their own machine: a folder called
 * `C:` must not become a drive, nor `a:b` a stream, so the characters Windows refuses become `_` (a file name has lost them already), and two paths that
 * differ only in case, which Windows treats as one, get ` (2)` so the second does not overwrite the first when unpacked.
 */
const ARCHIVE_UNSAFE = /[<>:"|?*]/g;
function archiveNames(): { folder: (path: string) => string | null; file: (path: string) => string } {
  const used = new Set<string>();
  const clean = (path: string): string => path.split('/').map((segment) => segment.replace(ARCHIVE_UNSAFE, '_')).join('/');
  return {
    folder: (path) => {
      const name = `${clean(path)}/`;
      if (used.has(name.toLowerCase())) return null;
      used.add(name.toLowerCase());
      return name;
    },
    file: (path) => {
      const base = clean(path);
      const cut = base.lastIndexOf('/');
      const dir = cut < 0 ? '' : base.slice(0, cut + 1);
      const leaf = base.slice(cut + 1);
      let name = base;
      for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${dir}${numberedName(leaf, n)}`;
      used.add(name.toLowerCase());
      return name;
    },
  };
}

/** The caller's newest unexpired open of this person's space, or 403 with the one sentence a screen needs. */
async function requireLiveOpen(tx: PluginTx, personId: string): Promise<LiveOpen> {
  const role = (await tx.query<{ role: string | null }>('SELECT app.lookup_workspace_role() AS role')).rows[0]?.role ?? null;
  if (role !== 'owner' && role !== 'admin') throw forbidden('Only a workspace owner or admin can look into a Personal space');
  const res = await tx.query<{ id: string; expires_at: Date; display_name: string }>(
    `SELECT psa.id, psa.expires_at, p.display_name
       FROM app.personal_space_access psa JOIN app.people p ON p.id = psa.person_id
      WHERE psa.person_id = $1 AND psa.admin_actor_id = app.actor() AND psa.expires_at > now()
      ORDER BY psa.expires_at DESC LIMIT 1`,
    [personId],
  );
  const row = res.rows[0];
  if (!row) throw forbidden('Open this Personal space first: give a reason, and it opens for 60 minutes');
  return { accessId: row.id, validUntil: row.expires_at, displayName: row.display_name };
}

export function registerPersonalAdminRoutes(ctx: PluginContext): void {
  const emit = ctx.audit.emit;

  ctx.http.route({
    ...openPersonalSpaceRoute,
    schema: { body: OpenPersonalSpaceRequest, response: OpenPersonalSpaceResponse },
    rateLimit: { limit: 20, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { personId } = PersonalSpacePathParams.parse(req.params);
      const { reason } = OpenPersonalSpaceRequest.parse(req.body);
      let opened: { access_id: string; valid_until: Date } | undefined;
      try {
        opened = (await tx.query<{ access_id: string; valid_until: Date }>('SELECT * FROM app.open_personal_space($1, $2)', [personId, reason])).rows[0];
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === '23503') throw notFound('No such person in this workspace');
        if (code === '22023') throw invalid((err as Error).message.startsWith('you cannot') ? 'You cannot open your own Personal space' : 'Give a reason of 1 to 300 characters');
        throw err;
      }
      if (!opened) throw forbidden();
      // The reason is not in the event: it stays in the access table, readable by the admin and the person only.
      await emit(tx, {
        type: 'personal.space.opened',
        personId,
        adminActorId: tx.actor.id,
        accessId: opened.access_id,
        validUntil: opened.valid_until.toISOString(),
      });
      return json(OpenPersonalSpaceResponse.parse({ accessId: opened.access_id, validUntil: opened.valid_until.toISOString() }));
    }),
  });

  ctx.http.route({
    ...getPersonFilesTreeRoute,
    schema: { query: GetFilesTreeQuery, response: PersonFilesTreeResponse },
    handler: route(async (req, tx) => {
      const { personId } = PersonFilesTreePathParams.parse(req.params);
      const q = GetFilesTreeQuery.parse(req.query);
      const open = await requireLiveOpen(tx, personId);
      const tree = await listTree(tx, personId, q.path, q.limit, { readOnly: true });
      return json(PersonFilesTreeResponse.parse({ ...tree, validUntil: open.validUntil.toISOString(), displayName: open.displayName }));
    }),
  });

  // One zip of everything the person keeps: their folders (empty ones too) and each file's current content. Counts go to the log, names do not.
  ctx.http.route({
    ...exportPersonalSpaceRoute,
    rateLimit: { limit: 5, windowMs: 60_000 },
    handler: route(async (req, tx) => {
      const { personId } = PersonalSpacePathParams.parse(req.params);
      const open = await requireLiveOpen(tx, personId);
      const storage = storageOf(ctx);
      const folders = (await tx.query<{ path: string }>('SELECT path FROM app.personal_folders WHERE owner_person_id = $1 ORDER BY path', [personId])).rows;
      const files = (
        await tx.query<{ folder_path: string; name: string; blob_key: string; size: string | number; created_at: Date; updated_at: Date | null }>(
          'SELECT folder_path, name, blob_key, size, created_at, updated_at FROM app.files WHERE owner_person_id = $1 ORDER BY folder_path COLLATE "C", name COLLATE "C"',
          [personId],
        )
      ).rows;
      const safe = (path: string): boolean => path.length > 0 && !path.startsWith('/') && !path.split('/').some((p) => p === '' || p === '.' || p === '..');
      const entries: ZipEntry[] = [];
      const missing: string[] = [];
      const names = archiveNames();
      for (const f of folders) {
        const name = safe(f.path) ? names.folder(f.path) : null;
        if (name) entries.push({ name, size: 0 });
      }
      let bytes = 0;
      let count = 0;
      for (const f of files) {
        const name = `${wireFolder(f.folder_path)}/${f.name}`;
        if (!safe(name)) continue;
        if ((await storage.head(f.blob_key)) === null) {
          missing.push(name);
          continue;
        }
        const size = Number(f.size);
        count += 1;
        bytes += size;
        entries.push({
          name: names.file(name),
          size,
          modified: f.updated_at ?? f.created_at,
          open: async () => {
            try {
              return await storage.get(f.blob_key);
            } catch (err) {
              if (err instanceof BlobNotFoundError) return (async function* () { /* the bytes vanished since the check: an empty entry */ })();
              throw err;
            }
          },
        });
      }
      if (missing.length > 0) {
        const note = Buffer.from(`These files could not be read from storage and are not in this archive:\n${missing.join('\n')}\n`, 'utf8');
        entries.push({ name: 'MISSING-FILES.txt', size: note.length, open: async () => (async function* () { yield note; })() });
      }
      await emit(tx, { type: 'personal.space.exported', personId, adminActorId: tx.actor.id, accessId: open.accessId, fileCount: count, bytes });
      return {
        status: 200,
        // The server sends a Node Readable as raw bytes (anything else would be written as JSON).
        body: Readable.from(zipStream(entries), { objectMode: false }),
        headers: {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="personal-space-${personId.slice(0, 8)}.zip"`,
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
      };
    }),
  });

  // Who opened my space, why, and when (the person's own list).
  ctx.http.route({
    ...listPersonalSpaceOpensRoute,
    schema: { query: ListPersonalSpaceOpensQuery, response: ListPersonalSpaceOpensResponse },
    handler: route(async (req, tx) => {
      await requireMember(tx);
      const q = ListPersonalSpaceOpensQuery.parse(req.query);
      const res = await tx.query<{ id: string; admin_person_id: string | null; admin_name: string; reason: string; opened_at: Date; expires_at: Date; active: boolean }>(
        'SELECT * FROM app.personal_space_opens($1, $2)',
        [q.limit + 1, q.before ?? null],
      );
      const more = res.rows.length > q.limit;
      const rows = more ? res.rows.slice(0, q.limit) : res.rows;
      const items = rows.map((r) =>
        PersonalSpaceOpen.parse({
          id: r.id,
          adminPersonId: r.admin_person_id,
          adminName: r.admin_name,
          reason: r.reason,
          openedAt: r.opened_at.toISOString(),
          validUntil: r.expires_at.toISOString(),
          active: r.active,
        }),
      );
      return json(ListPersonalSpaceOpensResponse.parse({ items, nextCursor: more ? (items.at(-1)!.id as Cursor) : null }));
    }),
  });
}
