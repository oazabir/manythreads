import type { InboxDistiller, InboxDistillResult, JobInfo, PluginContext, PluginTx } from '@manythreads/sdk';
import { ExtractError, extractText } from '@manythreads/sdk/extract';
import type { InboxHoldReason, InboxKind } from '@manythreads/shared';
import { OkfActor, OkfProposal } from '@manythreads/shared';
import { loadInboxConfig, type InboxConfig } from './config.ts';
import { extractKindOf, kindOfName, slugOf, unreadableReason } from './kinds.ts';
import { HOLD_QUEUE } from './receive.ts';
import type { ItemRow } from './rows.ts';
import { claim, enqueueIn, enqueueStep, failItem, holdItem } from './states.ts';
import { attempt, egressPreset, lockItem, notifyDropper, readBlob, sha256Hex, storageOf } from './util.ts';

// Steps 2 to 4 of the pipeline (SPEC §12.2): the hold check, extraction, and distilling. Receive is receive.ts; the commit is commit.ts. Each step is one job; it
// checks that the item is where the step expects it (`stage`, `state`) before it does anything and again before it writes, so a job that runs twice, runs late
// or meets an item a lead has discarded in the meantime does nothing the second time.

/** The most characters of text a distiller is handed. The whole text stays in the Reference. */
export const DISTIL_TEXT_MAX = 60_000;
/** Largest text kept per item, below the table's 1,000,000-character constraint (a redaction can make the text a little longer). */
const STORED_TEXT_MAX = 950_000;
const SECTIONS_MAX = 1_000;
const CHILDREN_MAX = 20;
export const DEFAULT_BUDGET_WAIT_SECONDS = 15 * 60;
export const MAX_PROPOSALS = 20;

// ---- hold check -----------------------------------------------------------------------------------------------------------------------

type HoldFacts = Pick<ItemRow, 'kind' | 'size' | 'origin' | 'sender' | 'sender_check'>;

const senderAllowed = (sender: string | null, allow: readonly string[]): boolean => {
  if (sender === null) return false;
  const s = sender.trim().toLowerCase();
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (e === '') return false;
    return e.startsWith('@') ? s.endsWith(e) : s === e;
  });
};

/**
 * The hold rules, in the order they are told to a lead (SPEC §12.2 step 2), as a pure function so they can be tested one by one. `released` is a lead's or
 * admin's answer to an earlier hold: it ends the check. Never held by anything but these rules: what the item says is not read.
 *  - a bundle from somewhere else, an item over the team's size cap, an email whose sender check failed: held whatever the team's `review` says;
 *  - an email from a sender the team has not named (`allowEmailFrom`) and the door did not verify as a member (`sender_check: pass`): held unless `review: none`;
 *  - `review: all` holds everything.
 */
export function holdVerdict(facts: HoldFacts, config: InboxConfig, released: boolean): { reason: InboxHoldReason; message: string } | null {
  if (released) return null;
  if (facts.kind === 'bundle') return { reason: 'foreign_bundle', message: 'This looks like a memory bundle from somewhere else. A lead or admin decides whether it is let in.' };
  if (Number(facts.size) > config.maxBytes) {
    return { reason: 'oversize', message: `This is larger than the ${Math.max(1, Math.floor(config.maxBytes / 1024 / 1024))} MB this team allows for one drop. A lead or admin decides whether it is let in.` };
  }
  if (facts.origin === 'email') {
    if (facts.sender_check === 'fail') return { reason: 'failed_sender_check', message: 'The sender of this email could not be verified. A lead or admin decides whether it is let in.' };
    if (config.review !== 'none' && facts.sender_check !== 'pass' && !senderAllowed(facts.sender, config.allowEmailFrom)) {
      return { reason: 'unknown_sender', message: 'This email is from someone who is not on this team. A lead or admin decides whether it is let in.' };
    }
  }
  if (config.review === 'all') return { reason: 'review_all', message: config.unreadable ? 'This team’s inbox settings could not be read, so every drop waits for a lead or admin.' : 'This team asks a lead or admin to look at every drop first.' };
  return null;
}

export async function holdStep(ctx: PluginContext, tx: PluginTx, itemId: string): Promise<void> {
  const row = await lockItem(tx, itemId);
  if (!row || row.state !== 'queued' || row.stage !== 'hold') return;
  const config = await loadInboxConfig(ctx, tx, row.team_id);
  const verdict = holdVerdict(row, config, row.released_by !== null);
  if (verdict) {
    await holdItem(ctx, tx, row, verdict.reason, verdict.message);
    return;
  }
  await tx.query(`UPDATE app.memory_inbox_items SET stage = 'extract', not_before = NULL WHERE id = $1`, [row.id]);
  await enqueueStep(ctx, tx, 'extract', row);
}

// ---- extract --------------------------------------------------------------------------------------------------------------------------

type Read = { ok: true; text: string; title: string | null; sections: { label: string; start: number }[]; children: { name: string; bytes: Uint8Array }[] } | { ok: false; message: string };

async function readItem(ctx: PluginContext, row: ItemRow, log: JobInfo['log']): Promise<Read> {
  const kind = row.kind as InboxKind;
  const extractKind = extractKindOf(kind);
  if (kind !== 'link' && extractKind === null) return { ok: false, message: unreadableReason(kind) };
  if (row.blob_key === null) return { ok: false, message: 'The original is no longer kept, so it cannot be read again.' };
  const bytes = await readBlob(storageOf(ctx), row.blob_key, Number(row.size) + 1);
  if (bytes === null) return { ok: false, message: 'The original could not be read from storage.' };
  if (kind === 'link') {
    const url = new TextDecoder().decode(bytes).trim();
    return { ok: true, text: url, title: url, sections: [], children: [] };
  }
  try {
    const read = await extractText(bytes, extractKind as NonNullable<typeof extractKind>, { maxBytes: Math.max(Number(row.size), 1) });
    return {
      ok: true,
      text: read.text,
      title: read.metadata.title,
      sections: read.metadata.sections.slice(0, SECTIONS_MAX),
      children: (read.children ?? []).map((c) => ({ name: c.name, bytes: c.bytes })),
    };
  } catch (err) {
    if (err instanceof ExtractError) return { ok: false, message: err.message };
    log.warn(`memory-inbox: extract of ${row.id} failed: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
    return { ok: false, message: 'This file could not be read.' };
  }
}

/** An email's attachments become items of their own (SPEC §12.2: every door ends in the same pipeline), each with the email's dropper, sender and trust. */
async function fileChildren(ctx: PluginContext, tx: PluginTx, parent: ItemRow, children: readonly { name: string; bytes: Uint8Array }[]): Promise<void> {
  const storage = storageOf(ctx);
  for (const child of children.slice(0, CHILDREN_MAX)) {
    if (child.bytes.length === 0) continue;
    const sha = sha256Hex(child.bytes);
    const seen = (await tx.query(`SELECT 1 FROM app.memory_inbox_items WHERE team_id = $1 AND sha256 = $2 AND state IN ('queued','extracting','filing','filed','held','needs_review') LIMIT 1`, [parent.team_id, sha])).rows[0];
    if (seen) continue;
    const name = child.name.replace(/[\\/]/g, '_').slice(0, 200) || 'attachment';
    const bytes = child.bytes;
    const stored = await storage.put(
      (async function* () {
        yield bytes;
      })(),
      { maxBytes: bytes.length + 1 },
    );
    const made = await attempt(tx, async () =>
      (
        await tx.query<{ id: string }>(
          `INSERT INTO app.memory_inbox_items
             (workspace_id, team_id, parent_id, origin, state, stage, kind, name, size, sha256, blob_key, dropper_id, dropper_name, team_only, sender, sender_check, released_by, released_at)
           VALUES ($1, $2, $3, $4, 'queued', 'hold', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id`,
          [parent.workspace_id, parent.team_id, parent.id, parent.origin, kindOfName(name), name, bytes.length, sha, stored.blobKey, parent.dropper_id, parent.dropper_name, parent.team_only, parent.sender, parent.sender_check, parent.released_by, parent.released_at],
        )
      ).rows[0],
    );
    if (!made.ok || !made.value) {
      await storage.delete(stored.blobKey).catch(() => false);
      continue;
    }
    await ctx.audit.emit(tx, {
      type: 'memory.item.dropped',
      workspaceId: parent.workspace_id,
      teamId: parent.team_id,
      itemId: made.value.id,
      origin: parent.origin,
      kind: kindOfName(name),
      size: bytes.length,
      teamOnly: parent.team_only,
      duplicate: false,
      droppedBy: parent.dropper_id,
      at: ctx.runtime.now().toISOString(),
    });
    await ctx.jobs.enqueue(tx, HOLD_QUEUE, { workspaceId: parent.workspace_id, itemId: made.value.id }, { dedupeKey: `hold:${made.value.id}` });
  }
}

export async function extractStep(ctx: PluginContext, job: JobInfo, itemId: string): Promise<void> {
  const taken = await job.transaction((tx) => claim(ctx, tx, itemId, 'extract', 'extracting'));
  if (taken.kind !== 'go') return;
  const row = taken.row;
  const read = await readItem(ctx, row, job.log);
  await job.transaction(async (tx) => {
    const cur = await lockItem(tx, itemId);
    if (!cur || cur.stage !== 'extract' || cur.state !== 'extracting') return;
    if (!read.ok) {
      await failItem(ctx, tx, cur, 'extract', read.message);
      return;
    }
    const config = await loadInboxConfig(ctx, tx, cur.team_id);
    const released = cur.released_by !== null;
    const setup = await egressPreset(tx, cur.workspace_id);
    // The text is about to be read by a model (the Archivist): the guards see it first, as they see any prompt. A finding holds the item for a lead, who
    // sees the redacted text; once released it goes through as written (never past a preset that refuses). `review: none` accepts the redacted text.
    const decision = await ctx.hooks.runPreEgress(tx, {
      destination: 'memory_inbox',
      workspaceId: cur.workspace_id,
      teamId: cur.team_id,
      text: read.text,
      preset: setup.preset,
      allowlist: setup.allowlist,
      mode: released ? 'approved' : 'hold',
      recorded: false,
    });
    let text = read.text;
    let redacted = false;
    if (decision.hooks > 0) {
      if (decision.outcome === 'block') {
        await failItem(ctx, tx, cur, 'extract', decision.message ?? 'The workspace’s data rules do not let this text go to a model.');
        return;
      }
      if (decision.outcome === 'require_approval' && config.review !== 'none') {
        await holdItem(ctx, tx, cur, 'dlp', 'Something in this looks like private data (a key, a card number or the like). A lead or admin decides whether it is let in.');
        return;
      }
      if (decision.outcome === 'redact' || decision.outcome === 'require_approval') {
        text = decision.text;
        redacted = true;
      }
    }
    await tx.query(
      `INSERT INTO app.memory_inbox_extracts (item_id, team_id, text, title, sections, redacted)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (item_id) DO UPDATE SET text = EXCLUDED.text, title = EXCLUDED.title, sections = EXCLUDED.sections, redacted = EXCLUDED.redacted, proposals = NULL, producer = NULL, updated_at = now()`,
      [cur.id, cur.team_id, text.slice(0, STORED_TEXT_MAX), read.title?.slice(0, 500) ?? null, JSON.stringify(read.sections), redacted],
    );
    if (read.children.length > 0) await fileChildren(ctx, tx, cur, read.children);
    await tx.query(`UPDATE app.memory_inbox_items SET state = 'filing', stage = 'distil' WHERE id = $1`, [cur.id]);
    await enqueueStep(ctx, tx, 'distil', cur);
  });
}

// ---- distil ---------------------------------------------------------------------------------------------------------------------------

/** The path of the Reference concept of an item: fixed from the item's id, so the distiller can link to it before it exists. */
export function referencePathOf(row: Pick<ItemRow, 'id' | 'name'>, title: string | null): string {
  return `memory/references/${slugOf(title ?? row.name)}-${row.id.replace(/-/g, '').slice(-8)}.md`;
}

const usable = (result: InboxDistillResult): InboxDistillResult => {
  if (result.outcome !== 'distilled') return result;
  if (!OkfActor.safeParse(result.producer).success) return { outcome: 'failed', message: 'The Archivist did not say who it is, so its answer was not used.' };
  const parsed = result.proposals.slice(0, MAX_PROPOSALS).map((p) => OkfProposal.safeParse(p));
  const good = parsed.flatMap((p) => (p.success ? [p.data] : []));
  return { outcome: 'distilled', producer: result.producer, proposals: good };
};

export async function distilStep(ctx: PluginContext, job: JobInfo, itemId: string): Promise<void> {
  const taken = await job.transaction((tx) => claim(ctx, tx, itemId, 'distil', 'filing'));
  if (taken.kind !== 'go') return;
  const row = taken.row;
  const ext = await job.transaction(async (tx) => (await tx.query<{ text: string; title: string | null }>('SELECT text, title FROM app.memory_inbox_extracts WHERE item_id = $1', [itemId])).rows[0]);
  if (!ext) {
    // The working copy of the text is gone (it is removed on a discard, or by hand): read the original again.
    await job.transaction(async (tx) => {
      const cur = await lockItem(tx, itemId);
      if (!cur || cur.stage !== 'distil' || cur.state !== 'filing') return;
      await tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', stage = 'extract' WHERE id = $1`, [itemId]);
      await enqueueStep(ctx, tx, 'extract', cur);
    });
    return;
  }
  const distiller = ctx.providers.get<InboxDistiller>('inbox.distiller');
  let result: InboxDistillResult = { outcome: 'none' };
  if (distiller) {
    try {
      result = usable(
        await distiller.distil(
          { transaction: (fn) => job.transaction(fn) },
          {
            workspaceId: row.workspace_id,
            teamId: row.team_id,
            itemId: row.id,
            origin: row.origin,
            kind: row.kind,
            name: row.name,
            text: ext.text.slice(0, DISTIL_TEXT_MAX),
            droppedBy: row.dropper_id,
            referencePath: referencePathOf(row, ext.title),
            teamOnly: row.team_only,
            bindRun: async (tx, runId) => {
              await tx.query('UPDATE app.memory_inbox_items SET drop_run_id = $2::uuid WHERE id = $1', [row.id, runId]);
            },
          },
        ),
      );
    } catch (err) {
      job.log.warn(`memory-inbox: the distiller threw for ${row.id}: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`);
      result = { outcome: 'failed', message: 'The Archivist stopped before it finished.' };
    }
  }
  await job.transaction(async (tx) => {
    const cur = await lockItem(tx, itemId);
    if (!cur || cur.stage !== 'distil' || cur.state !== 'filing') return;
    await tx.query('UPDATE app.memory_inbox_items SET drop_run_id = NULL WHERE id = $1', [itemId]);
    switch (result.outcome) {
      case 'distilled':
        await tx.query('UPDATE app.memory_inbox_extracts SET proposals = $2::jsonb, producer = $3, updated_at = now() WHERE item_id = $1', [itemId, JSON.stringify(result.proposals), result.producer]);
        await tx.query(`UPDATE app.memory_inbox_items SET stage = 'commit' WHERE id = $1`, [itemId]);
        await enqueueStep(ctx, tx, 'commit', cur);
        return;
      case 'none':
        await tx.query(`UPDATE app.memory_inbox_items SET stage = 'commit' WHERE id = $1`, [itemId]);
        await enqueueStep(ctx, tx, 'commit', cur);
        return;
      case 'budget': {
        const seconds = Math.max(30, Math.min(result.retryAfterSeconds ?? DEFAULT_BUDGET_WAIT_SECONDS, 24 * 3600));
        await tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', reason = $2, not_before = now() + make_interval(secs => $3) WHERE id = $1`, [itemId, result.message.slice(0, 400), seconds]);
        await enqueueIn(ctx, tx, 'distil', cur, seconds);
        await notifyDropper(ctx, tx, cur, 'queued');
        return;
      }
      case 'failed':
        await failItem(ctx, tx, cur, 'distil', result.message);
        return;
    }
  });
}
