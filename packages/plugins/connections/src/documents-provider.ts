import type { ConnectorCaller, ConnectorErrorCode, ConnectorResult, DocumentsConnector, PluginContext } from '@manythreads/sdk';
import { CONNECTOR_SOURCE_CONNECTOR, type KnowledgeConnectorProvider, type PersonProviderId } from '@manythreads/shared';
import { confluence } from './documents/confluence.ts';
import { dropbox } from './documents/dropbox.ts';
import { box } from './documents/box.ts';
import { googleDrive } from './documents/google-drive.ts';
import { DocError, Memo, createDocHttp } from './documents/http.ts';
import { notion } from './documents/notion.ts';
import { oneDrive } from './documents/onedrive.ts';
import { sharePoint } from './documents/sharepoint.ts';
import type { AdapterCtx, DocAdapter } from './documents/adapter.ts';
import { createReconnectNotifier } from './oauth/notice.ts';
import { endpointsFor, PROVIDERS, serviceDef } from './oauth/providers.ts';
import { accessTokenFor, ConnectionProblem, type OAuthDeps } from './oauth/store.ts';
import { isUsable } from './rows.ts';

// Work package D1 (P16-08, decisions D12, D13, D14): the `connector.documents` provider, read only. It lists the folders, spaces, sites or databases a person can pick, lists what
// changed under one since a cursor, fetches one document's bytes (at most 10 MB) and says who may open it at the service. One reader per service lives under `documents/`;
// this file finds the person's own grant, builds the HTTP client that rides on it, and turns a failure into the door's answer.
//
//  * The `tx` that callers pass is NOT used (as in calendar-provider.ts): a call opens its own short system transaction to find the grant and closes it before the service is
//    asked, so a detached sync job may pass any handle and no provider call ever waits inside a caller's transaction.
//  * Every call names a person: there is no workspace-wide token behind it. A provider whose connection is missing, off, expired or waiting to be reconnected answers
//    `not_connected`; one connected without the permission this needs answers `scope_missing`.
//  * Cursors: `cursor` and `next` are the same kind of string (opaque, made by the reader). The `cursor` of an answer is ALWAYS a valid input to the next call, and while
//    `next` is not null it is equal to `cursor`; a caller that stops part-way stores `cursor`. A cursor a reader cannot read means "from the start".
//  * Messages are ours: they never carry a token, an address, a header or the service's own words.

const ADAPTERS: Readonly<Record<KnowledgeConnectorProvider, DocAdapter>> = {
  google_drive: googleDrive,
  onedrive: oneDrive,
  sharepoint: sharePoint,
  notion,
  confluence,
  dropbox,
  box,
};

/** The service of the person's connection a reader needs, by the name of `catalog.ts`. */
const SERVICE: Readonly<Record<KnowledgeConnectorProvider, string>> = {
  google_drive: 'drive',
  onedrive: 'onedrive',
  sharepoint: 'sharepoint',
  notion: 'notion',
  confluence: 'pages',
  dropbox: 'files',
  box: 'files',
};

/** Services whose permission the provider does not report as a scope we can compare (Notion and Box fix what a grant may do on the app, not in the request). */
const SCOPE_FREE: ReadonlySet<KnowledgeConnectorProvider> = new Set(['notion', 'box']);

const fail = <T>(code: ConnectorErrorCode, message: string): ConnectorResult<T> => ({ ok: false, code, message });

/** The longest id, cursor or page token a caller may pass. */
const MAX_INPUT = 64 * 1024;
const tooLong = (...values: Array<string | null | undefined>): boolean => values.some((v) => typeof v === 'string' && v.length > MAX_INPUT);

function problemOf<T>(err: unknown): ConnectorResult<T> {
  if (err instanceof DocError) return fail(err.code, err.message);
  if (err instanceof ConnectionProblem) return fail(err.code === 'needs_reconnect' || err.code === 'not_connected' ? 'not_connected' : 'provider_down', err.message);
  // anything else (a surprise in an answer we did not expect): a sentence of ours, nothing of what was thrown
  return fail('provider_down', 'The documents could not be read right now. Try again in a minute.');
}

export interface DocumentsConnectorOptions {
  /** Tests only: readers to use instead of the shipped ones. */
  adapters?: Partial<Record<KnowledgeConnectorProvider, DocAdapter>>;
}

export function createDocumentsConnector(deps: OAuthDeps, options: DocumentsConnectorOptions = {}): DocumentsConnector {
  const memo = new Memo(60_000, 2000, () => deps.now().getTime());

  /** The person's usable sign-in for the connection a provider rides on, with the scopes it holds. */
  const grantOf = (workspaceId: string, personId: string, slug: string) =>
    deps.db.system(
      async (tx) => {
        const rows = await tx.query<{ id: string; status: 'enabled' | 'disabled'; has_credentials: boolean; expired: boolean; scopes: string[]; state: string }>(
          `SELECT c.id, c.status, c.has_credentials, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS expired, o.scopes, o.state
             FROM app.connections c
             JOIN app.connection_oauth o ON o.connection_id = c.id
             JOIN app.actors a ON a.id = c.owner_id AND a.kind = 'person'
            WHERE c.workspace_id = $1::uuid AND c.scope = 'person' AND a.ref_id = $2::uuid AND c.slug = $3
            LIMIT 1`,
          [workspaceId, personId, slug],
        );
        const row = rows.rows[0];
        return row && isUsable(row) && row.state === 'ok' ? { id: row.id, scopes: row.scopes } : null;
      },
      { workspaceId },
    );

  async function run<T>(
    caller: ConnectorCaller & { provider: KnowledgeConnectorProvider },
    fn: (adapter: DocAdapter, ctx: AdapterCtx) => Promise<T>,
  ): Promise<ConnectorResult<T>> {
    try {
      const adapter = options.adapters?.[caller.provider] ?? ADAPTERS[caller.provider];
      const slug = CONNECTOR_SOURCE_CONNECTOR[caller.provider] as PersonProviderId | undefined;
      if (!adapter || !slug) return fail('not_connected', 'That service is not one documents can be read from.');
      const def = PROVIDERS[slug];
      const grant = await grantOf(caller.workspaceId, caller.personId, slug);
      if (!grant) return fail('not_connected', `${def.label} is not connected. Connect it first.`);
      if (!SCOPE_FREE.has(caller.provider)) {
        const service = serviceDef(def, SERVICE[caller.provider]!);
        if (!service || !service.scopes.every((s) => grant.scopes.includes(s))) {
          return fail('scope_missing', `${def.label} was connected without permission to read documents. Add that permission to your connection.`);
        }
      }
      const endpoints = endpointsFor(slug, deps.env);
      const connection = { id: grant.id, workspaceId: caller.workspaceId, provider: slug };
      const http = createDocHttp({
        label: def.label,
        apiBase: endpoints.apiBase,
        contentBase: endpoints.contentBase,
        token: (force) => accessTokenFor(deps, connection, force ? { force: true } : {}),
        fetchImpl: deps.fetchImpl,
        headers: slug === 'notion' ? { 'notion-version': '2022-06-28' } : undefined,
      });
      return { ok: true, value: await fn(adapter, { http, memo, prefix: grant.id, now: () => deps.now() }) };
    } catch (err) {
      return problemOf<T>(err);
    }
  }

  return {
    id: 'connections',

    listRoots: (_tx, caller) => run(caller, (a, ctx) => a.listRoots(ctx)),

    listChanges(_tx, caller) {
      if (tooLong(caller.root, caller.cursor, caller.pageToken)) return Promise.resolve(fail('not_found', 'That folder is not one this reader can open.'));
      // a page token is the `next` of an earlier answer: it carries the pass on from where it stopped, and wins over the stored cursor
      return run(caller, (a, ctx) => a.listChanges(ctx, { root: caller.root, cursor: caller.pageToken ?? caller.cursor }));
    },

    fetch(_tx, caller) {
      if (tooLong(caller.remoteId)) return Promise.resolve(fail('not_found', 'That document is not one this reader can open.'));
      return run(caller, (a, ctx) => a.fetch(ctx, caller.remoteId));
    },

    access(_tx, caller) {
      if (tooLong(caller.remoteId)) return Promise.resolve(fail('not_found', 'That document is not one this reader can open.'));
      return run(caller, (a, ctx) => a.access(ctx, caller.remoteId));
    },
  };
}

export function registerDocumentsProvider(ctx: PluginContext): void {
  const deps: OAuthDeps = { db: ctx.db, secrets: ctx.secrets, now: () => ctx.runtime.now(), env: process.env, onNeedsReconnect: createReconnectNotifier(ctx) };
  ctx.providers.register('connector.documents', createDocumentsConnector(deps));
}
