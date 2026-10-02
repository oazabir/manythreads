import { ErrorEnvelope, type ApiRoute, type ApiSchemas, type ErrorCode } from '@manythreads/shared';

/** Typed API client (PLAN Appendix B.3): parse the request, send, map errors, parse the response. */

export type ApiErrorCode = ErrorCode | 'network' | 'bad_response';

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly path: ReadonlyArray<string | number> | undefined;

  constructor(init: { code: ApiErrorCode; message: string; status: number; path?: ReadonlyArray<string | number> }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.path = init.path;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;

export type TransportRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  credentials: 'include';
};
/** `body` is the parsed JSON (undefined for an empty body, the raw text when it was not JSON). */
export type TransportResponse = { status: number; body: unknown };
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export const fetchTransport: Transport = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    credentials: req.credentials,
  });
  const text = await res.text();
  if (text === '') return { status: res.status, body: undefined };
  try {
    return { status: res.status, body: JSON.parse(text) as unknown };
  } catch {
    return { status: res.status, body: text };
  }
};

export const CSRF_COOKIE = 'manythreads_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function readCookie(name: string, cookieString: string | undefined): string | undefined {
  if (!cookieString) return undefined;
  for (const part of cookieString.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const raw = part.slice(i + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}

const browserCookies = (): string | undefined => (typeof document === 'undefined' ? undefined : document.cookie);

/** Replace `:name` segments with encoded params; a missing param is a programming error. */
export function buildPath(path: string, params: Record<string, string> | undefined): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = params?.[name];
    if (v === undefined) throw new Error(`Missing path param :${name} for ${path}`);
    return encodeURIComponent(v);
  });
}

function toQuery(body: unknown): string {
  if (body === null || typeof body !== 'object') return '';
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}

// ---- session-expired event ------------------------------------------------------------------------
type Listener = () => void;
const expiredListeners = new Set<Listener>();
/** Subscribe to "a call returned 401". The app uses it to go to /sign-in?return=<path>. */
export function onSessionExpired(listener: Listener): () => void {
  expiredListeners.add(listener);
  return () => expiredListeners.delete(listener);
}
export function emitSessionExpired(): void {
  for (const l of [...expiredListeners]) l();
}

// ---- client ---------------------------------------------------------------------------------------
export type CallOptions = {
  /** Do not treat a 401 as "session expired" (sign-in and session probes). */
  noSessionExpiry?: boolean;
};

export type ApiClientConfig = {
  transport: Transport;
  /** Cookie string to read the CSRF cookie from; defaults to `document.cookie`. */
  cookies?: () => string | undefined;
  onSessionExpired?: () => void;
};

export type ApiClient = {
  call<Req, Res>(
    route: ApiRoute,
    schemas: ApiSchemas<Req, Res>,
    body?: Req,
    params?: Record<string, string>,
    options?: CallOptions,
  ): Promise<Res>;
};

export function createApiClient(config: ApiClientConfig): ApiClient {
  const cookies = config.cookies ?? browserCookies;
  const expired = config.onSessionExpired ?? emitSessionExpired;

  async function call<Req, Res>(
    route: ApiRoute,
    schemas: ApiSchemas<Req, Res>,
    body?: Req,
    params?: Record<string, string>,
    options: CallOptions = {},
  ): Promise<Res> {
    // 1. fail early on the client: parse the request body against the shared schema
    let payload: unknown = body;
    if (schemas.request) {
      const parsed = schemas.request.safeParse(body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new ApiError({
          code: 'validation_failed',
          status: 0,
          message: issue?.message ?? 'Invalid request',
          path: issue?.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
        });
      }
      payload = parsed.data;
    }

    const method = route.method;
    const headers: Record<string, string> = { accept: 'application/json' };
    let url = buildPath(route.path, params);
    let reqBody: string | undefined;
    if (payload !== undefined) {
      if (method === 'GET') url += toQuery(payload);
      else {
        headers['content-type'] = 'application/json';
        reqBody = JSON.stringify(payload);
      }
    }
    if (!SAFE_METHODS.has(method)) {
      const csrf = readCookie(CSRF_COOKIE, cookies());
      if (csrf) headers[CSRF_HEADER] = csrf;
    }

    let res: TransportResponse;
    try {
      res = await config.transport({ method, url, headers, body: reqBody, credentials: 'include' });
    } catch (e) {
      throw new ApiError({ code: 'network', status: 0, message: e instanceof Error ? e.message : 'Network error' });
    }

    if (res.status < 200 || res.status >= 300) {
      const env = ErrorEnvelope.safeParse(res.body);
      const error = new ApiError(
        env.success
          ? { code: env.data.error.code, message: env.data.error.message, status: res.status, path: env.data.error.path }
          : { code: res.status === 401 ? 'unauthenticated' : 'internal', message: `Request failed (${res.status})`, status: res.status },
      );
      if (res.status === 401 && !options.noSessionExpiry) expired();
      throw error;
    }

    // 2. parse the response against the shared schema
    const out = schemas.response.safeParse(res.body);
    if (!out.success) {
      throw new ApiError({
        code: 'bad_response',
        status: res.status,
        message: 'The server sent a response this app does not understand.',
        path: out.error.issues[0]?.path.map((p) => (typeof p === 'symbol' ? String(p) : p)),
      });
    }
    return out.data;
  }

  return { call };
}

// ---- default singleton ------------------------------------------------------------------------------
let current: ApiClient = createApiClient({ transport: fetchTransport });

/** Swap the transport (mock mode, tests). */
export function setTransport(transport: Transport): void {
  current = createApiClient({ transport });
}

export const call: ApiClient['call'] = (route, schemas, body, params, options) =>
  current.call(route, schemas, body, params, options);
