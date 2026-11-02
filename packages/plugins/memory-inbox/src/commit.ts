import type { PluginContext, PluginTx, RepoProvider, RepoWriteChange } from '@manythreads/sdk';
import { bundleAbsoluteLinks, conceptText, isConceptPath, OkfProposal, parseConcept, type InboxOrigin } from '@manythreads/shared';
import { MAX_PROPOSALS, referencePathOf } from './pipeline.ts';
import type { ItemRow } from './rows.ts';
import { claim, enqueueStep, failItem } from './states.ts';
import { attempt, egressPreset, notifyDropper, statusOf } from './util.ts';

// Steps 5 and 6 of the pipeline (SPEC §12.2): validate and stamp what the distiller proposed, then one commit on the team's repo writer with the concepts and the
// platform's own Reference of the text. The platform writes the Reference itself, whatever the distiller did, so an item always leaves something in memory
// that points back at its original, and a team with no Archivist still gets its files searchable.

/** Largest extracted text copied into the Reference, in characters: it is a pointer to the original with enough text to search, not a second copy of a book. */
export const REFERENCE_TEXT_MAX = 20_000;
const CONCEPT_BYTES_MAX = 900_000;
/** Who the platform is on a concept it wrote itself (`generated.by`). */
export const PLATFORM_PRODUCER = 'process:inbox';

const tailOf = (id: string): string => id.replace(/-/g, '').slice(-8);

/** Where the original is told to live (`resource` of the Reference): the Files `inbox/filed/<yyyy-mm>/` folder, by a name made safe to show. */
export function originalPathOf(row: Pick<ItemRow, 'id' | 'name'>, filedAt: Date): string {
  const month = `${filedAt.getUTCFullYear()}-${String(filedAt.getUTCMonth() + 1).padStart(2, '0')}`;
  const safe = row.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
  return `inbox/filed/${month}/${tailOf(row.id)}-${safe}`;
}

const withoutLoneSurrogate = (text: string): string => (/[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text);

export function referenceConcept(
  row: Pick<ItemRow, 'name' | 'kind' | 'team_only'>,
  extract: { text: string; title: string | null },
  originalPath: string,
  at: string,
): string {
  const title = (extract.title ?? row.name).slice(0, 500);
  const full = extract.text.length > REFERENCE_TEXT_MAX;
  const shown = full ? withoutLoneSurrogate(extract.text.slice(0, REFERENCE_TEXT_MAX)) : extract.text;
  const frontmatter: Record<string, unknown> = {
    type: 'Reference',
    title,
    description: `The text of ${row.name}, dropped into the team’s inbox.`.slice(0, 2000),
    tags: [row.kind],
    resource: originalPath,
    sources: [{ resource: originalPath, title: row.name.slice(0, 500) }],
    generated: { by: PLATFORM_PRODUCER, at },
    origin: 'drop',
  };
  if (row.team_only) frontmatter['share'] = 'never';
  const note = full ? `\n\n(Shortened: the first ${REFERENCE_TEXT_MAX.toLocaleString('en-US')} of ${extract.text.length.toLocaleString('en-US')} characters. The original has all of it.)` : '';
  const body = `# ${title.replace(/\s+/g, ' ')}\n\nFiled from \`${originalPath}\`.\n\n## Text\n\n${shown}${note}\n`;
  return conceptText(frontmatter, body);
}

// ---- validate and stamp ---------------------------------------------------------------------------------------------------------------

function pathProblem(path: string): string | null {
  if (path.length > 500) return 'The path is too long.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\\]/.test(path)) return 'The path has a character a path cannot have.';
  if (path.split('/').some((s) => s === '' || s === '.' || s === '..')) return 'The path has an empty or relative part.';
  if (!isConceptPath(path)) return 'A concept is a .md file under memory/ (not index.md or log.md).';
  if (path.startsWith('memory/shared/')) return 'memory/shared/ holds what other teams shared; a drop does not write there.';
  if (path.startsWith('memory/references/')) return 'References are written by the platform.';
  return null;
}

async function exists(tx: PluginTx, repo: RepoProvider, teamId: string, path: string): Promise<boolean> {
  try {
    await repo.blob(tx, teamId, path, 'HEAD', 1);
    return true;
  } catch (err) {
    const status = statusOf(err);
    if (status === 404) return false;
    if (status === 413) return true;
    throw err;
  }
}

export interface Accepted {
  path: string;
  content: string;
}
export interface Validated {
  accepted: Accepted[];
  /** Why each left-out proposal was left out, in plain words, for the item's note. */
  left: string[];
}

/**
 * Checks what a distiller proposed against the bundle's rules and writes the platform's stamps: the path stays in `memory/` (outside `shared/` and
 * `references/`), nothing that exists is overwritten (a taken path gets this item's tail), the guards see the body, links become bundle-absolute, and
 * `sources`, `generated` and `origin: drop` are the platform's — a proposal cannot set them (the schema has no such keys). The result parses as a concept.
 */
export async function validateProposals(
  ctx: PluginContext,
  tx: PluginTx,
  repo: RepoProvider,
  row: ItemRow,
  proposals: readonly OkfProposal[],
  producer: string,
  originalPath: string,
  referencePath: string,
  at: string,
): Promise<Validated> {
  const accepted: Accepted[] = [];
  const left: string[] = [];
  const taken = new Set<string>([referencePath]);
  const setup = await egressPreset(tx, row.workspace_id);
  let n = 0;
  for (const proposal of proposals.slice(0, MAX_PROPOSALS)) {
    n += 1;
    const label = proposal.title ?? proposal.path;
    const problem = pathProblem(proposal.path);
    if (problem) {
      left.push(`${label}: ${problem}`);
      continue;
    }
    if (proposal.type === undefined) {
      left.push(`${label}: it has no type.`);
      continue;
    }
    let path = proposal.path;
    if (taken.has(path) || (await exists(tx, repo, row.team_id, path))) path = path.replace(/\.md$/, `-${tailOf(row.id)}.md`);
    if (taken.has(path) || (await exists(tx, repo, row.team_id, path))) {
      left.push(`${label}: a concept with that name already exists.`);
      continue;
    }
    const decision = await ctx.hooks.runPreEgress(tx, {
      destination: 'memory',
      workspaceId: row.workspace_id,
      teamId: row.team_id,
      text: proposal.body ?? '',
      preset: setup.preset,
      allowlist: setup.allowlist,
      mode: 'preset',
      recorded: false,
    });
    if (decision.hooks > 0 && (decision.outcome === 'block' || decision.outcome === 'require_approval')) {
      left.push(`${label}: it holds something the workspace’s data rules do not let into memory.`);
      continue;
    }
    const body = bundleAbsoluteLinks(decision.hooks > 0 && decision.outcome === 'redact' ? decision.text : (proposal.body ?? ''), path);
    const frontmatter: Record<string, unknown> = { type: proposal.type };
    if (proposal.title !== undefined) frontmatter['title'] = proposal.title;
    if (proposal.description !== undefined) frontmatter['description'] = proposal.description;
    if (proposal.tags !== undefined) frontmatter['tags'] = proposal.tags;
    if (proposal.status !== undefined) frontmatter['status'] = proposal.status;
    if (proposal.staleAfter !== undefined) frontmatter['stale_after'] = proposal.staleAfter;
    if (proposal.resource !== undefined) frontmatter['resource'] = proposal.resource;
    frontmatter['sources'] = [{ resource: originalPath, title: row.name.slice(0, 500) }];
    frontmatter['generated'] = { by: producer, at };
    frontmatter['origin'] = 'drop';
    if (row.team_only) frontmatter['share'] = 'never';
    const content = conceptText(frontmatter, body);
    const parsed = parseConcept(content);
    if (!parsed.ok) {
      left.push(`${label}: ${parsed.reason}`);
      continue;
    }
    if (Buffer.byteLength(content) > CONCEPT_BYTES_MAX) {
      left.push(`${label}: it is too long.`);
      continue;
    }
    taken.add(path);
    accepted.push({ path, content });
  }
  if (proposals.length > n) left.push(`${proposals.length - n} more than ${MAX_PROPOSALS} were proposed; the rest were left out.`);
  return { accepted, left };
}

// ---- the step -------------------------------------------------------------------------------------------------------------------------

const repoRefusal = (status: number): string =>
  status === 409
    ? 'The team’s memory changed while this was being filed. Retry files it again.'
    : status === 413
      ? 'This is too large to write into the team’s memory.'
      : 'The team’s memory refused the write. Retry tries again.';

export async function commitStep(ctx: PluginContext, tx: PluginTx, itemId: string): Promise<void> {
  const taken = await claim(ctx, tx, itemId, 'commit', 'filing');
  if (taken.kind !== 'go') return;
  const row = taken.row;
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (!repo) throw new Error('The team repo is not available');
  const ext = (
    await tx.query<{ text: string; title: string | null; proposals: unknown; producer: string | null }>('SELECT text, title, proposals, producer FROM app.memory_inbox_extracts WHERE item_id = $1', [itemId])
  ).rows[0];
  if (!ext) {
    await tx.query(`UPDATE app.memory_inbox_items SET state = 'queued', stage = 'extract' WHERE id = $1`, [itemId]);
    await enqueueStep(ctx, tx, 'extract', row);
    return;
  }
  const now = ctx.runtime.now();
  const at = now.toISOString();
  const referencePath = referencePathOf(row, ext.title);
  const originalPath = originalPathOf(row, row.created_at);
  const proposed = OkfProposal.array().safeParse(ext.proposals ?? []);
  const proposals = proposed.success ? proposed.data : [];
  const producer = ext.producer ?? PLATFORM_PRODUCER;
  const checked = proposals.length > 0 ? await validateProposals(ctx, tx, repo, row, proposals, producer, originalPath, referencePath, at) : { accepted: [], left: [] };
  const looked = !proposed.success ? ['The Archivist’s answer could not be read.'] : checked.left;

  // Nothing the Archivist proposed can be filed: a lead looks, unless a lead has already looked at this item (a release keeps `failed_stage = validate`).
  if ((proposals.length > 0 || !proposed.success) && checked.accepted.length === 0 && row.failed_stage !== 'validate') {
    const why = looked.slice(0, 3).join(' ').slice(0, 330);
    await tx.query(`UPDATE app.memory_inbox_items SET state = 'needs_review', failed_stage = 'validate', reason = $2 WHERE id = $1`, [itemId, `Nothing the Archivist proposed could be filed. ${why}`.slice(0, 400)]);
    await notifyDropper(ctx, tx, row, 'needs_review');
    return;
  }

  const changes: RepoWriteChange[] = [
    { path: referencePath, op: 'put', content: referenceConcept(row, ext, originalPath, at) },
    ...checked.accepted.map((c): RepoWriteChange => ({ path: c.path, op: 'put', content: c.content, baseBlobSha: null })),
  ];
  const coAuthors = row.dropper_id !== null && row.dropper_name !== null && !(await isBot(tx, row.dropper_id)) ? [{ actorId: row.dropper_id, name: row.dropper_name }] : [];
  const message = `Inbox: file ${row.name}`.replace(/\s+/g, ' ').slice(0, 120);
  const wrote = await attempt(tx, () => repo.write(tx, row.team_id, { id: tx.actor.id, kind: 'system' }, changes, message, coAuthors));
  if (!wrote.ok) {
    const status = statusOf(wrote.error);
    if (status !== null && status >= 400 && status < 500) {
      await failItem(ctx, tx, row, 'commit', repoRefusal(status));
      return;
    }
    throw wrote.error;
  }
  const note = looked.length > 0 ? `Filed, but ${looked.length === 1 ? 'one proposed concept was' : `${looked.length} proposed concepts were`} left out. ${looked.slice(0, 2).join(' ')}`.slice(0, 400) : null;
  const paths = changes.map((c) => c.path);
  await tx.query(
    `UPDATE app.memory_inbox_items
        SET state = 'filed', stage = 'done', filed_paths = $2::text[], commit_sha = $3, filed_at = now(), failed_stage = NULL, reason = $4, drop_run_id = NULL, not_before = NULL
      WHERE id = $1`,
    [itemId, paths, wrote.value.sha, note],
  );
  await tx.query('DELETE FROM app.memory_inbox_extracts WHERE item_id = $1', [itemId]);
  await ctx.audit.emit(tx, {
    type: 'memory.item.filed',
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    itemId,
    origin: row.origin as InboxOrigin,
    concepts: paths.length,
    commitSha: wrote.value.sha,
    distilled: checked.accepted.length > 0,
    droppedBy: row.dropper_id,
    at,
  });
  await notifyDropper(ctx, tx, row, 'filed');
}

async function isBot(tx: PluginTx, actorId: string): Promise<boolean> {
  return (await tx.query<{ kind: string }>('SELECT kind FROM app.actors WHERE id = $1', [actorId])).rows[0]?.kind === 'bot';
}

// Kept for the keep-originals job: a Reference line saying the original was removed.
export const removedNote = (on: string): string => `\n> The original file was removed on ${on}. The text above is what was kept.\n`;
