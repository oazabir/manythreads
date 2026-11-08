import { expect } from 'vitest';
import type { RemoteChanges } from '@manythreads/sdk';
import { startFakeSaas, type FakeSaas } from '../../../../tools/fake-saas/src/server.ts';
import { workspaceModule } from '../../../../tools/fake-saas/src/providers/workspace.ts';
import { confluenceModule } from '../../../../tools/fake-saas/src/providers/confluence.ts';
import { dropboxModule } from '../../../../tools/fake-saas/src/providers/dropbox.ts';
import { boxModule } from '../../../../tools/fake-saas/src/providers/box.ts';
import type { AdapterCtx, DocAdapter } from '../src/documents/adapter.ts';
import { DocError, Memo, createDocHttp, type DocHttp } from '../src/documents/http.ts';
import { endpointsFor } from '../src/oauth/providers.ts';
import type { PersonProviderId } from '@manythreads/shared';

// What the document reader tests share: fake-saas with the workspace stand-in (Google, Microsoft, Notion) and the three document stand-ins, the HTTP client on a token the
// stand-in accepts, and a loop that follows a pass the way the sync does. No database is needed: the readers take their token from a function.

export const OWNER = 'omar@kahf.example';
/** A time far in the future, so Notion's "hold the mark back two minutes" never reaches a mark made from a fixture date. */
export const LATER = new Date('2030-01-01T00:00:00.000Z');

export interface Rig {
  saas: FakeSaas;
  env: Record<string, string>;
  /** A reader context for a provider with a token the stand-in accepts. */
  ctx(provider: PersonProviderId, options?: { token?: string; fetchImpl?: Parameters<typeof createDocHttp>[0]['fetchImpl'] }): AdapterCtx & { token: string };
  stop(): Promise<void>;
}

export async function startRig(): Promise<Rig> {
  const saas = await startFakeSaas({
    only: [workspaceModule, confluenceModule, dropboxModule, boxModule],
    seedGrants: [
      { provider: 'google', email: OWNER },
      { provider: 'microsoft', email: OWNER },
      { provider: 'notion', email: OWNER },
    ],
  });
  const env = { ...saas.env(), NODE_ENV: 'test' };
  const grant = (id: 'confluence' | 'dropbox' | 'box'): string => (saas.standIns[id]!.api as { server: { grant(email: string, scopes?: string[]): { accessToken: string } } }).server.grant(OWNER, ['all']).accessToken;
  const tokens: Partial<Record<PersonProviderId, string>> = {
    google: saas.seedTokens('google', OWNER).accessToken,
    microsoft: saas.seedTokens('microsoft', OWNER).accessToken,
    notion: saas.seedTokens('notion', OWNER).accessToken,
    confluence: grant('confluence'),
    dropbox: grant('dropbox'),
    box: grant('box'),
  };
  return {
    saas,
    env,
    ctx(provider, options = {}) {
      const endpoints = endpointsFor(provider, env);
      const token = options.token ?? tokens[provider]!;
      const http = createDocHttp({
        label: provider,
        apiBase: endpoints.apiBase,
        contentBase: endpoints.contentBase,
        token: async () => token,
        fetchImpl: options.fetchImpl,
        headers: provider === 'notion' ? { 'notion-version': '2022-06-28' } : undefined,
      });
      return { http, memo: new Memo(60_000, 1000), prefix: `t-${provider}`, now: () => LATER, token };
    },
    stop: () => saas.stop(),
  };
}

/** Follows a pass to its end the way the sync does; checks that `cursor` is always the resume point while `next` is set. */
export async function drain(adapter: DocAdapter, ctx: AdapterCtx, root: string, cursor: string | null = null): Promise<{ items: RemoteChanges['items']; cursor: string; calls: number }> {
  const items: RemoteChanges['items'] = [];
  let at = cursor;
  for (let calls = 1; calls < 500; calls++) {
    const page = await adapter.listChanges(ctx, { root, cursor: at });
    items.push(...page.items);
    if (page.next === null) return { items, cursor: page.cursor, calls };
    expect(page.next).toBe(page.cursor);
    at = page.next;
  }
  throw new Error('the pass did not end');
}

/** The changed items of a pass, by id and flag, in a stable order. */
export const ids = (items: RemoteChanges['items']): string[] => items.map((i) => `${i.removed ? '-' : ''}${i.remoteId}`).sort();

/** The error a call throws, or null. */
export async function caught(run: () => Promise<unknown>): Promise<DocError | null> {
  try {
    await run();
    return null;
  } catch (err) {
    expect(err).toBeInstanceOf(DocError);
    return err as DocError;
  }
}

export type { DocHttp };
