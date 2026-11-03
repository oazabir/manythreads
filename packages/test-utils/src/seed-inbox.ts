import { createSystemPool, withSystem } from '@manythreads/kernel';
import type { TestDatabase } from './db.ts';
import { KAHF_WORKSPACE_ID, NADIA, OMAR, RAFI, SAMEERA, TEAM_IDS, type Persona } from './personas.ts';
import { seedPng } from './seed-assets.ts';

/**
 * Seed v8, the memory part (PLAN P8-27): what the Inbox tab and the Sharing tab show on a site that has been seeded. Engineering's inbox holds a PDF, a photo
 * (a picture, which the platform cannot read yet, so its card says so), meeting notes and, filed from those notes, an Action Items concept; Customer support's
 * inbox holds a customer's `.eml`. Engineering also has two shares to Customer support: one the team has accepted and one that still waits for its leads.
 *
 * The data has no server in it; `seedInboxAndShares` puts it in through the real routes (a person drops a file, a lead commits a share file), exactly as a
 * person would, like `seedProductManuals`. Two steps have no route and are written to the database as the platform would: naming the Action Items concept
 * among the notes' filed paths (the Archivist does that in a real run, and the seed has no model), and accepting the share (the person who wrote a share can never
 * accept it, and Customer support has no other lead or admin than Omar, who writes it).
 */

export const SEED_INBOX = {
  /** The team whose inbox holds the PDF, the photo, the notes and the action items. */
  team: 'engineering',
  /** The team that gets the `.eml`, and the destination of both shares. */
  supportTeam: 'customer-support',
  actionItemsPath: 'memory/action-items/release-retro.md',
  shares: {
    accepted: { slug: 'engineering-facts-for-support', name: 'Engineering facts for Support' },
    pending: { slug: 'incident-lessons-for-support', name: 'Incident lessons for Support' },
  },
} as const;

export type SeedInboxKey = 'pdf' | 'photo' | 'notes' | 'eml';

export interface SeedInboxDrop {
  key: SeedInboxKey;
  /** The slug of the team the item is dropped into. */
  team: string;
  who: Persona;
  /** Where it comes in: a file upload, or a typed note. */
  door: 'file' | 'note';
  name: string;
  /** The state the item reaches without a model: `filed` (a Reference alone) or `failed` (a picture cannot be read yet). */
  ends: 'filed' | 'failed';
}

export const SEED_INBOX_DROPS: readonly SeedInboxDrop[] = [
  { key: 'pdf', team: SEED_INBOX.team, who: NADIA, door: 'file', name: 'release-checklist.pdf', ends: 'filed' },
  { key: 'photo', team: SEED_INBOX.team, who: RAFI, door: 'file', name: 'whiteboard-rollback-plan.png', ends: 'failed' },
  { key: 'notes', team: SEED_INBOX.team, who: OMAR, door: 'note', name: 'Release retro, 4 November', ends: 'filed' },
  { key: 'eml', team: SEED_INBOX.supportTeam, who: SAMEERA, door: 'file', name: 'renewal-question.eml', ends: 'filed' },
];

export const MEETING_NOTES = `Release retro, 4 November. Present: Omar, Nadia, Rafi.

What went well: the v2.14 release shipped on a Tuesday with no rollback, and the new deploy health page caught a slow migration before customers did.

What did not: the release notes were written the night before, and Support heard about the new webhook limits from a customer.

Decisions: releases keep going out on Tuesdays. Release notes are drafted on Friday and sent to Support before the release, not after.
`;

/** The Action Items concept filed from the notes: one action to a line, as the Archivist writes them (docs/plugins/memory-inbox.md "Action items"). */
export const ACTION_ITEMS_CONCEPT = `---
type: Action Items
title: Release retro actions
description: What was agreed at the release retro of 4 November
status: stable
---

# Release retro actions

- [ ] Draft the release notes on Friday (owner: Nadia; due: 2026-11-13)
- [ ] Send the notes to Support before each release (owner: Omar; due: 2026-11-13)
- [ ] Write the webhook limits into the runbook (owner: Rafi)
- [x] Put the deploy health page on the team wall (owner: Rafi; due: 2026-11-04)
`;

/** A customer's email, as Support would forward it to the team inbox. */
export const CUSTOMER_EML = [
  'From: Mariam Haddad <mariam@harbourshop.example>',
  'To: Support <support@kahf.example>',
  'Date: Tue, 03 Nov 2026 09:12:00 +0000',
  'Subject: Webhook limits after the v2.14 update',
  'Message-ID: <retry-limits-1@harbourshop.example>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hello,',
  '',
  'Since the update our shop receives each order webhook at most five times, and then it stops. Is that new? We would like to know how long the platform keeps retrying so we can plan for our own downtime.',
  '',
  'Thank you,',
  'Mariam',
  '',
].join('\r\n');

/** A one-page PDF with the lines of text, built by hand (header, catalog, pages, page, content stream, font, cross-reference table). The text is readable by the extractor. */
export function seedPdf(lines: readonly string[]): Buffer {
  const esc = (s: string): string => s.replace(/[()\\]/g, '\\$&');
  const stream = lines.map((line, i) => `BT /F1 12 Tf 72 ${String(720 - i * 18)} Td (${esc(line)}) Tj ET`).join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${String(stream.length)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export const RELEASE_CHECKLIST_PDF_LINES = [
  'Release checklist',
  'Release notes are drafted on Friday and sent to Support before the release.',
  'Releases go out on Tuesdays, never inside a freeze window.',
  'The deploy health page is checked eight minutes after each production deploy.',
];

/** The two share files committed to Engineering's repository, `routines/shares/<slug>.yaml` (docs/plugins/memory-share.md "The share file"). */
export const SHARE_FILES: ReadonlyArray<{ slug: string; yaml: string }> = [
  {
    slug: SEED_INBOX.shares.accepted.slug,
    yaml: `name: ${SEED_INBOX.shares.accepted.name}
to: [customer-support]
select:
  paths: [facts/]
mode: summary
approvers: [role:lead]
`,
  },
  {
    slug: SEED_INBOX.shares.pending.slug,
    yaml: `name: ${SEED_INBOX.shares.pending.name}
to: [customer-support]
select:
  paths: [facts/, action-items/]
  types: [Fact, Action Items]
mode: full
approvers: [role:lead]
`,
  },
];

export interface SeedInboxAndSharesOptions {
  /** The server's address (`TestServer.url`). */
  url: string;
  /** The database, for the two steps that have no route (see the top of this file). */
  db: Pick<TestDatabase, 'systemUrl'>;
  /** Waits at most this long for each step (default 60 seconds). */
  timeoutMs?: number;
  log?: (line: string) => void;
}

export interface SeededItem {
  id: string;
  team: string;
  name: string;
  kind: string;
  state: string;
  /** True when the same file was already in the team's inbox (a second seeding): the id is the first item's. */
  duplicate: boolean;
}

export interface SeedInboxAndSharesResult {
  items: Record<SeedInboxKey, SeededItem>;
  actionItems: { itemId: string; path: string };
  shares: { accepted: { slug: string; link: string }; pending: { slug: string; link: string } };
}

interface ItemView {
  id: string;
  name: string;
  kind: string;
  state: string;
  duplicateOf: string | null;
}

const actorHeader = (who: { actorId: string; workspaceId: string }): Record<string, string> => ({
  'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }),
});

async function api<T>(url: string, who: Persona, method: 'GET' | 'POST', path: string, body?: unknown, expected: readonly number[] = [200, 201, 202]): Promise<T> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { ...actorHeader(who), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!expected.includes(res.status)) throw new Error(`seed inbox: ${method} ${path} answered ${String(res.status)}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function until<T>(what: string, timeoutMs: number, fn: () => Promise<T | false | null | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`seed inbox: timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

const SETTLED = new Set(['filed', 'failed', 'held', 'needs_review', 'duplicate', 'discarded']);

async function drop(url: string, entry: SeedInboxDrop, timeoutMs: number): Promise<SeededItem> {
  // A second seeding finds the item by its name: a failed item (the photo) is not a duplicate source, so dropping it again would add a second one.
  const listed = (await api<{ items: ItemView[] }>(url, entry.who, 'GET', `/api/teams/${entry.team}/inbox/items?limit=200`)).items;
  const there = listed.find((i) => i.name === entry.name && i.state !== 'duplicate' && i.state !== 'discarded');
  let item: ItemView;
  if (there) {
    item = { ...there, duplicateOf: there.id };
  } else if (entry.door === 'note') {
    item = (await api<{ item: ItemView }>(url, entry.who, 'POST', `/api/teams/${entry.team}/inbox/notes`, { title: entry.name, text: MEETING_NOTES, teamOnly: false })).item;
  } else {
    const bytes = entry.key === 'pdf' ? seedPdf(RELEASE_CHECKLIST_PDF_LINES) : entry.key === 'photo' ? seedPng() : Buffer.from(CUSTOMER_EML, 'utf8');
    const res = await fetch(`${url}/api/teams/${entry.team}/inbox/items?name=${encodeURIComponent(entry.name)}`, {
      method: 'POST',
      headers: { ...actorHeader(entry.who), 'content-type': 'application/octet-stream' },
      body: bytes as unknown as RequestInit['body'],
    });
    const text = await res.text();
    if (res.status !== 201 && res.status !== 200) throw new Error(`seed inbox: could not drop ${entry.name}: ${String(res.status)} ${text.slice(0, 300)}`);
    item = (JSON.parse(text) as { item: ItemView }).item;
  }
  // A repeat drop answers with a `duplicate` row that names the first item; that is the one to follow.
  const duplicate = item.state === 'duplicate' || item.duplicateOf !== null;
  const id = item.duplicateOf ?? item.id;
  const settled = await until(`${entry.name} to settle`, timeoutMs, async () => {
    const view = (await api<{ item: ItemView }>(url, entry.who, 'GET', `/api/teams/${entry.team}/inbox/items/${id}`)).item;
    return SETTLED.has(view.state) ? view : false;
  });
  return { id, team: entry.team, name: entry.name, kind: settled.kind, state: settled.state, duplicate };
}

async function commit(url: string, who: Persona, team: string, path: string, content: string, message: string): Promise<void> {
  await api(url, who, 'POST', `/api/teams/${team}/repo/commit`, { changes: [{ op: 'put', path, content }], message });
}

/**
 * Seeds the memory inbox and the two shares (PLAN P8-27). Safe to run again: a file dropped twice is a duplicate of the first and nothing is written twice. Throws
 * with the server's words when a step is refused, or when something does not settle in time.
 */
export async function seedInboxAndShares(options: SeedInboxAndSharesOptions): Promise<SeedInboxAndSharesResult> {
  const log = options.log ?? (() => undefined);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const { url } = options;

  const items = {} as Record<SeedInboxKey, SeededItem>;
  for (const entry of SEED_INBOX_DROPS) {
    items[entry.key] = await drop(url, entry, timeoutMs);
    log(`${entry.name}: ${items[entry.key].state}${items[entry.key].duplicate ? ' (already there)' : ''}`);
    if (items[entry.key].state !== entry.ends) throw new Error(`seed inbox: ${entry.name} ended ${items[entry.key].state}, expected ${entry.ends}`);
  }

  // The action items: the concept the Archivist would have written from the notes, named among the notes' filed paths.
  await commit(url, OMAR, SEED_INBOX.team, SEED_INBOX.actionItemsPath, ACTION_ITEMS_CONCEPT, 'Release retro actions');
  const pool = createSystemPool(options.db.systemUrl, 2);
  try {
    await withSystem(
      (tx) => tx.query('UPDATE app.memory_inbox_items SET filed_paths = filed_paths || $2::text[] WHERE id = $1 AND NOT ($2::text[] <@ filed_paths)', [items.notes.id, [SEED_INBOX.actionItemsPath]]),
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
  log(`${SEED_INBOX.actionItemsPath}: action items on the notes`);

  // The shares: committed as a lead does, through a proposal; the platform reads the files and opens one link to Customer support for each.
  for (const share of SHARE_FILES) {
    // A second seeding commits the same file: the proposals route answers 400 "does not change the file", which is the state we want.
    const res = await fetch(`${url}/api/teams/${SEED_INBOX.team}/proposals`, {
      method: 'POST',
      headers: { ...actorHeader(OMAR), 'content-type': 'application/json' },
      body: JSON.stringify({ path: `routines/shares/${share.slug}.yaml`, op: 'put', content: share.yaml, title: `Share ${share.slug}`, applyNow: true }),
    });
    const text = await res.text();
    if (res.status >= 300 && !(res.status === 400 && text.includes('does not change the file'))) throw new Error(`seed inbox: could not commit ${share.slug}: ${String(res.status)} ${text.slice(0, 300)}`);
  }
  const linkOf = async (slug: string): Promise<string> => {
    const view = await until(`share ${slug} and its link`, timeoutMs, async () => {
      const list = await api<{ shares: Array<{ slug: string; status: string; destinations: Array<{ slug: string; link: string }> }> }>(url, OMAR, 'GET', `/api/teams/${SEED_INBOX.team}/shares`);
      const found = list.shares.find((s) => s.slug === slug);
      return found?.status === 'active' && found.destinations.length > 0 ? found : false;
    });
    return view.destinations.find((d) => d.slug === SEED_INBOX.supportTeam)?.link ?? 'missing';
  };
  await linkOf(SEED_INBOX.shares.accepted.slug);
  await linkOf(SEED_INBOX.shares.pending.slug);
  await acceptLink(options.db, SEED_INBOX.shares.accepted.slug);
  const accepted = await linkOf(SEED_INBOX.shares.accepted.slug);
  const pending = await linkOf(SEED_INBOX.shares.pending.slug);
  log(`shares: ${SEED_INBOX.shares.accepted.slug} ${accepted}, ${SEED_INBOX.shares.pending.slug} ${pending}`);

  return {
    items,
    actionItems: { itemId: items.notes.id, path: SEED_INBOX.actionItemsPath },
    shares: { accepted: { slug: SEED_INBOX.shares.accepted.slug, link: accepted }, pending: { slug: SEED_INBOX.shares.pending.slug, link: pending } },
  };
}

/**
 * Customer support accepts the share, as its leads would on the Approvals row: the link moves to `accepted` and the accept row is closed as approved, with a decision
 * that says it was seeded. A second run finds the link accepted and changes nothing. The tables are written by the platform only, so this runs as the system role.
 */
async function acceptLink(db: Pick<TestDatabase, 'systemUrl'>, shareSlug: string): Promise<void> {
  const pool = createSystemPool(db.systemUrl, 2);
  try {
    await withSystem(
      async (tx) => {
        const moved = await tx.query<{ approval_id: string | null }>(
          `UPDATE app.memory_share_links l
              SET state = 'accepted', accepted_at = now(), accepted_by = $4, updated_at = now()
             FROM app.memory_shares s
            WHERE s.id = l.share_id AND s.team_id = l.team_id AND s.team_id = $1 AND s.slug = $2 AND l.dest_team_id = $3 AND l.state = 'requested'
          RETURNING l.approval_id`,
          [TEAM_IDS.Engineering, shareSlug, TEAM_IDS['Customer support'], OMAR.actorId],
        );
        const approvalId = moved.rows[0]?.approval_id;
        if (!approvalId) return;
        await tx.query(
          `INSERT INTO app.approval_decisions (approval_id, workspace_id, team_id, decider_id, decider_name, decision, note)
           VALUES ($1, $2, $3, $4, $5, 'approved', 'Accepted when the demo data was made.') ON CONFLICT DO NOTHING`,
          [approvalId, KAHF_WORKSPACE_ID, TEAM_IDS['Customer support'], OMAR.actorId, OMAR.name],
        );
        await tx.query(
          `UPDATE app.approvals SET status = 'approved', decided_at = now(), outcome = 'ran', outcome_detail = 'Accepted. The other team can now send its digests here.'
            WHERE id = $1 AND status = 'pending'`,
          [approvalId],
        );
      },
      { pool, workspaceId: KAHF_WORKSPACE_ID },
    );
  } finally {
    await pool.end();
  }
}
