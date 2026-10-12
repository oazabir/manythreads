import { createHash } from 'node:crypto';
import {
  MemoryError,
  type MemoryBank,
  type MemoryHit,
  type MemoryProvider,
  type MemoryRecallRequest,
  type MemoryRecallResult,
  type MemoryRetainItem,
  type MemoryRetainOptions,
  type MemoryRetainResult,
  type PluginTx,
} from '@manythreads/sdk';
import type { z } from 'zod';
import { HindsightError, type HindsightClient } from './hindsight.ts';
import { DocumentIds, RecallRequest, RetainItems, refuseBankFields } from './schemas.ts';

// The `provider.memory` contract (SPEC section 12.1, PLAN P5-12). This file is where "a bot cannot choose its bank" is made true:
//
//  * the bank name (`team:<workspace slug>:<team slug>`) is computed here, from a team slug the DATABASE returned — never from a field of any input (`refuseBankFields` throws on
//    one, and every input schema is strict, so there is nowhere to put it);
//  * for a run, the team comes from `app.memory_run_scope()` (migration 0001): a definer function that answers only for the run the
//    transaction carries (`app.run_id()`, set by the kernel's run service and nothing else), only while it is live, and only when the
//    transaction's actor is that run's bot or the person who asked. The run's team was fixed when the pairing token opened it;
//  * for the platform, `forTeam` needs the system role (checked by the database, `app.is_system()`), so a request-time plugin cannot name a team.

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * The bank of a team: `team:<workspace slug>:<team slug>`. SPEC 12.1 says `team:<slug>`; a team slug is unique only inside its workspace, and one
 * engine may serve several, so the workspace is part of the name (two workspaces with a team `engineering` must never share a bank). Both slugs are
 * immutable (docs/plugins/teams.md). Throws for a slug that is not one — the bank name is part of a URL path and of an audit line.
 */
export function bankIdFor(workspaceSlug: string, teamSlug: string): string {
  if (!SLUG.test(workspaceSlug) || !SLUG.test(teamSlug)) throw new MemoryError('unknown_team', 'The team has no usable slug.');
  return `team:${workspaceSlug}:${teamSlug}`;
}

interface RunScopeRow extends Record<string, unknown> {
  run_id: string;
  team_id: string;
  team_slug: string;
  workspace_slug: string;
  bot_id: string;
  /** Null when the run may add to the team bank; else why not (see migration 0001). */
  retain_refusal: 'person_source' | 'private_source' | 'conversation' | 'private_thread' | 'private_channel' | null;
}

const REFUSAL_TEXT: Record<NonNullable<RunScopeRow['retain_refusal']>, string> = {
  person_source: 'This run read something that belongs to one person, so it may not add to the team’s memory.',
  private_source: 'This run read something from a private channel or a conversation (or something that cannot be shown to be public), so it may not add to the team’s memory.',
  conversation: 'This run is a private conversation with one person, so it may not add to the team’s memory.',
  private_channel: 'This run answers in a private channel or conversation, so it may not add to the team’s memory.',
  private_thread: 'This run was started in a private channel or conversation, so it may not add to the team’s memory.',
};

/** What the platform stamps on everything a bank takes in, after the caller's own metadata so it cannot be overridden. */
interface Stamp {
  source: 'run' | 'platform';
  team: string;
  workspace: string;
  runId?: string;
  botId?: string;
}

const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);

/** `run:`/`platform:` ids belong to the derivation below; nobody supplies one (a caller could otherwise replace another run's fact). */
const RESERVED_ID = /^(run|platform):/;

/** The document of an item the caller gave no id: from the run and everything that makes the item what it is, so two different items never collide. */
function derivedDocumentId(stamp: Stamp, item: MemoryRetainItem): string {
  const digest = hash(JSON.stringify([item.content, item.context ?? null, item.tags ?? []]));
  return stamp.runId ? `run:${stamp.runId}:${digest}` : `platform:${digest}`;
}

function unavailable(err: unknown): MemoryError {
  if (err instanceof MemoryError) return err;
  if (err instanceof HindsightError) {
    if (err.status === 0 && /no Hindsight URL/.test(err.message)) return new MemoryError('not_configured', 'No memory engine is configured in this deployment.');
    return new MemoryError('unavailable', `The memory engine did not answer: ${err.message}`);
  }
  return new MemoryError('unavailable', err instanceof Error ? err.message : 'The memory engine failed.');
}

function makeBank(client: HindsightClient, id: string, stamp: Stamp, options: { retainRefusal?: string }): MemoryBank {
  const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (!client.enabled) throw new MemoryError('not_configured', 'No memory engine is configured in this deployment.');
    try {
      return await fn();
    } catch (err) {
      throw unavailable(err);
    }
  };
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    refuseBankFields(value);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new MemoryError('invalid_request', `${issue ? `${issue.path.map(String).join('.') || '(input)'}: ${issue.message}` : 'invalid input'}`);
    }
    return parsed.data;
  };

  return {
    id,

    async recall(request: MemoryRecallRequest): Promise<MemoryRecallResult> {
      const input = parse(RecallRequest, request);
      return guard(async () => {
        const facts = await client.recall(id, { query: input.query, ...(input.tags ? { tags: input.tags } : {}) });
        const hits: MemoryHit[] = facts.slice(0, input.limit ?? 10).map((f) => ({
          id: f.id,
          text: f.text,
          type: f.type,
          context: f.context,
          tags: f.tags,
          documentId: f.documentId,
        }));
        return { bank: id, hits };
      });
    },

    async retain(items: readonly MemoryRetainItem[], retainOptions?: MemoryRetainOptions): Promise<MemoryRetainResult> {
      const input = parse(RetainItems, items);
      if (input.some((i) => i.documentId !== undefined && RESERVED_ID.test(i.documentId))) {
        throw new MemoryError('invalid_request', 'Document ids starting with “run:” or “platform:” are reserved for the platform.');
      }
      if (options.retainRefusal) throw new MemoryError('retain_refused', options.retainRefusal);
      return guard(async () => {
        const out = await client.retain(
          id,
          input.map((item) => ({
            content: item.content,
            ...(item.context !== undefined ? { context: item.context } : {}),
            ...(item.timestamp !== undefined ? { timestamp: item.timestamp } : {}),
            ...(item.tags !== undefined ? { tags: item.tags } : {}),
            // A run's item with no document id gets one derived from the run and the content: a repeat of the same call is an upsert, and a
            // model cannot name a document (so it cannot replace one that is not its own).
            documentId: item.documentId ?? derivedDocumentId(stamp, item),
            metadata: {
              ...item.metadata,
              source: stamp.source,
              team: stamp.team,
              workspace: stamp.workspace,
              ...(stamp.runId ? { run_id: stamp.runId } : {}),
              ...(stamp.botId ? { bot_id: stamp.botId } : {}),
            },
          })),
          { async: retainOptions?.async === true },
        );
        return { bank: id, items: out.items, async: out.async };
      });
    },

    async forget(documentIds: readonly string[]): Promise<{ forgotten: number }> {
      const ids = parse(DocumentIds, documentIds);
      return guard(async () => {
        let forgotten = 0;
        for (const documentId of ids) if (await client.deleteDocument(id, documentId)) forgotten += 1;
        return { forgotten };
      });
    },
  };
}

export interface MemoryProviderDeps {
  /** The engine client, looked up per call (the URL comes from the environment and a test sets it late). */
  client(): HindsightClient;
}

export function createMemoryProvider(deps: MemoryProviderDeps): MemoryProvider {
  return {
    id: 'memory-hindsight',
    get enabled(): boolean {
      return deps.client().enabled;
    },

    async forRun(tx: PluginTx): Promise<MemoryBank> {
      const row = (
        await tx.query<RunScopeRow>('SELECT run_id, team_id, team_slug, workspace_slug, bot_id, retain_refusal FROM app.memory_run_scope()')
      ).rows[0];
      if (!row) throw new MemoryError('no_run', 'Memory is available inside a live run only.');
      return makeBank(
        deps.client(),
        bankIdFor(row.workspace_slug, row.team_slug),
        { source: 'run', team: row.team_slug, workspace: row.workspace_slug, runId: row.run_id, botId: row.bot_id },
        row.retain_refusal ? { retainRefusal: REFUSAL_TEXT[row.retain_refusal] ?? REFUSAL_TEXT.private_source } : {},
      );
    },

    async forTeam(tx: PluginTx, teamId: string): Promise<MemoryBank> {
      if (tx.actor.kind !== 'system') throw new MemoryError('system_required', 'A team’s memory is reached by the platform’s own work only.');
      // The database decides who is the system (`app.is_system()` is the role, not a setting); a transaction that only claims to be gets no row.
      const row = (
        await tx.query<{ slug: string; workspace_slug: string }>(
          'SELECT t.slug, w.slug AS workspace_slug FROM app.teams t JOIN app.workspaces w ON w.id = t.workspace_id WHERE t.id = $1 AND (SELECT app.is_system())',
          [teamId],
        )
      ).rows[0];
      if (!row) throw new MemoryError('unknown_team', 'No such team (or not the platform asking).');
      return makeBank(deps.client(), bankIdFor(row.workspace_slug, row.slug), { source: 'platform', team: row.slug, workspace: row.workspace_slug }, {});
    },
  };
}
