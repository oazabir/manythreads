/**
 * A tiny cookie-jar HTTP client for tests against a running server: keeps the session and CSRF cookies from
 * Set-Cookie headers and sends `x-csrf-token` on unsafe methods, like the web client does.
 */
export interface ApiClient {
  readonly baseUrl: string;
  /** Current cookie values by name (cleared cookies are removed). */
  readonly cookies: ReadonlyMap<string, string>;
  /** Raw Set-Cookie headers of the most recent response. */
  readonly lastSetCookies: readonly string[];
  request(method: string, path: string, options?: { body?: unknown; headers?: Record<string, string>; csrf?: boolean }): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  delete(path: string, headers?: Record<string, string>): Promise<Response>;
  /** Password sign-in through the real route. */
  signIn(email: string, password: string): Promise<Response>;
  /** Test-endpoint sign-in (needs the server's testAuthToken). */
  testSignIn(email: string, token: string): Promise<Response>;
}

export function createApiClient(baseUrl: string, options: { userAgent?: string } = {}): ApiClient {
  const cookies = new Map<string, string>();
  let lastSetCookies: string[] = [];
  const userAgent = options.userAgent ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';

  const absorb = (res: Response): void => {
    lastSetCookies = res.headers.getSetCookie();
    for (const raw of lastSetCookies) {
      const [pair = '', ...attrs] = raw.split(';').map((p) => p.trim());
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      const expires = attrs.find((a) => /^expires=/i.test(a));
      const expired =
        (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) ||
        (expires !== undefined && new Date(expires.slice(8)).getTime() <= Date.now());
      if (value === '' || expired) cookies.delete(name);
      else cookies.set(name, value);
    }
  };

  const client: ApiClient = {
    baseUrl,
    cookies,
    get lastSetCookies() {
      return lastSetCookies;
    },
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = { 'user-agent': userAgent, ...opts.headers };
      if (cookies.size > 0) headers['cookie'] = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
      const csrf = cookies.get('manythreads_csrf');
      if (unsafe && csrf && opts.csrf !== false && headers['x-csrf-token'] === undefined) headers['x-csrf-token'] = csrf;
      let body: string | undefined;
      if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }
      const res = await fetch(baseUrl + path, { method, headers, ...(body !== undefined ? { body } : {}) });
      absorb(res);
      return res;
    },
    get: (path, headers) => client.request('GET', path, headers ? { headers } : {}),
    post: (path, body, headers) => client.request('POST', path, { ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}) }),
    delete: (path, headers) => client.request('DELETE', path, headers ? { headers } : {}),
    signIn: (email, password) => client.post('/api/auth/password/sign-in', { email, password }),
    testSignIn: (email, token) => client.post('/api/test/session', { email }, { 'x-test-auth': token }),
  };
  return client;
}
