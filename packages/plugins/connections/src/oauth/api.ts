import { SafeFetchError, safeFetch } from '@manythreads/sdk/safe-fetch';
import type { PersonProviderId } from '@manythreads/shared';
import { readJson, type FetchLike } from './flow.ts';
import { endpointsFor, PROVIDERS } from './providers.ts';
import { accessTokenFor, type OAuthDeps } from './store.ts';

// One door to a provider's API for the tools of a person's connection (PLAN P8-02). It adds the person's access token (renewed first when it is about to stop working,
// and once more when the provider answers 401), keeps every call to the provider's own address (a tool passes a path, never an address), and bounds time and size.
// What comes back is outside text: the tools hand it to the model as data.

const TIMEOUT_MS = 15_000;
/** The most bytes of one answer read; a longer text is cut and says so, a longer JSON document is refused. */
export const MAX_API_BYTES = 1024 * 1024;

/** The provider answered with a status the tool cannot use. The message is ours (never the provider's text), so it can go to a model as it is. */
export class ProviderError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export interface ApiInit {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

/** What a tool calls. `connection` is already known to be the asker's own and usable. */
export interface ProviderApi {
  json(path: string, init?: ApiInit): Promise<unknown>;
  /** The answer as text, cut at the size cap (`truncated`). A provider that answers a redirect to a download address (OneDrive) is followed through the SDK's safe fetch. */
  text(path: string, init?: ApiInit): Promise<{ text: string; truncated: boolean }>;
  now(): Date;
}

function explain(provider: PersonProviderId, status: number): string {
  const label = PROVIDERS[provider].label;
  if (status === 401) return `${label} no longer accepts this sign-in. The person has to connect it again.`;
  if (status === 403) return `${label} does not allow that with the permissions the person gave (they may need to connect that service, or the item is not shared with them).`;
  if (status === 404) return `${label} has nothing there (it may not exist, or may not be visible to this person).`;
  if (status === 429) return `${label} asked us to slow down. Try again in a minute.`;
  if (status >= 500) return `${label} is not available right now.`;
  return `${label} refused the request (${status}).`;
}

export function createProviderApi(deps: OAuthDeps, connection: { id: string; workspaceId: string; provider: PersonProviderId }): ProviderApi {
  const endpoints = endpointsFor(connection.provider, deps.env);
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  const send = async (token: string, path: string, init: ApiInit): Promise<Response> => {
    // a path is ours (a tool's template with encoded values): it must begin with a slash and carry no scheme, so the call can only go to the provider's own address
    if (!path.startsWith('/') || path.startsWith('//')) throw new ProviderError(400, 'That request is not one a tool may make.');
    const url = new URL(`${endpoints.apiBase}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...(connection.provider === 'notion' ? { 'notion-version': '2022-06-28' } : {}), ...init.headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    try {
      return await fetchImpl(url.toString(), { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    } catch {
      throw new ProviderError(503, `${PROVIDERS[connection.provider].label} did not answer.`);
    }
  };

  /** One call with a good token; a 401 renews the token once and tries again. */
  const call = async (path: string, init: ApiInit): Promise<Response> => {
    let res = await send(await accessTokenFor(deps, connection), path, init);
    if (res.status === 401) {
      await res.body?.cancel();
      res = await send(await accessTokenFor(deps, connection, { force: true }), path, init);
    }
    return res;
  };

  return {
    now: () => deps.now(),

    async json(path, init = {}) {
      const res = await call(path, init);
      if (!res.ok) {
        await res.body?.cancel();
        throw new ProviderError(res.status, explain(connection.provider, res.status));
      }
      try {
        return await readJson(res);
      } catch {
        throw new ProviderError(502, `${PROVIDERS[connection.provider].label} answered with more than can be read.`);
      }
    },

    async text(path, init = {}) {
      const headers = { accept: '*/*', ...init.headers };
      const res = await call(path, { ...init, headers });
      // a download that lives at another address (OneDrive): follow it once, without the token, through the safe fetch (public addresses only)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new ProviderError(502, 'The download address is missing.');
        try {
          const got = await safeFetch(location, { maxBytes: MAX_API_BYTES, timeoutMs: TIMEOUT_MS, maxRedirects: 2, overflow: 'truncate', accept: '*/*' });
          return { text: got.body.toString('utf8'), truncated: got.truncated };
        } catch (err) {
          throw new ProviderError(502, err instanceof SafeFetchError ? 'The file could not be downloaded.' : 'The file could not be read.');
        }
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new ProviderError(res.status, explain(connection.provider, res.status));
      }
      if (!res.body) return { text: '', truncated: false };
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let truncated = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        chunks.push(value);
        if (size > MAX_API_BYTES) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      return { text: Buffer.concat(chunks).subarray(0, MAX_API_BYTES).toString('utf8'), truncated };
    },
  };
}

/**
 * Whose account a fresh sign-in is, in a few words for the screen (an address, or Notion's workspace name). Asked once, with the token that was just handed over and
 * before anything is saved; a failure just means the screen has no label.
 */
export async function accountLabelFor(deps: Pick<OAuthDeps, 'env' | 'fetchImpl'>, provider: PersonProviderId, accessToken: string, hint: string | null): Promise<string | null> {
  if (provider === 'notion') return hint;
  const endpoints = endpointsFor(provider, deps.env);
  const path = provider === 'google' ? '/oauth2/v3/userinfo' : '/me?$select=mail,userPrincipalName';
  try {
    const res = await (deps.fetchImpl ?? ((url, init) => fetch(url, init)))(`${endpoints.apiBase}${path}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'manual',
    });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const doc = (await readJson(res)) as Record<string, unknown> | null;
    const label = provider === 'google' ? doc?.['email'] : (doc?.['mail'] ?? doc?.['userPrincipalName']);
    return typeof label === 'string' && label !== '' ? label.slice(0, 200) : null;
  } catch {
    return null;
  }
}
