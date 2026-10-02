import { memorySource } from '../../viewers/source';
import { FilesError, repoRowFlags, type FileContent, type FilesBackend, type Perms } from './backend';
import { lineDiff } from './diff';
import { baseName, channelNameOf, extOf, parentOf, type Actor, type Commit, type FileDiff, type FileRow, type FolderInfo, type Listing } from './model';

/*
 * The store behind `?mock=1`: a team repo and a few channel folders in memory, with a history for each file, so the screen can be driven
 * (and photographed) without a server. Writes keep a version list per path; restore and diff read from it. Nothing leaves the page.
 */

type Version = { sha: string; by: Actor; message: string; at: number; text: string | null };
type Attachment = { path: string; size: number; mime: string; by: Actor; at: number; where: string | null; fileId: string; url: string };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const person = (name: string, id: string): Actor => ({ id, name, kind: 'person' });
const bot = (name: string, id: string): Actor => ({ id, name, kind: 'bot' });
const OMAR = person('Omar', 'mock-omar');
const NADIA = person('Nadia', 'mock-nadia');
const RAFI = person('Rafi', 'mock-rafi');
const TARIQ = person('Tariq', 'mock-tariq');
const CODER = bot('Coder', 'mock-coder');
const TESTER = bot('Tester', 'mock-tester');
const SYSTEM: Actor = { id: null, name: 'manythreads', kind: 'system' };

const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const BOT_MD = (extra: string) => `---
name: Coder
role: Owns a task's branch; pushes, opens PRs, hands to review and test
kind: agent
runtime: hermes
model: {aliases: [code, fast]}
visibility: ${extra}
triggers: [mention, task_assigned]
---

# Coder — Engineering

Owns a task's branch from claim to handover.
`;

const WEEK_37 = `# Week 37

Sessions held steady week over week; the ticket queue grew slightly, mostly follow-ups on the LED flicker batch.

| Metric | Value |
| --- | --- |
| Sessions | 18.4k |
| Tickets | 312 |
| Enquiries | 14 |

Sources: ga:sessions, support:tickets, release-notes-2.4.md
`;

const SEED_TEXT: Record<string, { text: string; mime?: string }> = {
  'TEAM.md': { text: '---\nname: Engineering\nroles: [role:on-call, role:release-manager]\n---\n\n# Engineering\n\nShip and run software.\n' },
  'bots/orchestrator/BOT.md': { text: BOT_MD('team').replace('Coder', 'Orchestrator') },
  'bots/coder/BOT.md': { text: BOT_MD('team') },
  'bots/coder/lessons.md': { text: '# Lessons\n\nBatch per-tenant writes instead of one call per device.\n' },
  'bots/coder/memory.md': { text: '# Memory\n\nThe schedule migration lives in migrations/0042.\n' },
  'bots/reviewer/BOT.md': { text: BOT_MD('team').replace('Coder', 'Reviewer') },
  'bots/tester/BOT.md': { text: BOT_MD('team').replace('Coder', 'Tester') },
  'skills/git-hygiene/SKILL.md': { text: '# Git hygiene\n\nSmall commits, clear subjects.\n' },
  'skills/pr-etiquette/SKILL.md': { text: '# PR etiquette\n\nOne topic per pull request.\n' },
  'routines/weekly-changelog.yaml': { text: 'schedule: "0 9 * * 5"\noutput: pages/reports/changelog.md\n' },
  'routines/monday-brief.yaml': { text: 'schedule: "0 9 * * 1"\noutput: pages/reports/week.md\n' },
  'knowledge/architecture-docs/sources.yaml': { text: 'sources:\n  - kind: repo\n    path: docs/\n' },
  'pages/reports/week-37.md': { text: WEEK_37 },
  'pages/reports/signups.csv': { text: 'week,signups,churn\n2026-W35,412,1.4%\n2026-W36,431,1.2%\n2026-W37,455,1.1%\n', mime: 'text/csv' },
  'pages/specs/schedule-migration.md': { text: '# Schedule migration\n\nExisting profiles migrate to a household default.\n' },
  'apps/deploy-dashboard/index.html': { text: '<!doctype html><title>Deploy dashboard</title><h1>Deploys</h1>\n', mime: 'text/html' },
  'memory/journal/2026-09-26.md': { text: '# 26 September\n\nThe team shipped 2.3.4.\n' },
  'memory/journal/2026-09-27.md': { text: '# 27 September\n\nDNS fallback watched for 24 hours.\n' },
  'memory/facts/release-process.md': { text: '# Release process\n\nA release needs the upgrade test on a 2.3 fixture.\n' },
  'memory/facts/dns-flakiness.md': { text: '# DNS flakiness\n\nThe resolver drops about one lookup in a thousand.\n' },
};

const HISTORY_OF_CODER: Array<[Actor, string, number, string]> = [
  [NADIA, 'widen visibility to workspace', 6 * DAY, 'workspace'],
  [CODER, 'triggers: add task_assigned', 5 * DAY, 'workspace'],
  [RAFI, 'approve rule: warn that updates restart', 4 * DAY, 'workspace'],
  [CODER, 'lessons: batch per-tenant writes', 3 * DAY, 'team'],
  [OMAR, 'Add Spanish handling', 2 * HOUR, 'team'],
];

const ATTACHMENTS: Omit<Attachment, 'fileId' | 'url'>[] = [
  { path: 'channels/release-eng/schedule-inherited.png', size: 184 * 1024, mime: 'image/png', by: TESTER, at: 1 * HOUR, where: 'G-27 thread' },
  { path: 'channels/release-eng/schedule-empty.png', size: 176 * 1024, mime: 'image/png', by: TESTER, at: 2 * HOUR, where: 'G-27 thread' },
  { path: 'channels/release-eng/release-notes-2.4.md', size: 6 * 1024, mime: 'text/markdown', by: NADIA, at: 3 * HOUR, where: null },
  { path: 'channels/release-eng/qa-batch-7-report.pdf', size: 412 * 1024, mime: 'application/pdf', by: TARIQ, at: 4 * HOUR, where: null },
  { path: 'channels/release-eng/upgrade-2.png', size: 201 * 1024, mime: 'image/png', by: TESTER, at: 3 * DAY, where: 'G-26 thread' },
];
const CHANNELS = ['release-eng', 'router-firmware', 'incidents'];

type World = { versions: Map<string, Version[]>; attachments: Attachment[]; seq: number };
const worlds = new Map<string, World>();

function sha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

function seedWorld(): World {
  const w: World = { versions: new Map(), attachments: [], seq: 1 };
  const now = Date.now();
  const add = (path: string, by: Actor, message: string, ago: number, text: string | null): void => {
    const list = w.versions.get(path) ?? [];
    list.push({ sha: sha(w.seq++), by, message, at: now - ago, text });
    w.versions.set(path, list);
  };
  for (const [path, v] of Object.entries(SEED_TEXT)) add(path, SYSTEM, 'Create the team repository', 12 * DAY, v.text);
  const coder = 'bots/coder/BOT.md';
  w.versions.set(coder, []);
  add(coder, SYSTEM, 'Create the team repository', 12 * DAY, BOT_MD('team'));
  HISTORY_OF_CODER.forEach(([by, message, ago, visibility], i) => add(coder, by, message, ago, BOT_MD(visibility) + (i % 2 === 0 ? '\nNever merges.\n' : '')));
  add('pages/reports/week-37.md', OMAR, 'Week 37 report', 5 * DAY, WEEK_37.replace('312', '305'));
  add('pages/reports/week-37.md', CODER, 'Update the ticket count', 4 * DAY, WEEK_37);
  w.attachments = ATTACHMENTS.map((a, i) => ({ ...a, at: now - a.at, fileId: `00000000-0000-7000-8000-00000000f${String(i + 1).padStart(3, '0')}`, url: a.mime.startsWith('image/') ? PIXEL : '' }));
  return w;
}

const world = (slug: string): World => {
  let w = worlds.get(slug);
  if (!w) {
    w = seedWorld();
    worlds.set(slug, w);
  }
  return w;
};

const latest = (w: World, path: string): Version | undefined => w.versions.get(path)?.at(-1);
const exists = (w: World, path: string): boolean => latest(w, path)?.text != null;

export function mockBackend(slug: string, perms: Perms): FilesBackend {
  const w = world(slug);
  const me: Actor = { id: perms.personId, name: perms.personName, kind: 'person' };
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

  const gitRow = (path: string, kind: 'file' | 'folder'): FileRow => {
    const v = latest(w, path);
    return {
      path, name: baseName(path), kind, store: 'git',
      size: kind === 'file' ? new TextEncoder().encode(v?.text ?? '').length : null,
      mime: null, modifiedAt: v ? new Date(v.at).toISOString() : null, by: v?.by ?? null, where: null,
      fileId: null, channelId: null, blobSha: v ? v.sha : null, contentUrl: null,
      ...repoRowFlags(path, perms),
    };
  };
  const attRow = (a: Attachment): FileRow => ({
    path: a.path, name: baseName(a.path), kind: 'file', store: 'attachments', size: a.size, mime: a.mime,
    modifiedAt: new Date(a.at).toISOString(), by: a.by, where: `# ${channelNameOf(a.path) ?? ''}`, readOnly: true, readOnlyReason: 'attachment', managedBy: null,
    fileId: a.fileId, channelId: `mock-channel-${channelNameOf(a.path) ?? ''}`, blobSha: null, contentUrl: a.url || null,
  });
  const channelRow = (name: string): FileRow => ({
    path: `channels/${name}`, name, kind: 'folder', store: 'attachments', size: null, mime: null, modifiedAt: null, by: null, where: null,
    readOnly: false, readOnlyReason: null, managedBy: null, fileId: null, channelId: `mock-channel-${name}`, blobSha: null, contentUrl: null,
  });

  const listFolder = (folder: string): FileRow[] => {
    const prefix = folder === '' ? '' : `${folder}/`;
    const rows = new Map<string, FileRow>();
    for (const [path, list] of w.versions) {
      if (!path.startsWith(prefix) || list.at(-1)?.text == null) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (rest !== '.gitkeep') rows.set(path, gitRow(path, 'file'));
      } else {
        const dir = `${prefix}${rest.slice(0, slash)}`;
        if (!rows.has(dir)) rows.set(dir, gitRow(dir, 'folder'));
      }
    }
    if (folder === '') rows.set('channels', { ...channelRow('channels'), path: 'channels', name: 'channels', channelId: null });
    if (folder === 'channels') for (const n of CHANNELS) rows.set(`channels/${n}`, channelRow(n));
    const chan = channelNameOf(folder);
    if (chan && folder === `channels/${chan}`) for (const a of w.attachments) if (parentOf(a.path) === folder) rows.set(a.path, attRow(a));
    return [...rows.values()];
  };

  const write = (path: string, text: string | null, message: string): string => {
    const list = w.versions.get(path) ?? [];
    const v: Version = { sha: sha(w.seq++), by: me, message, at: Date.now(), text };
    list.push(v);
    w.versions.set(path, list);
    return v.sha;
  };
  const guard = (path: string): void => {
    if (repoRowFlags(path, perms).readOnly) throw new FilesError('forbidden', 'You cannot change this here. Changes to it go by pull request.');
  };

  return {
    async list(folder): Promise<Listing> {
      await pause();
      const chan = channelNameOf(folder);
      const info: FolderInfo = {
        path: folder, store: folder === 'channels' || chan ? 'attachments' : 'git', ...repoRowFlags(folder, perms),
        channelId: chan && folder === `channels/${chan}` ? `mock-channel-${chan}` : null,
        ...(folder === 'channels' || chan ? { readOnly: false, readOnlyReason: null, managedBy: null } : {}),
      };
      return { path: folder, folder: info, rows: listFolder(folder), truncated: false };
    },
    async stat(path) {
      await pause();
      return listFolder(parentOf(path)).find((r) => r.path === path) ?? null;
    },
    async statById(id) {
      await pause();
      const a = w.attachments.find((x) => x.fileId === id);
      return a ? attRow(a) : null;
    },
    open(r): FileContent {
      if (r.store === 'attachments') {
        const a = w.attachments.find((x) => x.fileId === r.fileId);
        const text = a && (a.mime.startsWith('text/') || extOf(a.path) === 'md') ? '# Release notes 2.4\n\nThe schedule migration ships with 2.4.\n' : undefined;
        return { source: memorySource({ ...(text !== undefined ? { text } : {}), url: a?.url ?? '' }), save: null };
      }
      const get = (): string => latest(w, r.path)?.text ?? '';
      return {
        source: { url: '', text: async () => (await pause(), get()), bytes: async () => new TextEncoder().encode(get()) },
        save: r.readOnly ? null : async (text) => { guard(r.path); write(r.path, text, `Edit ${r.path}`); },
      };
    },
    async history(path) {
      await pause();
      const list = w.versions.get(path) ?? [];
      return [...list].reverse().map((v, i, all): Commit => {
        const older = all[i + 1];
        return {
          sha: v.sha, parentSha: older?.sha ?? null, author: v.by, coAuthors: [], subject: v.message, message: v.message, committedAt: new Date(v.at).toISOString(),
          change: v.text === null ? 'deleted' : older?.text == null ? 'added' : 'modified',
        };
      });
    },
    async diff(path, c): Promise<FileDiff> {
      await pause();
      const list = w.versions.get(path) ?? [];
      const i = list.findIndex((v) => v.sha === c.sha);
      if (i < 0) throw new FilesError('other', "That commit is not in this file's history.");
      return lineDiff(list[i - 1]?.text ?? null, list[i]?.text ?? null);
    },
    async version(path, at) {
      await pause();
      return at === null ? null : (w.versions.get(path)?.find((v) => v.sha === at)?.text ?? null);
    },
    async restore(path, c, message) {
      await pause();
      guard(path);
      const v = w.versions.get(path)?.find((x) => x.sha === c.sha);
      if (!v || v.text == null) throw new FilesError('other', 'That version cannot be restored.');
      write(path, v.text, message);
    },
    async create(path, text) {
      await pause();
      guard(path);
      if (exists(w, path)) throw new FilesError('exists', 'Something with that name is already here.');
      write(path, text, `Create ${path}`);
    },
    async createFolder(path) {
      await pause();
      guard(path);
      write(`${path}/.gitkeep`, '', `Create folder ${path}`);
    },
    async move(r, to) {
      await pause();
      if (r.store !== 'git') throw new FilesError('unsupported', 'Attachments keep the name and the folder they were posted with.');
      guard(r.path);
      guard(to);
      if (exists(w, to)) throw new FilesError('exists', 'Something with that name is already there.');
      const text = latest(w, r.path)?.text ?? '';
      write(to, text, `Move ${r.path} to ${to}`);
      write(r.path, null, `Move ${r.path} to ${to}`);
    },
    async remove(r) {
      await pause();
      if (r.store === 'attachments') {
        w.attachments = w.attachments.filter((a) => a.fileId !== r.fileId);
        return;
      }
      guard(r.path);
      write(r.path, null, `Delete ${r.path}`);
    },
    async upload(folder, file, onProgress) {
      await pause();
      const chan = channelNameOf(folder.path);
      if (chan !== null) {
        w.attachments.push({ path: `${folder.path}/${file.name}`, size: file.size, mime: file.type || 'application/octet-stream', by: me, at: Date.now(), where: null, fileId: `00000000-0000-7000-8000-00000000f${String(100 + w.seq++).padStart(3, '0')}`, url: file.type.startsWith('image/') ? PIXEL : '' });
        onProgress(1);
        return;
      }
      const head = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
      if (head.includes(0) || file.size > 1_048_576) throw new FilesError('text_only', 'text only');
      write(`${folder.path === '' ? '' : `${folder.path}/`}${file.name}`, await file.text(), `Add ${file.name}`);
      onProgress(1);
    },
  };
}
