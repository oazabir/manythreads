import {
  DEFAULT_PERSONAL_QUOTA_BYTES,
  PERSONAL_SEED_FOLDERS,
  type FilesTreeEntry,
  type GetFilesTreeResponse,
  type PersonalFile,
  type PersonalFileVersion,
} from '@manythreads/shared';
import { ApiError } from '../../api/client';
import { FilesError, type Perms } from './backend';
import { baseName, parentOf } from './model';
import type { PersonalTransport } from './personalBackend';

/*
 * The Personal store behind `?mock=1` and the unit tests: folders and files in memory, with the versions every save keeps. Same rules as the
 * server (a file lives in a folder, a seed folder stays, a name is unique in its folder, the allowance counts versions too). Nothing leaves the page.
 */

type Version = { id: string; size: number; mime: string; text: string | null; at: number; by: string | null };
type MockFile = { id: string; folder: string; name: string; mime: string; at: number; by: string | null; current: Version; older: Version[] };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const hex = (n: number): string => n.toString(16).padStart(64, '0');
const dataUrl = (text: string, mime: string): string => `data:${mime};charset=utf-8,${encodeURIComponent(text)}`;
const sizeOf = (text: string): number => new TextEncoder().encode(text).length;

type World = { files: MockFile[]; folders: Set<string>; seq: number; quota: number };
const worlds = new Map<string, World>();

const SEED_NOTES: Array<[string, string, string, number, string[]]> = [
  ['Notes', 'standup-notes.md', '# Stand-up\n\n- Finish the schedule migration review\n- Ask Rafi about the DNS fallback\n', 3 * HOUR, ['# Stand-up\n\n- Finish the schedule migration review\n', '# Stand-up\n']],
  ['Notes', 'ideas.md', '# Ideas\n\nA weekly digest of what changed in the repo.\n', 2 * DAY, []],
  ['Meetings', 'design-review.md', '# Design review\n\nDecided to keep the household default.\n', DAY, []],
  ['Action items', 'action-items.md', '# Action items\n\n- [ ] Send the QA report to Tariq\n- [x] Book the review room\n', 5 * HOUR, []],
  ['Knowledge', 'glossary.md', '# Glossary\n\nA household is a group of people who share one schedule.\n', 6 * DAY, []],
];

function seed(): World {
  const w: World = { files: [], folders: new Set(PERSONAL_SEED_FOLDERS), seq: 1, quota: DEFAULT_PERSONAL_QUOTA_BYTES };
  const now = Date.now();
  for (const [folder, name, text, ago, olderTexts] of SEED_NOTES) {
    const mime = name.endsWith('.md') ? 'text/markdown' : 'text/plain';
    const older = olderTexts.map((t, i): Version => ({ id: `00000000-0000-7000-8000-0000000b${String(w.seq++).padStart(4, '0')}`, size: sizeOf(t), mime, text: t, at: now - ago - (i + 1) * 2 * HOUR, by: null }));
    w.files.push({ id: `00000000-0000-7000-8000-0000000a${String(w.seq++).padStart(4, '0')}`, folder, name, mime, at: now - ago, by: null, current: { id: 'current', size: sizeOf(text), mime, text, at: now - ago, by: null }, older });
  }
  return w;
}

const world = (key: string): World => {
  let w = worlds.get(key);
  if (!w) {
    w = seed();
    worlds.set(key, w);
  }
  return w;
};

/** Forgets the mock world (tests start clean). */
export const resetMockPersonal = (): void => worlds.clear();

const parents = (path: string): string[] => {
  const out: string[] = [];
  let p = path;
  while (p !== '') {
    out.push(p);
    p = parentOf(p);
  }
  return out;
};

export function mockPersonalTransport(perms: Perms, admin = false): PersonalTransport {
  const w = world(`${perms.personId}${admin ? ':admin' : ''}`);
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  const fileOf = (id: string): MockFile => {
    const f = w.files.find((x) => x.id === id);
    if (!f) throw new FilesError('other', 'That file no longer exists.');
    return f;
  };
  const used = (): number => w.files.reduce((n, f) => n + f.current.size + f.older.reduce((m, v) => m + v.size, 0), 0);
  const toFile = (f: MockFile): PersonalFile => ({
    id: f.id as PersonalFile['id'],
    ownerPersonId: perms.personId as PersonalFile['ownerPersonId'],
    space: `person:${perms.personId}` as PersonalFile['space'],
    folderPath: f.folder,
    name: f.name,
    path: `${f.folder}/${f.name}`,
    size: f.current.size,
    mime: f.mime,
    sha256: hex(f.at),
    createdAt: new Date(f.at).toISOString(),
    updatedAt: new Date(f.at).toISOString(),
    updatedBy: null,
    versionCount: f.older.length,
    contentUrl: dataUrl(f.current.text ?? '', f.mime),
  });
  const entry = (f: MockFile): FilesTreeEntry => ({
    kind: 'file',
    path: `${f.folder}/${f.name}`,
    name: f.name,
    size: f.current.size,
    mime: f.mime,
    updatedAt: new Date(f.at).toISOString(),
    updatedBy: null,
    source: 'attachment',
    readOnly: admin,
    readOnlyReason: admin ? 'admin_view' : null,
    managedBy: null,
    fileId: f.id as FilesTreeEntry['fileId'],
    channelId: null,
    blobSha: null,
    contentUrl: dataUrl(f.current.text ?? '', f.mime),
  });
  const folderEntry = (path: string): FilesTreeEntry => {
    const newest = w.files.filter((f) => f.folder === path || f.folder.startsWith(`${path}/`)).reduce((n, f) => Math.max(n, f.at), 0);
    return {
      kind: 'folder',
      path,
      name: baseName(path),
      size: null,
      mime: null,
      updatedAt: newest ? new Date(newest).toISOString() : null,
      updatedBy: null,
      source: 'attachment',
      readOnly: admin,
      readOnlyReason: admin ? 'admin_view' : null,
      managedBy: path === 'Memory' ? 'personal_memory' : null,
      fileId: null,
      channelId: null,
      blobSha: null,
      contentUrl: null,
    };
  };
  const ensureFolder = (path: string): void => {
    for (const p of parents(path)) w.folders.add(p);
  };
  const taken = (folder: string, name: string, except?: string): boolean => w.files.some((f) => f.folder === folder && f.name === name && f.id !== except);
  const free = (folder: string, name: string): string => {
    if (!taken(folder, name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; ; n++) if (!taken(folder, `${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
  };
  const guardOver = (extra: number): void => {
    if (used() + extra > w.quota) throw new FilesError('other', 'Your Personal files are over their allowance. Delete something to make room.');
  };

  return {
    async tree(path) {
      await pause();
      if (path !== '' && !w.folders.has(path)) throw new ApiError({ code: 'not_found', status: 404, message: 'That folder does not exist.' });
      const folders = [...w.folders].filter((p) => parentOf(p) === path).sort((a, b) => a.localeCompare(b, 'en'));
      const files = path === '' ? [] : w.files.filter((f) => f.folder === path).sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const res: GetFilesTreeResponse & { validUntil?: string; displayName?: string } = {
        path,
        folder: { path, source: 'attachment', readOnly: admin, readOnlyReason: admin ? 'admin_view' : null, managedBy: path === 'Memory' ? 'personal_memory' : null, channelId: null },
        entries: [...folders.map(folderEntry), ...files.map(entry)],
        truncated: false,
      };
      if (admin) {
        res.validUntil = new Date(Date.now() + 52 * 60_000).toISOString();
        res.displayName = 'Nadia';
      }
      return res;
    },
    async upload(folderPath, file, conflict, onProgress) {
      await pause();
      if (folderPath === '') throw new FilesError('other', 'A file lives inside a folder.');
      const text = await file.text();
      const size = sizeOf(text);
      guardOver(size);
      ensureFolder(folderPath);
      const existing = w.files.find((f) => f.folder === folderPath && f.name === file.name);
      onProgress(1);
      if (existing && conflict === 'version') {
        existing.older.unshift({ ...existing.current, id: `00000000-0000-7000-8000-0000000b${String(w.seq++).padStart(4, '0')}` });
        existing.current = { id: 'current', size, mime: file.type || existing.mime, text, at: Date.now(), by: perms.personId };
        existing.at = Date.now();
        return toFile(existing);
      }
      const name = free(folderPath, file.name);
      const mime = file.type || 'application/octet-stream';
      const f: MockFile = { id: `00000000-0000-7000-8000-0000000a${String(w.seq++).padStart(4, '0')}`, folder: folderPath, name, mime, at: Date.now(), by: perms.personId, current: { id: 'current', size, mime, text, at: Date.now(), by: perms.personId }, older: [] };
      w.files.push(f);
      return toFile(f);
    },
    async patch(id, body) {
      await pause();
      const f = fileOf(id);
      const name = body.name ?? f.name;
      const folder = body.folderPath ?? f.folder;
      if (taken(folder, name, f.id)) throw new FilesError('exists', 'Something with that name is already in that folder.');
      ensureFolder(folder);
      f.name = name;
      f.folder = folder;
      f.at = Date.now();
      return toFile(f);
    },
    async remove(id) {
      await pause();
      fileOf(id);
      w.files = w.files.filter((f) => f.id !== id);
    },
    async makeFolder(path) {
      await pause();
      ensureFolder(path);
    },
    async removeFolder(path) {
      await pause();
      if ((PERSONAL_SEED_FOLDERS as readonly string[]).includes(path)) throw new FilesError('conflict', 'That is one of the folders every Personal space starts with, so it stays.');
      const inside = w.files.some((f) => f.folder === path || f.folder.startsWith(`${path}/`)) || [...w.folders].some((p) => p.startsWith(`${path}/`));
      if (inside) throw new FilesError('conflict', 'Only an empty folder can be removed.');
      w.folders.delete(path);
    },
    async versions(id) {
      await pause();
      const f = fileOf(id);
      const item = (v: Version, current: boolean): PersonalFileVersion => ({
        id: current ? null : (v.id as PersonalFileVersion['id']),
        current,
        size: v.size,
        mime: v.mime,
        sha256: hex(v.at),
        authorId: null,
        createdAt: new Date(v.at).toISOString(),
        contentUrl: dataUrl(v.text ?? '', v.mime),
      });
      return [item(f.current, true), ...f.older.map((v) => item(v, false))];
    },
    async restore(id, versionId) {
      await pause();
      const f = fileOf(id);
      const v = f.older.find((x) => x.id === versionId);
      if (!v) throw new FilesError('other', 'That version cannot be restored.');
      f.older = [{ ...f.current, id: `00000000-0000-7000-8000-0000000b${String(w.seq++).padStart(4, '0')}` }, ...f.older.filter((x) => x.id !== versionId)];
      f.current = { ...v, id: 'current', at: Date.now() };
      f.at = Date.now();
      return toFile(f);
    },
    async usage() {
      await pause();
      return { usedBytes: used(), quotaBytes: w.quota, fileCount: w.files.length };
    },
    async check(id, body) {
      await pause();
      const f = fileOf(id);
      void body;
      return /secret|password/i.test(f.current.text ?? '') ? { outcome: 'redact', rules: ['Passwords and keys'] } : { outcome: 'allow', rules: [] };
    },
    async copy(id, body) {
      await pause();
      fileOf(id);
      return { path: body.path, commitSha: '0'.repeat(40), redacted: false };
    },
    text: async (url) => {
      const i = url.indexOf(',');
      return url.startsWith('data:') ? decodeURIComponent(url.slice(i + 1)) : '';
    },
    drop: async () => {
      await pause();
    },
  };
}

// ---- the admin open and the person's own list of opens (`?mock=1` and the tests) ----

type MockOpen = { id: string; adminPersonId: string | null; adminName: string; reason: string; openedAt: string; validUntil: string; active: boolean };
const opens: MockOpen[] = [
  { id: '5b0c1f4e-2a43-4b6a-9d0e-1c7f6a9b2d10', adminPersonId: null, adminName: 'Priya Raman', reason: 'Recovering the budget notes before a handover.', openedAt: new Date(Date.now() - 9 * DAY).toISOString(), validUntil: new Date(Date.now() - 9 * DAY + HOUR).toISOString(), active: false },
];

/** What the admin sees after "Open": a 60-minute window. The mock keeps the open so the person's list shows it. */
export function mockOpenSpace(adminName: string, reason: string): { accessId: string; validUntil: string } {
  const now = Date.now();
  const id = `00000000-0000-4000-8000-${String(opens.length + 1).padStart(12, '0')}`;
  opens.unshift({ id, adminPersonId: null, adminName, reason, openedAt: new Date(now).toISOString(), validUntil: new Date(now + HOUR).toISOString(), active: true });
  return { accessId: id, validUntil: new Date(now + HOUR).toISOString() };
}

export const mockOpens = (): MockOpen[] => opens.map((o) => ({ ...o, active: o.active && Date.parse(o.validUntil) > Date.now() }));
