import type { PluginTx } from '@manythreads/sdk';
import { resolveApproval } from './sources/approval.ts';
import { resolveMessage, resolveThread } from './sources/message-thread.ts';
import { resolvePage } from './sources/page.ts';
import { resolveRun } from './sources/run.ts';
import { skip, type Resolution } from './sources/common.ts';

// Dispatcher: the resolvers live in `sources/` by kind; this module keeps the
// original import path (`./sources.ts`) stable for existing callers.
export type { Provenance, Resolution } from './sources/common.ts';
export { resolveApproval } from './sources/approval.ts';
export { resolveMessage, resolveThread } from './sources/message-thread.ts';
export { pageSourceId, resolvePage } from './sources/page.ts';
export { resolveRun } from './sources/run.ts';

export async function resolve(tx: PluginTx, kind: string, sourceId: string): Promise<Resolution> {
  switch (kind) {
    case 'message':
      return resolveMessage(tx, sourceId);
    case 'thread':
      return resolveThread(tx, sourceId);
    case 'run':
      return resolveRun(tx, sourceId);
    case 'approval':
      return resolveApproval(tx, sourceId);
    case 'page':
      return resolvePage(tx, sourceId);
    default:
      return skip('unknown_kind');
  }
}
