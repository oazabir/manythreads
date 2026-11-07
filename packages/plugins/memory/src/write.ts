import { MemoryError, refuseBankFields, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import { OkfProposal, bundleAbsoluteLinks, conceptText, parseConcept, trustTier } from '@manythreads/shared';
import { isPersonOwned } from './ownership.ts';
import { PersonalStore } from './personal-store.ts';

// `memory.write`: the ONE door a bot writes the team's OKF bundle through (SPEC §12.1, PLAN P5-26). It is a capability of this plugin (the MCP
// gateway describes it — `gateway-mcp`'s catalog — and the broker's grant decides who has it), and the write itself goes through the ONE repo
// writer, as the bot, under the `memory.write` capability the path guard knows.
//
// What the platform owns, the tool decides:
//   * the path — `memory/**.md`, never `memory/shared/**`, never the platform's own `index.md`/`log.md`, never a non-concept file. The rule is the
//     broker's path guard's (`checkBotWritePath`, the same one every `files.*` call goes through): this handler does not re-implement it, it
//     lets the writer ask, so a refusal is the audit event the guard raises;
//   * `generated.by` — `<bot slug>/<model alias>` (SPEC §12.1's `archivist/<alias>`), from `app.memory_run_context()`; never the model's word;
//   * the commit's author (the bot) and its co-author (the person who asked the run), and
//   * what a model may NOT claim: `sources`, `generated`, `verified`, `origin`, `share` and `usage_window` are dropped from the proposal and
//     reported back in `dropped`, so a bot cannot invent provenance it does not have (criterion 16).
//
// And what a person owns, the tool must not touch: a concept whose latest author or last verifier is a person is never overwritten — the same
// concept is filed as a `draft` sibling that links to it instead (stable per bot, so a bot's repeated attempts update one draft).

/** Said to the model with every answer that wrote nothing. */
const NO_RUN_TEXT = 'memory.write runs inside one live run of a bot: there is no bot to write as here.';

/** The frontmatter keys the platform owns: a proposal may carry them (a model may have learned they exist), and the tool drops them and says so. */
export const PLATFORM_OWNED_KEYS: readonly string[] = ['sources', 'generated', 'verified', 'origin', 'share', 'usage_window'];

/** How often a write is retried when the file changed between reading it and committing (the writer's 409, a person editing at the same moment). */
export const MEMORY_WRITE_ATTEMPTS = 3;

export type ToolAnswer = { ok: true; [key: string]: unknown } | { ok: false; code: string; message: string; status?: number };

const refuse = (code: string, message: string): ToolAnswer => ({ ok: false, code, message });

const issuesText = (error: { issues: { path: PropertyKey[]; message: string }[] }): string =>
  error.issues.map((i) => `${i.path.map(String).join('.') || '(arguments)'}: ${i.message}`).join('; ');

const statusOf = (err: unknown): number | null => {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : null;
};

/** True for the writer's own refusal (`RepoError`, named rather than imported: a plugin cannot reach into repo-git). Its message is a sentence written for the reader. */
const isRepoRefusal = (err: unknown): err is Error & { code: string } =>
  err instanceof Error && err.name === 'RepoError' && typeof (err as { code?: unknown }).code === 'string';

/**
 * A refusal from the writer (`RepoError`: a status, a code, a sentence) or a `MemoryError` (a forged bank key) as the model reads it. Anything else
 * (a database error, a bug) is rethrown: the MCP gateway turns a thrown error into a generic answer and logs the real text server-side, so a raw
 * driver message never reaches the model.
 */
function answerFor(err: unknown): ToolAnswer {
  if (err instanceof MemoryError) return { ok: false, code: err.code, message: err.message, ...(err.status === null ? {} : { status: err.status }) };
  if (isRepoRefusal(err)) {
    const status = statusOf(err);
    return { ok: false, code: err.code, message: err.message, ...(status === null ? {} : { status }) };
  }
  throw err;
}

/**
 * A proposal split into what the concept is and what the platform will not take from a model. Runs before the schema parse (like
 * `refuseBankFields`) so that a dropped key is reported rather than refused as an unknown one.
 */
export function splitPlatformKeys(input: unknown): { values: Record<string, unknown>; dropped: string[] } {
  const values: Record<string, unknown> = {};
  const dropped: string[] = [];
  const source = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(source)) {
    if (PLATFORM_OWNED_KEYS.includes(key)) dropped.push(key);
    else values[key] = value;
  }
  return { values, dropped };
}

/**
 * The path a bot files a draft under when it may not overwrite the concept: `<base>-draft-<bot slug>.md` beside it (PLAN P5-26). Stable per bot,
 * so a bot that proposes the same change twice updates one draft, and two bots get one each.
 */
export function draftPathFor(path: string, botSlug: string): string {
  const cut = path.lastIndexOf('/');
  const dir = path.slice(0, cut + 1);
  const name = path.slice(cut + 1);
  const base = name.endsWith('.md') ? name.slice(0, -3) : name;
  const slug = botSlug.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40) || 'bot';
  return `${dir}${base}-draft-${slug}.md`;
}

/** A frontmatter object in the order the platform writes it; `parseConcept`/`serializeConcept` normalise it again, so the reader sees the same. */
function frontmatterFor(proposal: OkfProposal, generated: { by: string; at: string }, status?: 'draft'): Record<string, unknown> {
  const frontmatter: Record<string, unknown> = {};
  // Left out when absent, so the parser's own refusal (`the frontmatter has no \`type\``) is what the model reads — not a sentence this file wrote.
  if (proposal.type !== undefined) frontmatter['type'] = proposal.type;
  if (proposal.title !== undefined) frontmatter['title'] = proposal.title;
  if (proposal.description !== undefined) frontmatter['description'] = proposal.description;
  if (proposal.tags !== undefined) frontmatter['tags'] = proposal.tags;
  const effective = status ?? proposal.status;
  if (effective !== undefined) frontmatter['status'] = effective;
  if (proposal.staleAfter !== undefined) frontmatter['stale_after'] = proposal.staleAfter;
  if (proposal.resource !== undefined) frontmatter['resource'] = proposal.resource;
  frontmatter['generated'] = generated;
  return frontmatter;
}

// `conceptText` and `bundleAbsoluteLinks` live in @manythreads/shared (okf/links.ts) so the memory inbox's commit step uses the same two.
export { bundleAbsoluteLinks, conceptText, isPersonOwned };

// ---- the run, and reading the file the proposal is about ------------------------------------------------------------------------------

interface RunContext {
  teamId: string;
  askerId: string | null;
  askerKind: string | null;
  askerName: string | null;
  botSlug: string;
  botName: string;
  /** `<bot slug>/<model alias>` (or the runtime when the definition names no alias), the `generated.by` of everything this run writes. */
  botProducer: string;
}

interface RunContextRow extends Record<string, unknown> {
  team_id: string;
  asker_id: string | null;
  asker_kind: string | null;
  asker_name: string | null;
  bot_slug: string;
  bot_name: string;
  bot_producer: string;
}

/** Who this transaction's run writes as, from `app.memory_run_context()` (migration 0004); null when it is not a live run's own bot. */
async function runContext(tx: PluginTx): Promise<RunContext | null> {
  const row = (
    await tx.query<RunContextRow>('SELECT team_id, asker_id, asker_kind, asker_name, bot_slug, bot_name, bot_producer FROM app.memory_run_context()')
  ).rows[0];
  if (row === undefined) return null;
  return {
    teamId: row.team_id,
    askerId: row.asker_id,
    askerKind: row.asker_kind,
    askerName: row.asker_name,
    botSlug: row.bot_slug,
    botName: row.bot_name,
    botProducer: row.bot_producer,
  };
}

/** A file of the team's repo as text, with the blob the edit is based on; null when the team has no such file. */
async function readText(tx: PluginTx, repo: RepoProvider, teamId: string, path: string): Promise<{ text: string; blobSha: string } | null> {
  try {
    const blob = await repo.blob(tx, teamId, path, 'main');
    return { text: new TextDecoder().decode(blob.content), blobSha: blob.sha };
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/** The draft's body: what it is, where the concept it is about lives, then the proposal's own text. */
function draftBody(proposal: OkfProposal, body: string): string {
  const link = `/${proposal.path.replace(/^memory\//, '')}`;
  const title = proposal.title ?? proposal.path.slice(proposal.path.lastIndexOf('/') + 1);
  return [
    `> A bot proposes this as a draft: [${title}](${link}) was last written or verified by a person, so \`memory.write\` does not overwrite it.`,
    '',
    body,
  ].join('\n');
}

// ---- the asking person's own Memory (P20-05) ---------------------------------------------------------------------------------------------

/** Why a run may not write a person's Memory, in words for the model (`app.run_space_context().personal_reason`). */
const PERSONAL_REFUSAL: Record<string, string> = {
  team_audience: 'This run answers in a team context, so it has no access to anyone’s Personal memory.',
  no_asker: 'This run has no asking person, so it has no Personal memory to write.',
  no_personal_space: 'The person who asked has no Personal space.',
  not_requested: 'This bot’s definition does not ask for Personal access (personal.read), so it may not write Personal memory.',
  declined: 'The person who asked has not allowed this bot to use their Personal space.',
};

/**
 * `memory.write` with `target: 'personal'`: the concept goes into the OKF bundle of the person who asked, kept as rows. Whose bundle is never an
 * argument: it is the run's asker, and only when the database says this run may use their Personal space right now. The same shared check
 * (`validateOkfWrite`) as a team's write is run by the store; the database door refuses a bot that tries to replace a file a person wrote or
 * verified, and then the concept is filed as a draft beside it, as in a team.
 */
async function writePersonal(ctx: PluginContext, tx: PluginTx, proposal: OkfProposal, run: RunContext, dropped: string[]): Promise<ToolAnswer> {
  const space = (
    await tx.query<{ asker_person_id: string | null; personal_allowed: boolean; personal_reason: string | null }>(
      'SELECT asker_person_id, personal_allowed, personal_reason FROM app.run_space_context()',
    )
  ).rows[0];
  if (space === undefined) return refuse('no_run', NO_RUN_TEXT);
  if (!space.personal_allowed || space.asker_person_id === null) {
    return { ok: false, status: 403, code: 'personal_not_open', message: PERSONAL_REFUSAL[space.personal_reason ?? ''] ?? 'Personal memory is not open to this run.' };
  }
  const owner = space.asker_person_id;
  const decision = await ctx.capabilities.authorize(tx, 'memory.write', { path: proposal.path.startsWith('memory/') ? proposal.path : `memory/${proposal.path}` });
  if (!decision.allowed) return { ok: false, status: 403, code: 'forbidden', message: decision.reason };
  if (decision.needsApproval) return { ok: false, status: 403, code: 'forbidden', message: `Writing “${proposal.path}” needs a person's approval` };

  // The bundle's paths are relative to its root; a model that copied the team form (`memory/…`) is understood.
  const path = proposal.path.replace(/^memory\//, '');
  const at = ctx.runtime.now().toISOString();
  const store = new PersonalStore(tx, owner);
  const attempt = async (target: string, draft: boolean) => {
    const rel: OkfProposal = { ...proposal, path: target };
    const body = bundleAbsoluteLinks(rel.body ?? '', `memory/${target}`);
    const text = conceptText(frontmatterFor(rel, { by: run.botProducer, at }, draft ? 'draft' : undefined), draft ? draftBody({ ...rel, path: `memory/${path}` }, body) : body);
    return { text, result: await store.put(target, text) };
  };
  let target = path;
  let draft = false;
  let { text, result } = await attempt(target, false);
  if (result.status === 'person_owned') {
    target = draftPathFor(path, run.botSlug);
    draft = true;
    ({ text, result } = await attempt(target, true));
  }
  if (result.status === 'invalid') return { ok: false, status: 422, code: 'okf_invalid', message: `“${target}”: ${result.reason ?? 'not a valid concept'}` };
  if (result.status === 'forbidden') return { ok: false, status: 403, code: 'forbidden', message: 'This run may not write that Personal memory.' };
  if (result.status === 'too_many_files') return { ok: false, status: 409, code: 'too_many_files', message: 'The person’s Memory already holds the most files it can (2,000).' };
  if (result.status === 'too_large') return { ok: false, status: 422, code: 'too_large', message: 'That concept is larger than a memory file may be (1,000,000 bytes).' };
  if (result.status !== 'ok' && result.status !== 'unchanged') return { ok: false, status: 409, code: result.status, message: 'The concept could not be saved.' };
  if (result.status === 'ok') {
    await ctx.audit.emit(tx, {
      type: 'memory.personal.written',
      workspaceId: tx.actor.workspaceId,
      personId: owner,
      op: 'put',
      versionNo: result.versionNo,
      authorKind: 'bot',
      at,
    });
  }
  const parsedBack = parseConcept(text);
  return {
    ok: true,
    space: `person:${owner}`,
    path: target,
    draft,
    ...(draft ? { of: path } : {}),
    trustTier: parsedBack.ok ? trustTier(parsedBack.frontmatter) : 'unverified',
    committed: result.status === 'ok',
    version: result.versionNo,
    dropped,
  };
}

/**
 * The `memory.write` capability (PLAN P5-26). Registered here, implemented here; the MCP gateway describes it. A refusal is an answer: the model reads
 * `{ ok: false, code, message, status }` and can try again. A fault (a database error, a bug) is thrown, so the gateway can word it generically.
 */
export function registerWriteTool(ctx: PluginContext): void {
  ctx.capabilities.register('memory.write', async (input, tx): Promise<ToolAnswer> => {
    try {
      refuseBankFields(input);
      const { values: allValues, dropped } = splitPlatformKeys(input);
      // `target` says WHERE the concept goes: the team's bundle (the default) or the asking person's own Memory. It chooses between the two spaces
      // the run may already use; it never widens them, because a personal write is refused unless the database says this run may use that space.
      const { target, ...values } = allValues;
      if (target !== undefined && target !== 'team' && target !== 'personal') return refuse('invalid_arguments', 'target: must be “team” or “personal”');
      const parsed = OkfProposal.safeParse(values);
      if (!parsed.success) return refuse('invalid_arguments', issuesText(parsed.error));
      const proposal = parsed.data;
      if (tx.actor.kind !== 'bot') {
        return { ok: false, status: 403, code: 'forbidden', message: 'memory.write commits as the bot of the run it is called in.' };
      }
      const run = await runContext(tx);
      if (run === null) return refuse('no_run', NO_RUN_TEXT);
      if (target === 'personal') return await writePersonal(ctx, tx, proposal, run, dropped);
      const repo = ctx.providers.get<RepoProvider>('repo');
      if (repo === undefined) return { ok: false, status: 503, code: 'unavailable', message: 'This deployment has no repository module loaded.' };

      // The broker first, as `pages.write` does: a bot's denial — no grant, the path guard, needs approval — is audited (`kernel.capability.denied`)
      // before anything is read, and the writer asks again when the commit is made.
      const decision = await ctx.capabilities.authorize(tx, 'memory.write', { path: proposal.path });
      if (!decision.allowed) return { ok: false, status: 403, code: 'forbidden', message: decision.reason };
      if (decision.needsApproval) return { ok: false, status: 403, code: 'forbidden', message: `Writing “${proposal.path}” needs a person's approval` };

      const at = ctx.runtime.now().toISOString();
      const body = bundleAbsoluteLinks(proposal.body ?? '', proposal.path);
      const author = { id: tx.actor.id, kind: 'bot' as const, name: run.botName };
      // The asking person is the co-author of what their run wrote (PLAN P5-26). A delegated run's asker is a bot, and a bot is not a co-author.
      const coAuthors =
        run.askerKind === 'person' && run.askerId !== null && run.askerName !== null ? [{ actorId: run.askerId, name: run.askerName }] : [];

      for (let attempt = 1; ; attempt += 1) {
        // Re-read on every attempt: between reading the file and committing it a person may have written or verified it, and then what is due
        // is a draft sibling, not an overwrite.
        const current = await readText(tx, repo, run.teamId, proposal.path);
        const draft = current !== null && isPersonOwned(current.text);
        const target = draft ? draftPathFor(proposal.path, run.botSlug) : proposal.path;
        const text = conceptText(frontmatterFor(proposal, { by: run.botProducer, at }, draft ? 'draft' : undefined), draft ? draftBody(proposal, body) : body);
        const check = parseConcept(text);
        if (!check.ok) return { ok: false, status: 422, code: 'okf_invalid', message: `“${target}”: ${check.reason}` };
        // A create-only base when the file must not exist yet, and the blob we read when it must still hold what we read: the writer's 409 is
        // how two writers of one file are told apart, and the loop above decides again with what the file says now.
        const base = draft ? ((await readText(tx, repo, run.teamId, target))?.blobSha ?? null) : (current?.blobSha ?? null);
        try {
          const result = await repo.write(
            tx,
            run.teamId,
            author,
            [{ path: target, op: 'put', content: text, baseBlobSha: base }],
            draft ? `memory.write: ${target} (draft for ${proposal.path})` : `memory.write: ${target}`,
            coAuthors,
            { capability: 'memory.write' },
          );
          return {
            ok: true,
            path: target,
            draft,
            ...(draft ? { of: proposal.path } : {}),
            trustTier: trustTier(check.frontmatter),
            committed: !result.noop,
            sha: result.sha,
            dropped,
          };
        } catch (err) {
          if (attempt < MEMORY_WRITE_ATTEMPTS && statusOf(err) === 409) continue;
          throw err;
        }
      }
    } catch (err) {
      return answerFor(err);
    }
  });
}
