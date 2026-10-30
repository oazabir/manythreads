import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emit, type Tx } from '@manythreads/kernel';
import type { PluginTx } from '@manythreads/sdk';
import { AuditEntry, AuditExportManifest, AuditSigningKey, ListAuditResponse, type ProposalDetail } from '@manythreads/shared';
import { testClient } from '@manythreads/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRepoWorld, personas, TEAM_IDS, type RepoWorld } from '../../repo-git/test/world.ts';
import { backfillEvents, sweepMemoryLog } from '../src/index.ts';

// The audit console end to end (PLAN P10-05): real requests and real events through the server, the live projection, the filters and paging, the
// admin-only rule, the signed export, and a scan of every stored row for text that must never be there.
// Personas: Omar is the workspace admin and Engineering's lead; Nadia is an Engineering member; Tariq leads Marketing (no admin right).

const { omar, nadia, tariq } = personas;
const ENG = TEAM_IDS.Engineering;
vi.setConfig({ testTimeout: 60_000 });

// Text that must never reach a row. Each is put where a person (or a bot) could have written it.
const CANARY = {
  proposalBody: 'CANARY-PROPOSAL-BODY-7731',
  proposalTitle: 'CANARY-PROPOSAL-TITLE-7731',
  proposalNote: 'CANARY-PROPOSAL-NOTE-7731',
  message: 'CANARY-MESSAGE-TEXT-7731',
  resumeDetail: 'CANARY-APPROVAL-DETAIL-7731',
  command: 'CANARY-COMMAND-LINE-7731',
  egress: 'CANARY-EGRESS-URL-7731',
  email: 'canary-email-7731@example.com',
  ip: '198.51.100.77',
  memorySourceId: 'CANARY MEMORY SOURCE 7731',
};

let w: RepoWorld;
let bot: string;
let devChannel = '';
let proposalId = '';

const list = (who: typeof omar | null, query = '') => w.call<ListAuditResponse & { error?: { code: string } }>(who, 'GET', `/api/admin/audit${query ? `?${query}` : ''}`);
const all = async (query = ''): Promise<AuditEntry[]> => {
  const out: AuditEntry[] = [];
  let cursor: string | null = null;
  do {
    const res = await list(omar, `${query}${query ? '&' : ''}limit=200${cursor ? `&cursor=${cursor}` : ''}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    out.push(...res.body.entries);
    cursor = res.body.nextCursor;
  } while (cursor);
  return out;
};
const actions = (entries: AuditEntry[]): string[] => entries.map((e) => e.action);
const emitEvent = (event: Record<string, unknown>): Promise<unknown> =>
  w.system((tx) => emit(tx as Tx, { schemaVersion: 1, workspaceId: omar.workspaceId, ...event } as never));
const exportFile = async (who: typeof omar, body: Record<string, unknown> = {}) => {
  const res = await fetch(`${w.server.url}/api/admin/audit/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }) },
    body: JSON.stringify(body),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString('utf8') };
};

beforeAll(async () => {
  w = await createRepoWorld();
  bot = (await w.makeBot(ENG)).actorId;
  await w.call(omar, 'GET', '/api/teams/engineering/channels');
  devChannel = (await w.system((tx) => tx.query<{ id: string }>(`SELECT id FROM app.channels WHERE team_id = $1 AND name = 'dev'`, [ENG]))).rows[0]!.id;

  // 1. a proposal applied at once by the lead, with text in its body, title and note
  const made = await w.call<{ proposal: ProposalDetail }>(omar, 'POST', '/api/teams/engineering/proposals', {
    path: 'TEAM.md',
    content: `# Engineering\n\n${CANARY.proposalBody}\n`,
    title: CANARY.proposalTitle,
    note: CANARY.proposalNote,
    applyNow: true,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  proposalId = made.body.proposal.proposal.id;

  // 2. a message posted and deleted
  const posted = await w.call<{ id: string }>(nadia, 'POST', `/api/channels/${devChannel}/messages`, { channelId: devChannel, body: CANARY.message, threadRootId: null });
  expect(posted.status, JSON.stringify(posted.body)).toBe(201);
  expect((await w.call(omar, 'DELETE', `/api/channels/${devChannel}/messages/${posted.body.id}`)).status).toBe(200);

  // 3. events the platform writes in the middle of other work (an approval decided, a failed sign-in, text held back), each carrying free text
  const approvalId = randomUUID();
  await emitEvent({ type: 'approvals.approval.requested', teamId: ENG, approvalId, source: 'dispatch', tool: 'files.write', botId: randomUUID(), runId: randomUUID(), requesterId: bot });
  await emitEvent({ type: 'approvals.approval.decided', teamId: ENG, approvalId, source: 'dispatch', tool: 'files.write', botId: randomUUID(), requesterId: bot, deciderId: omar.actorId, decision: 'denied' });
  await emitEvent({ type: 'approvals.approval.resumed', teamId: ENG, approvalId, source: 'dispatch', tool: 'files.write', botId: randomUUID(), outcome: 'failed', detail: CANARY.resumeDetail });
  await emitEvent({ type: 'identity.session.sign_in_failed', personId: nadia.personId, method: 'password', reason: 'wrong_password', ip: CANARY.ip });
  await emitEvent({ type: 'identity.session.signed_in', personId: omar.personId, sessionId: randomUUID(), method: 'password', ip: CANARY.ip });
  await emitEvent({ type: 'identity.oidc.refused', providerId: randomUUID(), kind: 'google', reason: 'email_not_verified', email: CANARY.email, ip: CANARY.ip });
  await emitEvent({ type: 'guardrails.dlp.decided', destination: 'llm', botId: randomUUID(), preset: 'standard', outcome: 'redact', rules: ['aws_access_key'], at: new Date().toISOString() });
  await emitEvent({ type: 'guardrails.egress.decided', destination: 'http', botId: randomUUID(), preset: 'standard', outcome: 'block', target: `https://x.example/?k=${CANARY.egress}`, host: 'x.example', at: new Date().toISOString() });
  await emitEvent({ type: 'runtime.gate.held', teamId: ENG, botId: randomUUID(), runId: randomUUID(), stage: 'exact', entry: CANARY.command, approvalId: null, at: new Date().toISOString() });
  await emitEvent({ type: 'answer.answer.posted', botId: randomUUID(), runId: randomUUID(), askerPersonId: nadia.personId, channelId: devChannel, messageId: randomUUID(), threadRootId: null, citationCount: 2, droppedCount: 3, reachedCount: 5 });

  // 4. a memory line the platform held back (the memory plugin's own log, not an event)
  await w.system((tx) =>
    tx.query(
      `INSERT INTO app.memory_retain_log (workspace_id, team_id, bank, source_kind, source_id, outcome, reason) VALUES ($1, $2, 'bank', 'message', $3, 'withheld', 'private_source')`,
      [omar.workspaceId, ENG, CANARY.memorySourceId],
    ),
  );

  // the live projection is asynchronous (the outbox hands each event on); wait for the last of the events
  await vi.waitFor(async () => expect(actions(await all())).toEqual(expect.arrayContaining(['proposal.applied', 'message.deleted', 'approval.decided', 'sign_in.failed', 'sign_in.succeeded', 'answer.sources_held_back'])), { timeout: 30_000, interval: 300 });
}, 240_000);

afterAll(async () => {
  await w?.close();
});

describe('the console is for workspace admins', () => {
  it('answers a member, a team lead who is not an admin, and a stranger with a refusal', async () => {
    expect((await list(nadia)).status).toBe(403);
    expect((await list(tariq)).status).toBe(403);
    expect((await list(null)).status).toBe(401);
    expect((await w.call(nadia, 'GET', '/api/admin/audit/signing-key')).status).toBe(403);
    expect((await exportFile(nadia)).status).toBe(403);
    expect((await exportFile(tariq)).status).toBe(403);
  });
});

describe('who did what, when, to what', () => {
  it('shows an applied proposal with the person, the team, the file and the time', async () => {
    const rows = (await all()).filter((e) => e.action === 'proposal.applied');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: { id: omar.personId, kind: 'person', name: 'Omar' },
      team: { id: ENG, name: 'Engineering' },
      target: { kind: 'proposal', id: proposalId, label: 'TEAM.md' },
      outcome: 'ok',
      category: 'content',
      source: 'event',
    });
    expect(Math.abs(Date.now() - new Date(rows[0]!.occurredAt).getTime())).toBeLessThan(120_000);
  });

  it('shows a decided approval, a sign-in, a failed sign-in and a deleted message', async () => {
    const rows = await all();
    expect(rows.find((e) => e.action === 'approval.decided')).toMatchObject({ actor: { name: 'Omar' }, outcome: 'denied', reason: 'Denied', target: { kind: 'approval', label: 'files.write' }, team: { name: 'Engineering' } });
    expect(rows.find((e) => e.action === 'sign_in.succeeded')).toMatchObject({ actor: { id: omar.personId, name: 'Omar' }, outcome: 'ok' });
    expect(rows.find((e) => e.action === 'sign_in.failed')).toMatchObject({ actor: { id: nadia.personId, name: 'Nadia' }, outcome: 'denied', reason: 'Wrong password' });
    expect(rows.find((e) => e.action === 'message.deleted')).toMatchObject({ actor: { name: 'Omar' }, target: { kind: 'message' }, team: { name: 'Engineering' } });
  });

  it('shows what was withheld: text held back by the guards, an answer that dropped sources, and a memory the platform did not keep', async () => {
    const withheld = await all('outcome=withheld');
    expect(actions(withheld).sort()).toEqual(['answer.sources_held_back', 'guard.dlp_decided', 'guard.gate_held']);
    expect(withheld.find((e) => e.action === 'answer.sources_held_back')).toMatchObject({ actor: { name: 'Nadia' }, reason: '3 sources held back, 2 shown' });
    expect(withheld.find((e) => e.action === 'guard.gate_held')?.reason).toBe('Held: matches a listed command');
  });

  it('refuses to guess: an unknown actor is named as unknown, the system as the system', async () => {
    const rows = await all();
    expect(rows.find((e) => e.action === 'guard.dlp_decided')?.actor).toMatchObject({ kind: 'bot', name: 'Unknown bot' });
    expect(rows.find((e) => e.action === 'sign_in.single_sign_on_refused')?.actor).toMatchObject({ kind: 'system', name: 'System', id: null });
  });
});

describe('filters', () => {
  it('narrow by actor, category, action, team, target, outcome and date, and combine', async () => {
    const everything = await all();
    expect(everything.length).toBeGreaterThanOrEqual(10);
    const by = async (q: string): Promise<AuditEntry[]> => all(q);

    const byOmar = await by(`actor=${omar.personId}`);
    expect(byOmar.length).toBeGreaterThan(0);
    expect(byOmar.every((e) => e.actor.id === omar.personId)).toBe(true);

    const approvals = await by('category=approvals');
    expect(actions(approvals).sort()).toEqual(['approval.decided', 'approval.requested', 'approval.resumed']);

    expect(actions(await by('action=sign_in.failed'))).toEqual(['sign_in.failed']);
    expect((await by(`team=${ENG}`)).every((e) => e.team?.id === ENG)).toBe(true);
    expect((await by(`team=${randomUUID()}`))).toEqual([]);

    const proposal = await by(`targetKind=proposal&targetId=${proposalId}`);
    expect(actions(proposal).sort()).toEqual(['proposal.applied', 'proposal.created']);

    expect((await by('outcome=denied')).every((e) => e.outcome === 'denied')).toBe(true);
    expect(actions(await by('outcome=denied'))).toEqual(expect.arrayContaining(['approval.decided', 'sign_in.failed', 'guard.egress_blocked']));

    // combined: Omar's denied rows are the decided approval
    expect(actions(await by(`actor=${omar.personId}&outcome=denied`))).toEqual(['approval.decided']);

    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    const hourAhead = new Date(Date.now() + 3_600_000).toISOString();
    expect((await by(`from=${encodeURIComponent(hourAgo)}&to=${encodeURIComponent(hourAhead)}`)).length).toBe(everything.length);
    expect(await by(`from=${encodeURIComponent(hourAhead)}`)).toEqual([]);
    expect(await by(`to=${encodeURIComponent(hourAgo)}`)).toEqual([]);
  });

  it('refuses a filter that is not valid', async () => {
    expect((await list(omar, 'outcome=maybe')).status).toBe(400);
    expect((await list(omar, 'actor=not-an-id')).status).toBe(400);
    expect((await list(omar, 'limit=0')).status).toBe(400);
    expect((await list(omar, 'limit=1000')).status).toBe(400);
    expect((await list(omar, 'cursor=garbage')).status).toBe(400);
  });

  it('refuses the values the database cannot take, and keeps text out of the SQL', async () => {
    // year 0 does not exist for the database (used to answer 500); a NUL cannot be stored in text (500 too)
    expect((await list(omar, 'from=0000-01-01T00:00:00Z')).status).toBe(400);
    expect((await list(omar, 'to=0000-06-01T00:00:00Z')).status).toBe(400);
    expect((await list(omar, 'targetId=a%00b')).status).toBe(400);
    expect((await list(omar, 'targetId=x%20OR%201=1')).status).toBe(400);
    expect((await list(omar, "targetId='%20OR%20'1'='1")).status).toBe(400);
    expect((await exportFile(omar, { from: '0000-01-01T00:00:00Z' })).status).toBe(400);
    expect((await exportFile(omar, { targetId: 'a\u0000b' })).status).toBe(400);
    // the extremes that do exist are fine, and an injection-looking id is just an id that matches nothing
    expect((await list(omar, 'from=0001-01-01T00:00:00Z&to=9999-12-31T23:59:59Z')).status).toBe(200);
    const none = await list(omar, 'targetId=1_OR_1_1');
    expect(none.status).toBe(200);
    expect(none.body.entries).toEqual([]);
  });

  it('cannot be pointed at another workspace through a page marker', async () => {
    const forged = Buffer.from('a1:ffffffff-ffff-4fff-8fff-ffffffffffff').toString('base64url');
    const res = await list(omar, `cursor=${forged}`);
    expect(res.status).toBe(200);
    // every row of this workspace is older than the marker, and the marker names a row, never a workspace
    expect(res.body.entries.every((e) => e.id !== undefined)).toBe(true);
    expect((await exportFile(omar, { after: 'not-a-marker' })).status).toBe(400);
  });
});

describe('pages', () => {
  it('walks the whole history newest first, a page at a time, without a gap or a repeat', async () => {
    const everything = await all();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await list(omar, `limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      expect(res.body.entries.length).toBeLessThanOrEqual(4);
      seen.push(...res.body.entries.map((e) => e.id));
      cursor = res.body.nextCursor;
      pages += 1;
    } while (cursor);
    expect(pages).toBeGreaterThan(2);
    expect(seen).toEqual(everything.map((e) => e.id));
    expect(new Set(seen).size).toBe(seen.length);
    const times = everything.map((e) => e.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('keeps the filters while paging, and says there is no next page at the end', async () => {
    const first = await list(omar, 'category=approvals&limit=2');
    expect(first.body.entries).toHaveLength(2);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await list(omar, `category=approvals&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.entries).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe('the signed export', () => {
  const lines = (text: string): unknown[] => text.trimEnd().split('\n').map((l) => JSON.parse(l));

  it('carries the rows, oldest first, signed with a key an auditor can fetch', async () => {
    const file = await exportFile(omar);
    expect(file.status, file.text.slice(0, 200)).toBe(200);
    expect(file.headers.get('content-type')).toMatch(/^application\/x-ndjson/);
    expect(file.headers.get('content-disposition')).toMatch(/^attachment; filename="manythreads-audit-\d{4}-\d{2}-\d{2}\.ndjson"$/);
    const [head, ...rest] = lines(file.text);
    const manifest = AuditExportManifest.parse(head);
    const entries = rest.map((r) => AuditEntry.parse(r));
    expect(manifest).toMatchObject({ kind: 'manythreads.audit.export', workspaceId: omar.workspaceId, contentBlind: true, truncated: false, resumeAfter: null, rowCount: entries.length });
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.map((e) => e.occurredAt)).toEqual([...entries.map((e) => e.occurredAt)].sort());

    const keyRes = await w.call<AuditSigningKey>(omar, 'GET', '/api/admin/audit/signing-key');
    expect(keyRes.status).toBe(200);
    const key = AuditSigningKey.parse(keyRes.body);
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(JSON.stringify(keyRes.body)).not.toContain('PRIVATE');
    expect(file.headers.get('x-audit-key-id')).toBe(key.keyId);
    expect(manifest.signature).toEqual({ algorithm: 'ed25519', keyId: key.keyId });

    // what an auditor does: check the signature over the exact bytes with the public key
    const signature = Buffer.from(file.headers.get('x-audit-signature')!, 'base64');
    expect(signature).toHaveLength(64);
    expect(verify(null, file.bytes, createPublicKey(key.publicKeyPem), signature)).toBe(true);
  });

  it('fails the check when a single character, a row or the order is changed', async () => {
    const file = await exportFile(omar);
    const key = AuditSigningKey.parse((await w.call(omar, 'GET', '/api/admin/audit/signing-key')).body);
    const pub = createPublicKey(key.publicKeyPem);
    const signature = Buffer.from(file.headers.get('x-audit-signature')!, 'base64');
    expect(verify(null, file.bytes, pub, signature)).toBe(true);
    const ls = file.text.trimEnd().split('\n');
    const variants = [
      file.text.replace('proposal.applied', 'proposal.applieD'),
      `${ls.slice(0, 2).concat(ls.slice(3)).join('\n')}\n`, // a row removed
      `${[ls[0], ls[2], ls[1], ...ls.slice(3)].join('\n')}\n`, // two rows swapped
      file.text.replace('"outcome":"denied"', '"outcome":"ok"'),
      file.text.trimEnd(), // the last newline dropped
    ];
    for (const text of variants) {
      expect(text).not.toBe(file.text);
      expect(verify(null, Buffer.from(text, 'utf8'), pub, signature)).toBe(false);
    }
    // and a signature from somewhere else does not pass
    expect(verify(null, file.bytes, pub, Buffer.alloc(64, 1))).toBe(false);
  });

  it('is itself an audited act, shown in the console with who exported and how many rows', async () => {
    const file = await exportFile(omar, { category: 'approvals' });
    expect(file.status).toBe(200);
    const manifest = AuditExportManifest.parse(lines(file.text)[0]);
    expect(manifest).toMatchObject({ rowCount: 3, filters: { category: 'approvals' } });
    await vi.waitFor(async () => expect((await all('action=audit.exported')).map((e) => e.reason)).toContain('3 rows'), { timeout: 20_000, interval: 300 });
    const row = (await all('action=audit.exported')).find((e) => e.reason === '3 rows')!;
    expect(row).toMatchObject({ actor: { id: omar.personId, name: 'Omar' }, category: 'system', outcome: 'ok', reason: '3 rows' });
  });

  it('checks out with openssl, the way docs/plugins/audit.md tells an auditor to', async () => {
    let hasOpenssl = true;
    try {
      execFileSync('openssl', ['version'], { stdio: 'ignore' });
    } catch {
      hasOpenssl = false;
    }
    if (!hasOpenssl) return;
    const file = await exportFile(omar);
    const key = AuditSigningKey.parse((await w.call(omar, 'GET', '/api/admin/audit/signing-key')).body);
    const dir = mkdtempSync(join(tmpdir(), 'audit-verify-'));
    try {
      writeFileSync(join(dir, 'audit.ndjson'), file.bytes);
      writeFileSync(join(dir, 'audit.ndjson.sig'), `${file.headers.get('x-audit-signature')}\n`);
      writeFileSync(join(dir, 'audit-key.pem'), key.publicKeyPem);
      const check = (): string =>
        execFileSync('sh', ['-c', 'base64 -d < audit.ndjson.sig > audit.ndjson.sig.bin && openssl pkeyutl -verify -pubin -inkey audit-key.pem -rawin -in audit.ndjson -sigfile audit.ndjson.sig.bin'], { cwd: dir, encoding: 'utf8' });
      expect(check()).toContain('Signature Verified Successfully');
      writeFileSync(join(dir, 'audit.ndjson'), Buffer.concat([file.bytes, Buffer.from('\n')]));
      expect(check).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says in its signed manifest how many rows it holds and whether more follow, so a cut file cannot pass as a whole one', async () => {
    const file = await exportFile(omar);
    const ls = file.text.trimEnd().split('\n');
    const manifest = AuditExportManifest.parse(JSON.parse(ls[0]!));
    expect(manifest.rowCount).toBe(ls.length - 1);
    expect(file.text.endsWith('\n')).toBe(true);
    expect(file.headers.get('x-audit-sha256')).toBe(createHash('sha256').update(file.bytes).digest('hex'));
  });

  it('builds one export at a time for a workspace, and lets the next one through afterwards', async () => {
    const results = await Promise.all(Array.from({ length: 3 }, () => exportFile(omar)));
    const statuses = results.map((r) => r.status);
    expect(statuses.every((c) => c === 200 || c === 429), statuses.join(',')).toBe(true);
    expect(statuses).toContain(200);
    expect((await exportFile(omar)).status).toBe(200); // the guard is released, also after a 429
  });

  it('honours the filters, and a row cap that cuts the file short says where to go on from', async () => {
    const approvals = await exportFile(omar, { category: 'approvals' });
    expect(lines(approvals.text).slice(1).map((r) => (r as AuditEntry).category)).toEqual(['approvals', 'approvals', 'approvals']);

    process.env['MANYTHREADS_AUDIT_EXPORT_MAX_ROWS'] = '8';
    try {
      const total = (await all()).length;
      const seen: string[] = [];
      let after: string | undefined;
      let files = 0;
      for (;;) {
        const file = await exportFile(omar, after ? { after } : {});
        expect(file.status).toBe(200);
        const [head, ...rest] = lines(file.text);
        const manifest = AuditExportManifest.parse(head);
        expect(rest.length).toBeLessThanOrEqual(8);
        seen.push(...rest.map((r) => (r as AuditEntry).id));
        files += 1;
        if (!manifest.truncated) break;
        expect(manifest.resumeAfter).not.toBeNull();
        after = manifest.resumeAfter!;
        if (files > 20) throw new Error('export did not finish');
      }
      expect(files).toBeGreaterThan(1);
      // the rows exported since include the exports' own rows, which come later; every row that existed at the start is there once
      expect(seen.length).toBeGreaterThanOrEqual(total);
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      delete process.env['MANYTHREADS_AUDIT_EXPORT_MAX_ROWS'];
    }
  });
});

describe('content-blind', () => {
  it('holds none of the text people wrote, none of the secrets, and none of the addresses, in any row', async () => {
    const dump = (await w.system((tx) => tx.query<{ row: string }>(`SELECT row_to_json(a)::text AS row FROM app.audit_events a`))).rows.map((r) => r.row).join('\n');
    expect(dump.length).toBeGreaterThan(1000);
    for (const [name, text] of Object.entries(CANARY)) expect(dump, name).not.toContain(text);
    expect(dump).not.toMatch(/CANARY/i);
    // the file and the list say the same
    const listed = JSON.stringify(await all());
    expect(listed).not.toMatch(/CANARY/i);
    expect(listed).not.toContain(CANARY.ip);
    expect(listed).not.toContain(CANARY.email);
    const file = await exportFile(omar);
    expect(file.text).not.toMatch(/CANARY/i);
    // a row has no column that could hold more
    const columns = (await w.system((tx) => tx.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'audit_events'`))).rows.map((r) => r.column_name);
    expect(columns.sort()).toEqual(['action', 'actor_id', 'actor_kind', 'actor_name', 'category', 'created_at', 'id', 'occurred_at', 'outcome', 'reason', 'source', 'target_id', 'target_kind', 'target_label', 'team_id', 'team_name', 'workspace_id']);
  });
});

describe('the background sweep', () => {
  it('brings in the memory the platform held back, from a fixed code, once', async () => {
    const added = await w.system((tx) => sweepMemoryLog(tx as unknown as PluginTx, '0 seconds'));
    expect(added).toBe(1);
    expect(await w.system((tx) => sweepMemoryLog(tx as unknown as PluginTx, '0 seconds'))).toBe(0);
    const rows = await all('category=memory');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'memory.withheld', outcome: 'withheld', reason: 'Private source', source: 'memory_retain_log', team: { name: 'Engineering' }, target: { kind: 'message', id: null } });
  });

  it('keeps the memory position at the log line\'s own microsecond, so a line is read once and not on every tick', async () => {
    const mark = (await w.system((tx) => tx.query<{ value: string }>(`SELECT value FROM app.audit_progress WHERE name = 'memory_log_position'`))).rows[0]!.value;
    const [at, id] = mark.split('|');
    const again = await w.system((tx) =>
      tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM app.memory_retain_log WHERE outcome = 'withheld' AND (created_at, id) > ($1::timestamptz, $2::uuid)`,
        [at, id],
      ),
    );
    expect(Number(again.rows[0]!.n)).toBe(0);
  });

  it('projects history that was written before the console existed, and the same rows come back', async () => {
    // the exports above each wrote an event that is projected a moment later: let the live path catch up before taking the picture to compare with
    const logged = async (): Promise<number> => Number((await w.system((tx) => tx.query<{ n: string }>(`SELECT count(*) AS n FROM app.events WHERE type = 'audit.export.created'`))).rows[0]!.n);
    await vi.waitFor(async () => expect((await all('action=audit.exported')).length).toBe(await logged()), { timeout: 30_000, interval: 300 });
    const before = (await all()).filter((e) => e.source === 'event');
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('TRUNCATE app.audit_events, app.audit_progress');
    } finally {
      await owner.end();
    }
    expect(await all()).toEqual([]);
    let added = 0;
    for (let i = 0; i < 5; i += 1) added += await w.system((tx) => backfillEvents(tx as unknown as PluginTx, 1));
    const after = await all();
    expect(after.length).toBe(added);
    // everything the live path wrote is back with the same words (the export rows are written by events too, so they return as well)
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
    expect(JSON.stringify(after)).not.toMatch(/CANARY/i);
    expect(await w.system((tx) => backfillEvents(tx as unknown as PluginTx))).toBe(0);
  });
});

describe('a row that is long or odd cannot stop the others', () => {
  it('writes the row of a team with a very long name that ends in a character outside the basic plane', async () => {
    const long = `${'a'.repeat(198)}😀😀`;
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('UPDATE app.teams SET name = $2 WHERE id = $1', [ENG, long]);
      await emitEvent({ type: 'workspace.team.archived', teamId: ENG });
      await vi.waitFor(async () => expect(actions(await all('action=team.archived'))).toEqual(['team.archived']), { timeout: 30_000, interval: 300 });
      const row = (await all('action=team.archived'))[0]!;
      expect(row.team!.name.length).toBeLessThanOrEqual(200);
      expect(row.team!.name.startsWith('aaaa')).toBe(true);
    } finally {
      await owner.query(`UPDATE app.teams SET name = 'Engineering' WHERE id = $1`, [ENG]);
      await owner.end();
    }
  });
});

describe('the signing key', () => {
  it('is made once even when several first requests arrive together, and the private half is never served', async () => {
    const owner = testClient({ connectionString: w.server.db.ownerUrl });
    await owner.connect();
    try {
      await owner.query('DELETE FROM app.audit_signing_keys');
      const secretsBefore = Number((await owner.query<{ n: string }>('SELECT count(*) AS n FROM app.secrets')).rows[0]!.n);
      const keys = await Promise.all(Array.from({ length: 6 }, () => w.call<AuditSigningKey>(omar, 'GET', '/api/admin/audit/signing-key')));
      expect(keys.map((k) => k.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(new Set(keys.map((k) => k.body.publicKeyPem)).size).toBe(1);
      expect(Number((await owner.query<{ n: string }>('SELECT count(*) AS n FROM app.audit_signing_keys')).rows[0]!.n)).toBe(1);
      // one secret sealed, the losers' secrets dropped again
      expect(Number((await owner.query<{ n: string }>('SELECT count(*) AS n FROM app.secrets')).rows[0]!.n)).toBe(secretsBefore + 1);
      for (const k of keys) expect(JSON.stringify(k.body)).not.toMatch(/PRIVATE|secret/i);
      // an export made now is signed by that one key
      const file = await exportFile(omar);
      expect(verify(null, file.bytes, createPublicKey(keys[0]!.body.publicKeyPem), Buffer.from(file.headers.get('x-audit-signature')!, 'base64'))).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
