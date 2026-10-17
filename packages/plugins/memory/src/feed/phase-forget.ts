import type { PluginTx } from '@manythreads/sdk';
import { feedTuning } from '../config.ts';
import { appendLine } from '../rows.ts';
import { byTeam, errorText, type BankOf, type DrainStats, type FeedRuntime, type Planned } from './plan.ts';

// A: take out what must go (a deleted or edited source, a withheld one): before anything is put in, so an edit that was a correction never
// leaves the old text beside the new.
export async function runForgetPhase(tx: PluginTx, planned: Planned[], stats: DrainStats, bankOf: BankOf, rt: FeedRuntime): Promise<void> {
  for (const [teamId, list] of byTeam(planned.filter((p) => p.decision.forget !== null))) {
    const bank = await bankOf(teamId);
    if (bank === null) {
      for (const p of list) p.hold = { kind: 'team_gone' };
      continue;
    }
    const allow = rt.forgetWindow.remaining(teamId);
    const now = list.slice(0, allow);
    for (const p of list.slice(allow)) p.hold = { kind: 'throttled', delayMs: Math.max(feedTuning().deferMs, rt.forgetWindow.retryAfterMs(teamId)) };
    if (now.length === 0) continue;
    try {
      await bank.forget(now.map((p) => p.decision.forget!.documentId));
      rt.forgetWindow.spend(teamId, now.length);
      for (const p of now) {
        await appendLine(tx, {
          workspaceId: p.workspaceId,
          teamId,
          bank: bank.id,
          sourceKind: p.row.source_kind,
          sourceId: p.row.source_id,
          channelId: p.last?.channel_id ?? p.channelId,
          documentId: p.decision.forget!.documentId,
          outcome: 'forgotten',
          reason: p.decision.forget!.reason,
          runId: p.runId,
          scopes: p.scopes,
          actorId: p.actorId,
          link: p.link,
        });
        stats.forgotten += 1;
      }
    } catch (err) {
      for (const p of now) p.hold = { kind: 'failed', error: errorText(err), phase: 'forget' };
    }
  }
}
