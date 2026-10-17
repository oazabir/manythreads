import { MemoryError, type PluginTx } from '@manythreads/sdk';
import { feedTuning } from '../config.ts';
import { RETAIN_CHUNK } from '../constants.ts';
import { appendLine } from '../rows.ts';
import { byTeam, errorText, type BankOf, type DrainStats, type FeedRuntime, type Planned } from './plan.ts';

/** The engine's answers that mean "this payload is wrong" (not "I am down" or "you may not"): worth trying the items singly. */
const PAYLOAD_STATUSES = new Set([400, 413, 422]);

// C: put in what changed, in chunks, asynchronously (the engine distils facts in the background; the call returns when it has the text).
export async function runRetainPhase(tx: PluginTx, planned: Planned[], stats: DrainStats, bankOf: BankOf, rt: FeedRuntime): Promise<void> {
  for (const [teamId, list] of byTeam(planned.filter((p) => p.hold === null && p.decision.retain !== null))) {
    const bank = await bankOf(teamId);
    if (bank === null) {
      for (const p of list) p.hold = { kind: 'team_gone' };
      continue;
    }
    const allow = rt.retainWindow.remaining(teamId);
    const now = list.slice(0, allow);
    for (const p of list.slice(allow)) p.hold = { kind: 'throttled', delayMs: Math.max(feedTuning().deferMs, rt.retainWindow.retryAfterMs(teamId)) };
    // One engine call per chunk. A 400, 413 or 422 says something in the chunk is wrong, not which: then the items go one at a time, so one
    // item the engine will not take cannot hold back the other twenty-four (a 5xx or no answer fails the chunk: the engine is down for all).
    const retainChunk = async (items: Planned[]): Promise<void> => {
      try {
        await bank.retain(
          items.map((p) => {
            const r = p.decision.retain!;
            return {
              content: r.item.content,
              context: r.item.context,
              timestamp: r.item.timestamp,
              tags: r.item.tags,
              documentId: r.documentId,
              metadata: r.item.metadata,
            };
          }),
          { async: true },
        );
        rt.retainWindow.spend(teamId, items.length);
        for (const p of items) {
          const r = p.decision.retain!;
          await appendLine(tx, {
            workspaceId: p.workspaceId,
            teamId,
            bank: bank.id,
            sourceKind: p.row.source_kind,
            sourceId: p.row.source_id,
            channelId: p.channelId,
            documentId: r.documentId,
            contentHash: r.hash,
            outcome: 'retained',
            runId: p.runId,
            scopes: p.scopes,
            actorId: p.actorId,
            link: p.link,
          });
          stats.retained += 1;
        }
      } catch (err) {
        if (items.length > 1 && err instanceof MemoryError && err.status !== null && PAYLOAD_STATUSES.has(err.status)) {
          for (const one of items) await retainChunk([one]);
          return;
        }
        for (const p of items) p.hold = { kind: 'failed', error: errorText(err), phase: 'retain' };
      }
    };
    for (let i = 0; i < now.length; i += RETAIN_CHUNK) await retainChunk(now.slice(i, i + RETAIN_CHUNK));
  }
}
