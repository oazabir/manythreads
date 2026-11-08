import type { DocumentsConnector, PluginContext } from '@manythreads/sdk';
import { NOT_BUILT_MESSAGE } from './not-built.ts';

// Work package D1 (P16-08, decisions D12, D13, D14): the `connector.documents` provider, read only. It lists the folders, spaces, sites or databases a person can pick,
// lists what changed under one since a cursor, fetches one document's bytes (at most 10 MB) and says who may open it at the service. One reader per service lives
// under `documents/`. STUB: every call answers `provider_down` until D1 fills it in; the interface is `DocumentsConnector` in the SDK.
export function registerDocumentsProvider(ctx: PluginContext): void {
  const unbuilt = { ok: false, code: 'provider_down', message: NOT_BUILT_MESSAGE } as const;
  const provider: DocumentsConnector = {
    id: 'connections',
    listRoots: async () => unbuilt,
    listChanges: async () => unbuilt,
    fetch: async () => unbuilt,
    access: async () => unbuilt,
  };
  ctx.providers.register('connector.documents', provider);
}
