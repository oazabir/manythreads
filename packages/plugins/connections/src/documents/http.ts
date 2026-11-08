import { SafeFetchError, safeFetch } from '@manythreads/sdk/safe-fetch';
import type { ConnectorErrorCode, FetchedDocumentKind } from '@manythreads/sdk';
import { CONNECTOR_DOCUMENT_MAX_BYTES } from '@manythreads/shared';
import type { FetchLike } from '../oauth/flow.ts';

// What every document reader shares (PLAN Bundle D, P16-08, WP-D1): one small HTTP client onto a provider's API with the person's token, the error words, the
// resume-state codec, and the file-kind rules. A reader (google-drive.ts, onedrive.ts, ...) never builds an address from anything a provider sent: it passes a path of its
// own on the provider's constant base (or the fake's, outside production), and the one place that follows a provider-sent address is a file download, through the
// SDK's safe fetch (public addresses only, re-vetted on every hop, no token sent).
//
// Nothing here puts a token in an error: the messages are ours, built from the provider's label and a status number, never from the provider's text, a header or an address.

/** A reader's failure, already in the words of the connector door: `code` is what the caller acts on, `message` is fit for a person and a log. */
export class DocError extends Error {
  readonly code: ConnectorErrorCode;
  /** The provider's HTTP status when the failure came from one (0 otherwise); a reader uses it to tell "your resume point is no longer valid" from "down". */
  readonly status: number;
  constructor(code: ConnectorErrorCode, message: string, status = 0) {
    super(message);
    this.name = 'DocError';
    this.code = code;
    this.status = status;
  }
}

export const MAX_DOCUMENT_BYTES = CONNECTOR_DOCUMENT_MAX_BYTES;
/** A JSON answer is at most this large (a page of a space in storage format can be a few megabytes). */
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface DocRequest {
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | boolean | readonly string[] | undefined>;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as an urlencoded form (Box, Dropbox token-style calls). */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  /** Dropbox: the download host rather than the API host. */
  content?: boolean;
  /** The call is about one document: a 403 then means "this person may not open it" (`not_found`), not "the sign-in lacks a permission". */
  doc?: boolean;
}

export interface DocHttp {
  /** The provider's label for messages ("Google Drive"). */
  label: string;
  /** The provider's API base (the fake's outside production). */
  apiBase: string;
  json(path: string, init?: DocRequest): Promise<unknown>;
  /** The answer's bytes, cut at `maxBytes + 1` so the caller can see that it was longer. A redirect to a download address is followed through the safe fetch. */
  bytes(path: string, init?: DocRequest, maxBytes?: number): Promise<{ bytes: Uint8Array; truncated: boolean }>;
  /**
   * A provider-sent link (a Graph `@odata.nextLink`) turned into a path on OUR base: the origin must be the base's own, anything else is refused. Returns the path and
   * query, ready to pass to `json`.
   */
  relative(link: string): string;
}

/** `Dropbox no longer accepts this sign-in ...`: ours, from a status. */
export function statusError(label: string, status: number, what: 'list' | 'document'): DocError {
  if (status === 401) return new DocError('not_connected', `${label} no longer accepts this sign-in. The person has to connect it again.`, status);
  if (status === 403) {
    return what === 'document'
      ? new DocError('not_found', `${label} does not let this person open that.`, status)
      : new DocError('scope_missing', `${label} does not allow that with the permissions the person gave.`, status);
  }
  // 409 is Dropbox's "that path / that point does not exist" and Box's "conflict": for a reader it is a missing thing (`status` is kept for a reader that knows better)
  if (status === 404 || status === 409) return new DocError('not_found', `${label} has nothing there (it may be gone, or not visible to this person).`, status);
  if (status === 429) return new DocError('provider_down', `${label} asked us to slow down.`, status);
  if (status >= 500) return new DocError('provider_down', `${label} is not available right now.`, status);
  return new DocError('provider_down', `${label} refused the request (${String(status)}).`, status);
}

export interface DocHttpDeps {
  label: string;
  apiBase: string;
  contentBase?: string | undefined;
  /** The access token; `true` asks for a freshly renewed one (the provider just said 401). */
  token(force: boolean): Promise<string>;
  fetchImpl?: FetchLike | undefined;
  /** Headers every call carries (Notion's version). */
  headers?: Record<string, string> | undefined;
}

export function createDocHttp(deps: DocHttpDeps): DocHttp {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const api = new URL(deps.apiBase);

  const send = async (token: string, path: string, init: DocRequest): Promise<Response> => {
    // a path is ours: it begins with one slash and carries no scheme, so a call can only go to the provider's own base
    if (!path.startsWith('/') || path.startsWith('//')) throw new DocError('provider_down', 'That request is not one a reader may make.');
    const url = new URL(`${init.content ? (deps.contentBase ?? deps.apiBase) : deps.apiBase}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') url.searchParams.set(k, String(v));
      else for (const one of v) url.searchParams.append(k, one);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...deps.headers, ...init.headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.body);
    } else if (init.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    try {
      return await fetchImpl(url.toString(), { method: init.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    } catch {
      throw new DocError('provider_down', `${deps.label} did not answer.`);
    }
  };

  /** One call with a good token; a 401 renews the token once and tries again. */
  const call = async (path: string, init: DocRequest): Promise<Response> => {
    let res = await send(await deps.token(false), path, init);
    if (res.status === 401) {
      await res.body?.cancel();
      res = await send(await deps.token(true), path, init);
    }
    return res;
  };

  const readCapped = async (res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> => {
    if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > max) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
    return { bytes: new Uint8Array(Buffer.concat(chunks).subarray(0, max)), truncated };
  };

  return {
    label: deps.label,
    apiBase: deps.apiBase,

    async json(path, init = {}) {
      const res = await call(path, init);
      if (!res.ok) {
        await res.body?.cancel();
        throw statusError(deps.label, res.status, init.doc ? 'document' : 'list');
      }
      if (res.status === 204) {
        await res.body?.cancel();
        return null;
      }
      const got = await readCapped(res, MAX_JSON_BYTES);
      if (got.truncated) throw new DocError('provider_down', `${deps.label} answered with more than can be read.`);
      try {
        return JSON.parse(Buffer.from(got.bytes).toString('utf8')) as unknown;
      } catch {
        throw new DocError('provider_down', `${deps.label} answered with something that could not be read.`);
      }
    },

    async bytes(path, init = {}, maxBytes = MAX_DOCUMENT_BYTES) {
      const res = await call(path, { ...init, headers: { accept: '*/*', ...init.headers } });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        await res.body?.cancel();
        if (!location) throw new DocError('provider_down', `${deps.label} did not say where the file is.`);
        try {
          // no token goes to the address a provider named: it is a short-lived download link, and the safe fetch refuses a private or loopback address on every hop
          const got = await safeFetch(location, { maxBytes: maxBytes + 1, timeoutMs: TIMEOUT_MS, maxRedirects: 2, overflow: 'truncate', accept: '*/*' });
          return { bytes: new Uint8Array(got.body.subarray(0, maxBytes)), truncated: got.body.length > maxBytes || got.truncated };
        } catch (err) {
          throw new DocError('provider_down', err instanceof SafeFetchError ? `${deps.label} sent the file to an address that cannot be used.` : `${deps.label}'s file could not be downloaded.`);
        }
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw statusError(deps.label, res.status, 'document');
      }
      return readCapped(res, maxBytes);
    },

    relative(link) {
      let url: URL;
      try {
        url = new URL(link);
      } catch {
        throw new DocError('provider_down', `${deps.label} sent an address that cannot be used.`);
      }
      if (url.origin !== api.origin) throw new DocError('provider_down', `${deps.label} sent an address that is not its own.`);
      const prefix = api.pathname.replace(/\/+$/, '');
      const path = url.pathname.startsWith(`${prefix}/`) || url.pathname === prefix ? url.pathname.slice(prefix.length) : null;
      if (path === null || !path.startsWith('/')) throw new DocError('provider_down', `${deps.label} sent an address that is not its own.`);
      return `${path}${url.search}`;
    },
  };
}

// ---- resume state ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * A reader's resume point as one opaque string (`v1.<base64url of JSON>`). It holds only ids, tokens of the provider's own change feed and timestamps: nothing secret.
 * A string that does not decode, or does not pass the reader's check, is "no cursor": the pass starts over from a full listing (the unchanged documents are skipped by
 * their version).
 */
export const encodeState = (state: object): string => `v1.${Buffer.from(JSON.stringify(state), 'utf8').toString('base64url')}`;

export function decodeState<T extends { k: string }>(raw: string | null | undefined, guard: (v: Record<string, unknown>) => v is T & Record<string, unknown>): T | null {
  if (typeof raw !== 'string' || !raw.startsWith('v1.') || raw.length > 64 * 1024) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw.slice(3), 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
    const rec = v as Record<string, unknown>;
    return typeof rec['k'] === 'string' && guard(rec) ? (rec as T) : null;
  } catch {
    return null;
  }
}

export const isStr = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
export const isStrOrNull = (v: unknown, max = 4096): v is string | null => v === null || isStr(v, max);

/** The most folders a walk may hold waiting (the resume state stays small). */
export const MAX_PENDING_FOLDERS = 300;

// ---- small readers of a provider's JSON ---------------------------------------------------------------------------------------------------------------------

export const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const str = (v: unknown, max = 1000): string | null => (typeof v === 'string' && v !== '' ? v.slice(0, max) : null);
export const enc = encodeURIComponent;

/** A name cut to what a source row shows. */
// eslint-disable-next-line no-control-regex -- control characters in a provider-sent name are replaced on purpose
export const nameOf = (v: unknown, fallback: string): string => (str(v, 200) ?? fallback).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || fallback;

// ---- what kind of file it is ---------------------------------------------------------------------------------------------------------------------------------

const BY_EXTENSION: Readonly<Record<string, FetchedDocumentKind>> = {
  md: 'md',
  markdown: 'md',
  txt: 'text',
  text: 'text',
  log: 'text',
  csv: 'csv',
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
};
const BY_MIME: Readonly<Record<string, FetchedDocumentKind>> = {
  'text/markdown': 'md',
  'text/x-markdown': 'md',
  'text/plain': 'text',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

/** The kind of a file by its name's extension, else by its media type; null for what the knowledge reader does not take (pictures, archives, code). */
export function kindOfFile(name: string, mime?: string | null): FetchedDocumentKind | null {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot >= name.length - 6) {
    const kind = BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
    if (kind) return kind;
  }
  if (mime) {
    const kind = BY_MIME[mime.split(';')[0]!.trim().toLowerCase()];
    if (kind) return kind;
  }
  return null;
}

/** Binary kinds cannot be cut: a half of a PDF is not a document. */
export const isBinaryKind = (kind: FetchedDocumentKind): boolean => kind === 'pdf' || kind === 'docx' || kind === 'xlsx' || kind === 'pptx';

/** The fetched bytes of a file of `kind`: text kinds are cut at the cap, a binary kind longer than the cap is refused (not cut). */
export function capped(label: string, got: { bytes: Uint8Array; truncated: boolean }, kind: FetchedDocumentKind): { bytes: Uint8Array; kind: FetchedDocumentKind } {
  if (got.truncated && isBinaryKind(kind)) throw new DocError('not_found', `That file is larger than ${String(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB, which ${label} documents are not read beyond.`);
  return { bytes: got.bytes, kind };
}

export const emailDomain = (email: string): string | null => {
  const at = email.lastIndexOf('@');
  return at > 0 && at < email.length - 1 ? email.slice(at + 1).toLowerCase() : null;
};

/** What an access answer says when it could not be read, or names a group: "not everyone" (the team rule fails closed). */
export const unreadableAccess = (): { anyone: boolean; domains: string[]; users: string[]; groups: boolean } => ({ anyone: false, domains: [], users: [], groups: true });

/** An access question that failed: a dead sign-in or a service that is down propagates (the caller must not index on a guess); "not allowed to see", "gone" and "unreadable" are "not everyone". */
export function unreadableOrThrow(err: unknown): ReturnType<typeof unreadableAccess> {
  if (err instanceof DocError && (err.code === 'not_connected' || err.code === 'provider_down')) throw err;
  return unreadableAccess();
}

/** Folds the pieces of an access answer into the shape of the door: lower-cased and without repeats, within the schema's bounds (more than the bound is "a group"). */
export function accessAnswer(parts: { anyone: boolean; domains: Iterable<string>; users: Iterable<string>; groups: boolean }): { anyone: boolean; domains: string[]; users: string[]; groups: boolean } {
  const domains = [...new Set([...parts.domains].map((d) => d.trim().toLowerCase()).filter((d) => d !== ''))];
  const users = [...new Set([...parts.users].map((u) => u.trim().toLowerCase()).filter((u) => u !== ''))];
  const over = domains.length > 100 || users.length > 500;
  return { anyone: parts.anyone, domains: domains.slice(0, 100), users: users.slice(0, 500), groups: parts.groups || over };
}

/** A short-lived cache for lookups a pass repeats (a folder's parent, a space's permissions): at most `size` entries, each good for `ttlMs`. */
export class Memo {
  private readonly map = new Map<string, { value: unknown; until: number }>();
  constructor(
    private readonly ttlMs: number,
    private readonly size: number,
    private readonly now: () => number = Date.now,
  ) {}
  async get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && hit.until > this.now()) return hit.value as T;
    const value = await load();
    if (this.map.size >= this.size) this.map.delete(this.map.keys().next().value!);
    this.map.set(key, { value, until: this.now() + this.ttlMs });
    return value;
  }
}
