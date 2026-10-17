import type { PluginTx } from '@manythreads/sdk';
import { appendLine, latestLine } from '../rows.ts';
import type { BankOf, DrainStats, Planned } from './plan.ts';

// B: say why something was not retained.
export async function runWithholdPhase(tx: PluginTx, planned: Planned[], stats: DrainStats, bankOf: BankOf): Promise<void> {
  for (const p of planned) {
    if (p.hold !== null || p.decision.withhold === null) continue;
    const bank = await bankOf(p.teamId);
    if (bank === null) {
      p.hold = { kind: 'team_gone' };
      continue;
    }
    await appendLine(tx, {
      workspaceId: p.workspaceId,
      teamId: p.teamId,
      bank: bank.id,
      sourceKind: p.row.source_kind,
      sourceId: p.row.source_id,
      channelId: p.channelId,
      outcome: 'withheld',
      reason: p.decision.withhold.reason,
      runId: p.runId,
      scopes: p.scopes,
      actorId: p.actorId,
      link: p.link,
    });
    stats.withheld += 1;
  }
  // ... and one line for each reply that was left out of a thread's document, once per reason (what was withheld is on the record, per message).
  for (const p of planned) {
    if (p.hold !== null || p.excluded.length === 0) continue;
    const bank = await bankOf(p.teamId);
    if (bank === null) continue;
    for (const e of p.excluded) {
      // Not for a message the bank holds a document for: that document is taken out by the message's own row (it may be failing right now),
      // and a `withheld` line written beside it would say "nothing is held" about something that is.
      const known = await latestLine(tx, 'message', e.messageId);
      if (known !== null && known.outcome === 'retained') continue;
      if (known !== null && known.outcome === 'withheld' && known.reason === e.reason) continue;
      await appendLine(tx, {
        workspaceId: p.workspaceId,
        teamId: p.teamId,
        bank: bank.id,
        sourceKind: 'message',
        sourceId: e.messageId,
        channelId: p.channelId,
        outcome: 'withheld',
        reason: e.reason,
        actorId: e.actorId,
        link: p.link,
      });
      stats.withheld += 1;
    }
  }
}
