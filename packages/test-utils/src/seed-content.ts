import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSystemPool, loadTemplates, withSystem, type Tx } from '@manythreads/kernel';
import { toPlainText } from '@manythreads/shared';
import {
  ALERTS_LINES,
  ANALYTICS_LINES,
  BRAND_LINES,
  CAMPAIGNS_LINES,
  CONTENT_LINES,
  DEPLOY_PLAN_REPLIES,
  DEV_LINES,
  DM_LINES,
  ENG_LEADS_LINES,
  ENQUIRIES_LINES,
  ESCALATIONS_LINES,
  GENERAL_LINES,
  INCIDENTS_LINES,
  KB_LINES,
  LOAD_TEST_COUNT,
  RELEASES_LINES,
  SOCIAL_LINES,
  standupLines,
  SUPPORT_LINES,
  type SeedAuthor,
  type SeedLine,
} from './seed-data.ts';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, LENA, personas, TEAM_IDS, type Persona, type TeamName } from './personas.ts';

/** Fixed ids of the seed v3 content (so a screenshot, a spec or a deep link can name them). */
export const SEED_IDS = {
  /** `<team slug>/<channel name>` to channel id. */
  channels: {
    'engineering/general': '00000000-0000-7000-8000-0000000f0001',
    'engineering/dev': '00000000-0000-7000-8000-0000000f0002',
    'engineering/releases': '00000000-0000-7000-8000-0000000f0003',
    'engineering/incidents': '00000000-0000-7000-8000-0000000f0004',
    'engineering/alerts': '00000000-0000-7000-8000-0000000f0005',
    'engineering/standup': '00000000-0000-7000-8000-0000000f0006',
    'engineering/eng-leads': '00000000-0000-7000-8000-0000000f0007',
    'engineering/load-test': '00000000-0000-7000-8000-0000000f0008',
    'customer-support/support': '00000000-0000-7000-8000-0000000f0011',
    'customer-support/escalations': '00000000-0000-7000-8000-0000000f0012',
    'customer-support/enquiries': '00000000-0000-7000-8000-0000000f0013',
    'customer-support/kb-updates': '00000000-0000-7000-8000-0000000f0014',
    'marketing/campaigns': '00000000-0000-7000-8000-0000000f0021',
    'marketing/content': '00000000-0000-7000-8000-0000000f0022',
    'marketing/social': '00000000-0000-7000-8000-0000000f0023',
    'marketing/analytics': '00000000-0000-7000-8000-0000000f0024',
    'marketing/brand': '00000000-0000-7000-8000-0000000f0025',
  },
  /** The Nadia and Rafi direct message. */
  dm: '00000000-0000-7000-8000-0000000f0031',
  /** The attachment of the "Deploy plan" root message. */
  file: '00000000-0000-7000-8000-0000000f0041',
} as const;

export const DEPLOY_PLAN_FILE_NAME = 'deploy-plan-v2.14.pdf';

/** The first moment of the seed's history (a Monday, 09:00 UTC). Message ids always carry times from here, so a re-run finds its rows. */
const HISTORY_START_MS = Date.UTC(2026, 2, 2, 9, 0, 0);
/** What `MANYTHREADS_CLOCK=fixed` (or an explicit `baseDate`) pins: the history starts at this instant. */
export const SEED_FIXED_START = new Date(HISTORY_START_MS);

const MIN = 60_000;

export interface SeedContentOptions {
  /** Where team templates live (default: `MANYTHREADS_TEMPLATES_DIR`, else `templates/` at the repository root). */
  templatesDir?: string;
  /** Where `storage-local` keeps blobs (default: `MANYTHREADS_STORAGE_DIR`, else `./data/blobs`). The attachment is written there. */
  storageDir?: string;
  /**
   * Write the attachment (default true). Turn it off when the seed does not run where the server keeps its blobs (a Kubernetes Job's own
   * filesystem is not the server pod's): without the bytes the card would be a broken download, so no row and no card are made.
   */
  attachment?: boolean;
  /**
   * The instant the history starts. Default: with `MANYTHREADS_CLOCK=fixed` the same instant every time (`SEED_FIXED_START`), else
   * a start that makes the newest message half an hour old now (a demo site then reads like a live team). Ids never change with it.
   */
  baseDate?: Date;
  log?: (line: string) => void;
}

export interface SeedContentResult {
  /** Why nothing was written (a plugin's tables are not there yet), or null. */
  skipped: string | null;
  channels: number;
  messages: number;
  threadReplies: number;
  reactions: number;
  mentions: number;
  notifications: number;
  attachments: number;
  guestGrants: number;
}

const defaultTemplatesDir = (): string =>
  process.env['MANYTHREADS_TEMPLATES_DIR'] ?? fileURLToPath(new URL('../../../templates/', import.meta.url));

/** A uuid v7 that is a pure function of its inputs: 48 bit time, then the sequence and the channel number. */
export function seedUuid(ms: number, seq: number, channelNo: number): string {
  const h = ms.toString(16).padStart(12, '0');
  const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${hex(seq % 4096, 3)}-8${hex(channelNo % 4096, 3)}-${hex(seq, 12)}`;
}

const TEAM_SLUG: Record<TeamName, string> = { Engineering: 'engineering', 'Customer support': 'customer-support', Marketing: 'marketing' };

interface ChannelDef {
  ref: keyof typeof SEED_IDS.channels;
  no: number;
  team: TeamName;
  name: string;
  private: boolean;
  purpose: string;
  position: number;
  createdBy: SeedAuthor;
  /** People who joined it (and read it). */
  members: SeedAuthor[];
  lines: SeedLine[] | null;
}

const ENG: SeedAuthor[] = ['omar', 'nadia', 'rafi', 'priya'];
const SUPPORT: SeedAuthor[] = ['sameera', 'omar'];
const MKT: SeedAuthor[] = ['tariq', 'priya', 'omar'];

const LINES: Partial<Record<keyof typeof SEED_IDS.channels, () => SeedLine[]>> = {
  'engineering/general': () => GENERAL_LINES,
  'engineering/dev': () => DEV_LINES,
  'engineering/releases': () => RELEASES_LINES,
  'engineering/incidents': () => INCIDENTS_LINES,
  'engineering/alerts': () => ALERTS_LINES,
  'engineering/standup': standupLines,
  'engineering/eng-leads': () => ENG_LEADS_LINES,
  'customer-support/support': () => SUPPORT_LINES,
  'customer-support/escalations': () => ESCALATIONS_LINES,
  'customer-support/enquiries': () => ENQUIRIES_LINES,
  'customer-support/kb-updates': () => KB_LINES,
  'marketing/campaigns': () => CAMPAIGNS_LINES,
  'marketing/content': () => CONTENT_LINES,
  'marketing/social': () => SOCIAL_LINES,
  'marketing/analytics': () => ANALYTICS_LINES,
  'marketing/brand': () => BRAND_LINES,
};

const EXTRA_CHANNELS: Pick<ChannelDef, 'ref' | 'team' | 'name' | 'private' | 'purpose' | 'members' | 'createdBy'>[] = [
  { ref: 'engineering/eng-leads', team: 'Engineering', name: 'eng-leads', private: true, purpose: 'Leads and release owners: hiring, budget and people topics.', members: ['omar', 'nadia'], createdBy: 'omar' },
  { ref: 'engineering/load-test', team: 'Engineering', name: 'load-test', private: false, purpose: 'Synthetic traffic for scroll and search benchmarks.', members: ENG, createdBy: 'omar' },
];

const personaOf = (key: SeedAuthor): Persona => personas[key];

/** Day of the calendar (Monday = 0) for the n-th working day: weekends are skipped. */
const calendarDay = (workingDay: number): number => workingDay + 2 * Math.floor(workingDay / 5);

/** The minutes since the history started of the i-th of n messages of a channel: ten working days, a few posts a day. */
function minuteOf(i: number, n: number, channelNo: number): number {
  const perDay = Math.max(1, Math.ceil(n / 10));
  const day = Math.floor(i / perDay);
  const j = i % perDay;
  return calendarDay(day) * 1440 + 10 + j * Math.floor(420 / perDay) + (channelNo % 5);
}

const handleRegex = /(^|[^\w@])@(omar|nadia|rafi|sameera|tariq|priya)\b/g;
const mentionsOf = (text: string): SeedAuthor[] => {
  const out = new Set<SeedAuthor>();
  for (const m of text.matchAll(handleRegex)) out.add(m[2] as SeedAuthor);
  return [...out];
};

/** A tiny, valid, one page PDF (offsets computed, so a strict reader opens it too). */
function deployPlanPdf(): Buffer {
  const stream = 'BT /F1 16 Tf 24 100 Td (Deploy plan v2.14) Tj 0 -24 Td /F1 11 Tf (Cache TTL 300 s to 60 s. Canary 10% for 30 min.) Tj 0 -18 Td (Rollback: deploy rollback v2.13) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const tablesExist = async (tx: Tx, names: string[]): Promise<Record<string, boolean>> => {
  const res = await tx.query<{ n: string; ok: boolean }>(
    `SELECT n, to_regclass('app.' || n) IS NOT NULL AS ok FROM unnest($1::text[]) AS n`,
    [names],
  );
  return Object.fromEntries(res.rows.map((r) => [r.n, r.ok]));
};

/**
 * Seed v3 content (PLAN.md section 5, P3-15): the channels of the three seeded teams, about 40 messages in each, a 12-reply
 * thread, a private channel, a direct message, a 5,000-message channel, a guest read grant for Lena on #releases, reactions,
 * mentions and one attachment. Written as the system role straight into the tables (no events, no outbox), with fixed ids and
 * stable times, so it is idempotent: every insert is `ON CONFLICT DO NOTHING` and a second run adds nothing. Needs the personas
 * and the plugin tables (channels, and optionally files and notifications); when the channels tables are missing it writes
 * nothing and says so in `skipped`.
 */
export async function seedContent(db: Pick<TestDatabase, 'systemUrl'>, options: SeedContentOptions = {}): Promise<SeedContentResult> {
  const log = options.log ?? (() => undefined);
  const result: SeedContentResult = {
    skipped: null,
    channels: 0,
    messages: 0,
    threadReplies: 0,
    reactions: 0,
    mentions: 0,
    notifications: 0,
    attachments: 0,
    guestGrants: 0,
  };
  const templates = await loadTemplates(options.templatesDir ?? defaultTemplatesDir());
  const storageDir = resolve(options.storageDir ?? process.env['MANYTHREADS_STORAGE_DIR'] ?? './data/blobs');
  const fixedClock = process.env['MANYTHREADS_CLOCK'] === 'fixed';

  const pool = createSystemPool(db.systemUrl, 2);
  try {
    await withSystem(
      async (tx) => {
        const have = await tablesExist(tx, ['channels', 'messages', 'channel_groups', 'read_state', 'files', 'notifications', 'acl_entries', 'threads']);
        if (!have['channels'] || !have['messages'] || !have['channel_groups'] || !have['read_state'] || !have['threads']) {
          result.skipped = 'the channels tables are not there yet (start the server once so its plugin migrations run, then seed again)';
          return;
        }
        const ws = KAHF_WORKSPACE_ID;
        const actor = (k: SeedAuthor): string => personaOf(k).actorId;
        const person = (k: SeedAuthor): string => personaOf(k).personId;

        // 1. Groups and channels: the template's channels (what channels_sync_template would make) with fixed ids, then the extras.
        const defs: ChannelDef[] = [];
        for (const team of Object.keys(TEAM_IDS) as TeamName[]) {
          const slug = TEAM_SLUG[team];
          const template = templates.find((t) => t.id === slug);
          if (!template) throw new Error(`seed: no team template "${slug}"`);
          const members = team === 'Engineering' ? ENG : team === 'Customer support' ? SUPPORT : MKT;
          template.channels.forEach((c, i) => {
            const name = c.name.replace(/^#/, '');
            const ref = `${slug}/${name}` as keyof typeof SEED_IDS.channels;
            if (!(ref in SEED_IDS.channels)) return; // a template channel the seed has no words for
            defs.push({
              ref,
              no: Number(SEED_IDS.channels[ref].slice(-4)),
              team,
              name,
              private: false,
              purpose: c.purpose ?? '',
              position: i + 1,
              createdBy: team === 'Marketing' ? 'tariq' : 'omar',
              members,
              lines: LINES[ref]?.() ?? null,
            });
          });
        }
        for (const [i, e] of EXTRA_CHANNELS.entries()) {
          defs.push({ ...e, no: Number(SEED_IDS.channels[e.ref].slice(-4)), position: 90 + i, lines: LINES[e.ref]?.() ?? null });
        }
        let groupNo = 0;
        for (const team of Object.keys(TEAM_IDS) as TeamName[]) {
          groupNo += 1;
          await tx.query(
            `INSERT INTO app.channel_groups (id, workspace_id, team_id, name, position) VALUES ($1, $2, $3, 'Channels', 0)
             ON CONFLICT (team_id, name) DO NOTHING`,
            [`00000000-0000-7000-8000-0000000f90${String(groupNo).padStart(2, '0')}`, ws, TEAM_IDS[team]],
          );
        }
        for (const d of defs) {
          await tx.query(
            `INSERT INTO app.channels (id, workspace_id, team_id, group_id, name, kind, private, purpose, position, created_by)
             VALUES ($1, $2, $3, (SELECT g.id FROM app.channel_groups g WHERE g.team_id = $3 AND g.name = 'Channels'), $4, 'channel', $5, $6, $7, $8)
             ON CONFLICT (team_id, name) WHERE kind = 'channel' DO NOTHING`,
            [SEED_IDS.channels[d.ref], ws, TEAM_IDS[d.team], d.name, d.private, d.purpose.slice(0, 250), d.position, actor(d.createdBy)],
          );
        }
        // The marker, so the template is not applied a second time (a no-op for channels that exist).
        for (const id of Object.values(TEAM_IDS)) await tx.query('SELECT count(*) FROM app.channels_sync_template($1)', [id]);

        // The ids the database holds (a sync that ran earlier may have made the channels with ids of its own).
        const found = await tx.query<{ id: string; slug: string; name: string }>(
          `SELECT c.id, t.slug, c.name FROM app.channels c JOIN app.teams t ON t.id = c.team_id WHERE c.workspace_id = $1 AND c.kind = 'channel'`,
          [ws],
        );
        const channelId = new Map(found.rows.map((r) => [`${r.slug}/${r.name}`, r.id]));
        const idOf = (ref: string): string => {
          const id = channelId.get(ref);
          if (!id) throw new Error(`seed: channel ${ref} was not created`);
          return id;
        };
        result.channels = defs.length;

        // 2. Members of every channel; the direct message of Nadia and Rafi.
        for (const d of defs) {
          for (const m of d.members) {
            await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [idOf(d.ref), person(m)]);
          }
        }
        const dmKey = [personas.nadia.personId, personas.rafi.personId].sort().join(',');
        await tx.query(
          `INSERT INTO app.channels (id, workspace_id, team_id, name, kind, private, dm_key, created_by)
           VALUES ($1, $2, NULL, '', 'dm', true, $3, $4) ON CONFLICT (workspace_id, dm_key) WHERE kind = 'dm' DO NOTHING`,
          [SEED_IDS.dm, ws, dmKey, actor('nadia')],
        );
        const dmId = (await tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE workspace_id = $1 AND kind = 'dm' AND dm_key = $2`, [ws, dmKey])).rows[0]!.id;
        for (const m of ['nadia', 'rafi'] as const) {
          await tx.query('INSERT INTO app.channel_members (channel_id, person_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [dmId, person(m)]);
        }

        // 3. The attachment: its bytes go where storage-local looks (<dir>/<key[0..2]>/<key>), its row to `files`.
        let fileMeta: { size: number; sha: string } | null = null;
        const blobKey = createHash('sha256').update('seed-v3:deploy-plan.pdf').digest('hex').slice(0, 32);
        if (have['files'] && options.attachment !== false) {
          try {
            const bytes = deployPlanPdf();
            const path = join(storageDir, blobKey.slice(0, 2), blobKey);
            if (!existsSync(path)) {
              await mkdir(dirname(path), { recursive: true });
              await writeFile(path, bytes, { mode: 0o600 });
            }
            fileMeta = { size: bytes.length, sha: createHash('sha256').update(bytes).digest('hex') };
          } catch (err) {
            log(`the attachment was left out (cannot write ${storageDir}: ${err instanceof Error ? err.message : String(err)})`);
          }
        }

        // 4. Times. Ids carry HISTORY_START_MS + offset always; created_at carries `start` + offset.
        interface Planned {
          id: string;
          channelId: string;
          channelRef: string;
          line: SeedLine;
          offsetMin: number;
          rootId: string | null;
          seq: number;
          channelNo: number;
        }
        const planned: Planned[] = [];
        let seq = 0;
        for (const d of defs) {
          if (!d.lines) continue;
          d.lines.forEach((line, i) => {
            seq += 1;
            const offsetMin = minuteOf(i, d.lines!.length, d.no);
            planned.push({ id: seedUuid(HISTORY_START_MS + offsetMin * MIN, seq, d.no), channelId: idOf(d.ref), channelRef: d.ref, line, offsetMin, rootId: null, seq, channelNo: d.no });
          });
        }
        const dmPlanned: Planned[] = DM_LINES.map((line, i) => {
          seq += 1;
          const offsetMin = (i < 6 ? calendarDay(8) * 1440 + 9 * 60 + 30 + i * 22 : calendarDay(9) * 1440 + 10 * 60 + 2);
          return { id: seedUuid(HISTORY_START_MS + offsetMin * MIN, seq, 31), channelId: dmId, channelRef: 'dm', line, offsetMin, rootId: null, seq, channelNo: 31 };
        });
        const root = planned.find((p) => p.line.key === 'deploy-plan');
        if (!root) throw new Error('seed: the Deploy plan root is missing');
        const replies: Planned[] = DEPLOY_PLAN_REPLIES.map((line, k) => {
          seq += 1;
          const offsetMin = root.offsetMin + 9 * (k + 1);
          return { id: seedUuid(HISTORY_START_MS + offsetMin * MIN, seq, 2), channelId: root.channelId, channelRef: root.channelRef, line, offsetMin, rootId: root.id, seq, channelNo: 2 };
        });
        const LOAD_START_MIN = calendarDay(10) * 1440 + 12 * 60;
        const LOAD_STEP_MS = 20_000;
        const lastMin = Math.max(...planned.map((p) => p.offsetMin), ...dmPlanned.map((p) => p.offsetMin), LOAD_START_MIN + (LOAD_TEST_COUNT * LOAD_STEP_MS) / MIN);
        const start =
          options.baseDate?.getTime() ??
          (fixedClock ? HISTORY_START_MS : Math.floor((Date.now() - 30 * MIN) / MIN) * MIN - lastMin * MIN);
        const at = (offsetMin: number): string => new Date(start + offsetMin * MIN).toISOString();

        // 5. Messages: roots first (one statement), then replies (their roots exist by then), then the DM.
        const insertMessages = async (rows: Planned[]): Promise<number> => {
          if (rows.length === 0) return 0;
          const ordered = [...rows].sort((a, b) => a.offsetMin - b.offsetMin || a.seq - b.seq);
          const res = await tx.query(
            `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, thread_root_id, edited_at, meta, created_at)
             SELECT x.id, $1::uuid, x.channel_id, x.author_id, x.body, x.plain, x.root_id, x.edited_at, x.meta::jsonb, x.created_at
               FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::uuid[], $8::timestamptz[], $9::text[], $10::timestamptz[])
                    AS x(id, channel_id, author_id, body, plain, root_id, edited_at, meta, created_at)
             ON CONFLICT (id) DO NOTHING`,
            [
              ws,
              ordered.map((p) => p.id),
              ordered.map((p) => p.channelId),
              ordered.map((p) => actor(p.line.who)),
              ordered.map((p) => p.line.text),
              ordered.map((p) => toPlainText(p.line.text)),
              ordered.map((p) => p.rootId),
              ordered.map((p) => (p.line.edited ? at(p.offsetMin + 2) : null)),
              ordered.map((p) =>
                p.line.key === 'deploy-plan' && fileMeta ? JSON.stringify({ attachments: [SEED_IDS.file] }) : '{}',
              ),
              ordered.map((p) => at(p.offsetMin)),
            ],
          );
          return res.rowCount ?? 0;
        };
        const topLevel = await insertMessages(planned);
        const dmCount = await insertMessages(dmPlanned);
        const replyCount = await insertMessages(replies);
        result.messages = planned.length + dmPlanned.length + replies.length;
        result.threadReplies = replies.length;
        log(`messages: ${topLevel + dmCount + replyCount} new (${planned.length + dmPlanned.length} in ${defs.length} channels and a DM, ${replies.length} thread replies)`);

        // The 5,000-message channel, generated in SQL: one statement.
        const loadNo = Number(SEED_IDS.channels['engineering/load-test'].slice(-4));
        const loadStartMs = HISTORY_START_MS + LOAD_START_MIN * MIN;
        const loadStartCreated = start + LOAD_START_MIN * MIN;
        await tx.query(
          `INSERT INTO app.messages (id, workspace_id, channel_id, author_id, body, body_plain, created_at)
           SELECT (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-7' || lpad(to_hex((900000 + i) % 4096), 3, '0') || '-8' || lpad(to_hex($6::int % 4096), 3, '0')
                   || '-' || lpad(to_hex(900000 + i), 12, '0'))::uuid,
                  $1::uuid, $2::uuid, ($3::uuid[])[1 + i % 4], t.txt, t.txt, ($5::timestamptz) + i * ($7::int * interval '1 millisecond')
             FROM generate_series(1, $4::int) AS i,
                  LATERAL (SELECT lpad(to_hex(($8::bigint) + i * $7::bigint), 12, '0') AS h) hh,
                  LATERAL (SELECT 'Load test message ' || i || ': ' || md5(i::text) || ' ' || substr(md5((i * 7)::text), 1, 12) AS txt) t
           ON CONFLICT (id) DO NOTHING`,
          [ws, idOf('engineering/load-test'), [actor('omar'), actor('nadia'), actor('rafi'), actor('priya')], LOAD_TEST_COUNT, new Date(loadStartCreated).toISOString(), loadNo, LOAD_STEP_MS, loadStartMs],
        );
        result.messages += LOAD_TEST_COUNT;

        // 6. Reactions and mentions (rows the app writes through its routes), plus the notifications a person would hold.
        const all = [...planned, ...dmPlanned, ...replies];
        const reactionRows: { message: string; actor: string; emoji: string; created: string }[] = [];
        const mentionRows: { message: string; mentioned: string }[] = [];
        const notificationRows: { id: string; person: string; kind: 'mention' | 'reply' | 'dm'; message: Planned; read: boolean; rootId: string | null }[] = [];
        let nseq = 0;
        for (const p of all) {
          p.line.react?.forEach(([emoji, ...who], k) => {
            for (const w of who) reactionRows.push({ message: p.id, actor: actor(w), emoji, created: at(p.offsetMin + 3 + k) });
          });
          for (const m of mentionsOf(p.line.text)) {
            if (m === p.line.who) continue;
            mentionRows.push({ message: p.id, mentioned: actor(m) });
            nseq += 1;
            notificationRows.push({
              id: seedUuid(HISTORY_START_MS + p.offsetMin * MIN + 1000, 500_000 + nseq, 40),
              person: person(m),
              kind: 'mention',
              message: p,
              read: !p.line.notify,
              rootId: p.rootId,
            });
          }
        }
        const lastReply = replies[replies.length - 1]!;
        nseq += 1;
        notificationRows.push({ id: seedUuid(HISTORY_START_MS + lastReply.offsetMin * MIN + 1000, 500_000 + nseq, 40), person: person('rafi'), kind: 'reply', message: lastReply, read: false, rootId: root.id });
        const lastDm = dmPlanned[dmPlanned.length - 1]!;
        nseq += 1;
        notificationRows.push({ id: seedUuid(HISTORY_START_MS + lastDm.offsetMin * MIN + 1000, 500_000 + nseq, 40), person: person('nadia'), kind: 'dm', message: lastDm, read: false, rootId: null });

        if (reactionRows.length > 0) {
          await tx.query(
            `INSERT INTO app.message_reactions (message_id, actor_id, emoji, created_at)
             SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::timestamptz[]) ON CONFLICT DO NOTHING`,
            [reactionRows.map((r) => r.message), reactionRows.map((r) => r.actor), reactionRows.map((r) => r.emoji), reactionRows.map((r) => r.created)],
          );
        }
        if (mentionRows.length > 0) {
          await tx.query(
            `INSERT INTO app.message_mentions (message_id, mentioned_id, kind, channel_id)
             SELECT x.m, x.a, 'person', '00000000-0000-0000-0000-000000000000'::uuid FROM unnest($1::uuid[], $2::uuid[]) AS x(m, a) ON CONFLICT DO NOTHING`,
            [mentionRows.map((r) => r.message), mentionRows.map((r) => r.mentioned)],
          );
        }
        result.reactions = reactionRows.length;
        result.mentions = mentionRows.length;

        if (have['notifications']) {
          const nrows = notificationRows;
          await tx.query(
            `INSERT INTO app.notifications (id, workspace_id, person_id, kind, ref_type, ref_id, channel_id, thread_root_id, actor_id, actor_name, preview, read_at, created_at)
             SELECT x.id, $1::uuid, x.person_id, x.kind, 'message', x.ref_id, x.channel_id, x.root_id, x.actor_id, x.actor_name, x.preview,
                    CASE WHEN x.is_read THEN x.created_at + interval '20 minutes' END, x.created_at
               FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::uuid[], $6::uuid[], $7::uuid[], $8::uuid[], $9::text[], $10::text[], $11::boolean[], $12::timestamptz[])
                    AS x(id, person_id, kind, ref_id, channel_id, root_id, actor_id, actor_name, preview, is_read, created_at)
             ON CONFLICT DO NOTHING`,
            [
              ws,
              nrows.map((r) => r.id),
              nrows.map((r) => r.person),
              nrows.map((r) => r.kind),
              nrows.map((r) => r.message.id),
              nrows.map((r) => r.message.channelId),
              nrows.map((r) => r.rootId),
              nrows.map((r) => actor(r.message.line.who)),
              nrows.map((r) => personaOf(r.message.line.who).name),
              nrows.map((r) => toPlainText(r.message.line.text).replace(/\s+/g, ' ').trim().slice(0, 140)),
              nrows.map((r) => r.read),
              nrows.map((r) => at(r.message.offsetMin + 1)),
            ],
          );
          result.notifications = nrows.length;
        }

        // 7. The attachment row and the guest grant.
        if (fileMeta) {
          await tx.query(
            `INSERT INTO app.files (id, workspace_id, channel_id, folder_path, name, blob_key, size, mime, sha256, uploader_id, created_at)
             VALUES ($1, $2, $3, 'channels/dev/', $4, $5, $6, 'application/pdf', $7, $8, $9) ON CONFLICT DO NOTHING`,
            [SEED_IDS.file, ws, root.channelId, DEPLOY_PLAN_FILE_NAME, blobKey, fileMeta.size, fileMeta.sha, actor('nadia'), at(root.offsetMin - 1)],
          );
          result.attachments = 1;
        }
        if (have['acl_entries']) {
          const g = await tx.query(
            `INSERT INTO app.acl_entries (workspace_id, resource_type, resource_id, subject_type, subject_id, permission)
             VALUES ($1, 'channel', $2, 'person', $3, 'read') ON CONFLICT DO NOTHING`,
            [ws, idOf('engineering/releases'), LENA.personId],
          );
          result.guestGrants = g.rowCount ?? 0;
        }

        // 8. Read state: everybody has read everything in the channels they joined, except what the story leaves unread
        //    (Nadia's direct message, Rafi's last reply in the Deploy plan thread). A channel with no row would show a "New"
        //    divider above its first message.
        const lastTop = (channel: string): string | null => {
          const rows = [...planned, ...dmPlanned].filter((p) => p.channelId === channel).sort((a, b) => a.offsetMin - b.offsetMin || a.seq - b.seq);
          return rows[rows.length - 1]?.id ?? null;
        };
        for (const d of defs) {
          const channel = idOf(d.ref);
          const last =
            d.ref === 'engineering/load-test'
              ? (await tx.query<{ id: string }>('SELECT max(id::text)::uuid AS id FROM app.messages WHERE channel_id = $1 AND thread_root_id IS NULL', [channel])).rows[0]?.id ?? null
              : lastTop(channel);
          if (!last) continue;
          for (const m of d.members) {
            await tx.query(
              `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count) VALUES ($1, 'channel', $2, $3, 0) ON CONFLICT DO NOTHING`,
              [person(m), channel, last],
            );
          }
        }
        // The guest has read the channel she was granted (a person with no row sees a "New" divider above its first message).
        const grantedLast = lastTop(idOf('engineering/releases'));
        if (grantedLast) {
          await tx.query(
            `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count) VALUES ($1, 'channel', $2, $3, 0) ON CONFLICT DO NOTHING`,
            [LENA.personId, idOf('engineering/releases'), grantedLast],
          );
        }
        const dmLast = dmPlanned[dmPlanned.length - 1]!;
        const dmBefore = dmPlanned[dmPlanned.length - 2]!;
        await tx.query(`INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count) VALUES ($1, 'channel', $2, $3, 0) ON CONFLICT DO NOTHING`, [person('rafi'), dmId, dmLast.id]);
        await tx.query(`INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count) VALUES ($1, 'channel', $2, $3, 1) ON CONFLICT DO NOTHING`, [person('nadia'), dmId, dmBefore.id]);
        // Followers of the thread (the trigger made them follow, and mirrored `followed` into read_state).
        const lastRead = replies[replies.length - 1]!;
        const beforeLast = replies[replies.length - 2]!;
        for (const who of ['nadia', 'omar'] as const) {
          await tx.query(
            `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count, followed) VALUES ($1, 'thread', $2, $3, 0, true)
             ON CONFLICT (person_id, target_type, target_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, unread_count = 0
               WHERE app.read_state.last_read_id IS NULL`,
            [person(who), root.id, lastRead.id],
          );
        }
        await tx.query(
          `INSERT INTO app.read_state (person_id, target_type, target_id, last_read_id, unread_count, followed) VALUES ($1, 'thread', $2, $3, 1, true)
           ON CONFLICT (person_id, target_type, target_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, unread_count = 1
             WHERE app.read_state.last_read_id IS NULL`,
          [person('rafi'), root.id, beforeLast.id],
        );
      },
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
  if (result.skipped) log(`content skipped: ${result.skipped}`);
  else
    log(
      `content: ${result.channels} channels, ${result.messages} messages (${result.threadReplies} thread replies), ${result.reactions} reactions, ${result.mentions} mentions, ${result.notifications} notifications, ${result.attachments} attachment, ${result.guestGrants} new guest grant`,
    );
  return result;
}

