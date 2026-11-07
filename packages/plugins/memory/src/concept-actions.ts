import { HttpError, notFound, invalid, type PluginContext, type PluginTx, type RepoProvider } from '@manythreads/sdk';
import { isConceptPath, parseConcept, serializeConcept, trustTier } from '@manythreads/shared';

// Confirm and Deprecate on the Concepts tab (P21-15). A person acts on one concept of the team's OKF bundle (`memory/**`), and the change is a
// commit of the one repo writer, made as that person:
//
//   * Confirm   — the writer's own stamp does the work. A person's write sets `generated.by: human:<id>` and APPENDS `{ by: human:<id>, at }` to
//                 `verified` (SPEC §12.1: "verified is appended when a person confirms a concept or edits it"), which is what the trust tier reads
//                 (`human:` verifier → human-reviewed). The tool never builds a `verified` entry itself, so a bot cannot, and a person's claim is
//                 always their own actor id.
//   * Deprecate — sets `status: deprecated` (kept for links and history, not recalled by default, forgotten by the bank's next re-retain).
//                 Because it is a person's write, the same stamp marks the concept as looked at by that person; that is the writer's rule for any
//                 person's edit, not something this route adds.
//
// Owner decision taken as the simplest defensible default (docs/plugins/memory.md): both are idempotent. A concept that is already human-reviewed
// is not confirmed again, and one that is already deprecated is not rewritten: the answer is `ok: true` with no commit, so the verification list
// does not grow with every click. Who may do it is the writer's rule for a person's write into the team's repo (a member who can post), so a
// reader of the team gets the writer's 403 and the file is untouched.

export type ConceptAction = 'confirm' | 'deprecate';

/** How often the change is tried when the file changed between reading it and committing (a person or a bot wrote the same concept at that moment). */
export const CONCEPT_ACTION_ATTEMPTS = 3;

const statusOf = (err: unknown): number | null => {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : null;
};

/** The writer's refusal (a `RepoError`, named rather than imported: a plugin cannot reach into repo-git) as an HTTP refusal; anything else is rethrown. */
function mapRepoError(err: unknown): never {
  const e = err as { status?: number; code?: string; message?: string; name?: string };
  if (e?.name === 'RepoError' && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    throw new HttpError(e.status, (e.code ?? 'validation_failed') as never, e.message ?? 'Refused');
  }
  throw err;
}

/**
 * Confirms or deprecates the concept at `path` of the team (`memory/…md`). Resolves with `changed: false` when there was nothing to do.
 * 400 for a path that is not a concept of the bundle, 404 for a concept that is not there, 422-from-the-writer for text that is no longer a concept.
 */
export async function changeConcept(ctx: PluginContext, tx: PluginTx, teamId: string, path: string, action: ConceptAction): Promise<{ changed: boolean }> {
  if (!isConceptPath(path)) throw invalid('That is not a concept of the memory bundle');
  const repo = ctx.providers.get<RepoProvider>('repo');
  if (repo === undefined) throw new HttpError(503, 'internal', 'The team repository is not available');

  for (let attempt = 1; ; attempt += 1) {
    let blob;
    try {
      blob = await repo.blob(tx, teamId, path, 'main');
    } catch (err) {
      if (statusOf(err) === 404) throw notFound('There is no such concept');
      return mapRepoError(err);
    }
    const text = new TextDecoder().decode(blob.content);
    const parsed = parseConcept(text);
    if (!parsed.ok) throw new HttpError(422, 'validation_failed', `This file is not a valid concept: ${parsed.reason}`);
    if (action === 'confirm' && trustTier(parsed.frontmatter) === 'human-reviewed') return { changed: false };
    if (action === 'deprecate' && parsed.frontmatter.status === 'deprecated') return { changed: false };

    // Confirm writes the file as it is (the writer's stamp is the change); Deprecate writes it with its status set.
    const next = action === 'confirm' ? text : serializeConcept({ ...parsed.frontmatter, status: 'deprecated' }, parsed.body);
    try {
      const result = await repo.write(
        tx,
        teamId,
        { id: tx.actor.id, kind: 'person' },
        [{ path, op: 'put', content: next, baseBlobSha: blob.sha }],
        action === 'confirm' ? `memory: confirm ${path}` : `memory: deprecate ${path}`,
      );
      return { changed: !result.noop };
    } catch (err) {
      if (attempt < CONCEPT_ACTION_ATTEMPTS && statusOf(err) === 409) continue;
      return mapRepoError(err);
    }
  }
}
