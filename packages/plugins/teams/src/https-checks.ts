import type { GetWorkspaceHttpsResponse, HttpsCheck, HttpsMode, HttpsOrigin } from '@manythreads/shared';

/*
 * Domain & HTTPS checks (onboarding step 4). Pure logic with an injected `fetch`, so it is unit-tested without a network.
 *
 * No SSRF surface: every outbound request goes to a host built from server configuration (`MANYTHREADS_PUBLIC_URL`,
 * `MANYTHREADS_HERMES_PODS_APPS_HOST`) plus a random label this code generates. Nothing from the incoming request (its
 * headers, address or body) ever becomes part of a URL. Redirects are never followed.
 */

export const CHECK_TIMEOUT_MS = 5000;

export type HttpsConfig = {
  mode: HttpsMode;
  origin: HttpsOrigin | null;
  wildcard: boolean;
  acmeServer: 'production' | 'staging' | null;
  publicUrl: string;
  appsDomain: string | null;
  /** `path`: apps live under /apps/ on the platform's own domain; `host`: one subdomain per app (needs a wildcard certificate). */
  appsRouting: 'path' | 'host';
};

type Env = Record<string, string | undefined>;

const HOSTNAME = /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/i;

/** Reads the install's HTTPS settings from the environment the Helm chart sets. Unknown or absent values mean "none". */
export function readHttpsConfig(env: Env, publicUrl: string): HttpsConfig {
  const rawMode = (env['MANYTHREADS_TLS_MODE'] ?? '').trim();
  const mode: HttpsMode = rawMode === 'cloudflare' || rawMode === 'letsencrypt' ? rawMode : 'none';
  const rawOrigin = (env['MANYTHREADS_TLS_ORIGIN'] ?? '').trim();
  const origin: HttpsOrigin | null = mode === 'cloudflare' ? (rawOrigin === 'flexible' ? 'flexible' : 'strict') : null;
  const apps = (env['MANYTHREADS_HERMES_PODS_APPS_HOST'] ?? '').trim().toLowerCase();
  return {
    mode,
    origin,
    wildcard: mode !== 'none' && (env['MANYTHREADS_TLS_WILDCARD'] ?? '').trim() === '1',
    acmeServer: mode === 'letsencrypt' ? ((env['MANYTHREADS_TLS_ACME_SERVER'] ?? '').trim() === 'staging' ? 'staging' : 'production') : null,
    publicUrl,
    appsDomain: HOSTNAME.test(apps) ? apps : null,
    appsRouting: (env['MANYTHREADS_HERMES_PODS_APPS_ROUTING'] ?? '').trim() === 'host' ? 'host' : 'path',
  };
}

export const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
};

type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'manual' }) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

export type ErrorClass = 'tls' | 'dns' | 'timeout' | 'refused' | 'other';

/** Sorts a failed fetch into plain categories. Node puts the system error code on `error.cause`. */
export function classifyFetchError(err: unknown): ErrorClass {
  const e = err as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code ?? e?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') return 'dns';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'refused';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timeout';
  if (
    code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.startsWith('CERT_') || code.startsWith('DEPTH_ZERO') ||
    code.startsWith('UNABLE_TO_') || code.startsWith('SELF_SIGNED') || code === 'ERR_OSSL_EVP_UNSUPPORTED' || code.includes('CERT')
  ) {
    return 'tls';
  }
  return 'other';
}

async function probe(fetchFn: FetchLike, url: string): Promise<{ status: number } | { error: ErrorClass }> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), redirect: 'manual' });
    await res.body?.cancel().catch(() => undefined);
    return { status: res.status };
  } catch (err) {
    return { error: classifyFetchError(err) };
  }
}

export async function checkPublicUrl(cfg: HttpsConfig, fetchFn: FetchLike): Promise<HttpsCheck> {
  if (!cfg.publicUrl.startsWith('https://')) {
    return { id: 'public-url', status: 'skipped', detail: `The public address is ${cfg.publicUrl || 'not set'}, which is not an https:// address, so there is no HTTPS to check.` };
  }
  const r = await probe(fetchFn, `${cfg.publicUrl.replace(/\/+$/, '')}/healthz`);
  if ('status' in r) {
    return r.status >= 200 && r.status < 300
      ? { id: 'public-url', status: 'ok', detail: `${cfg.publicUrl} answered over HTTPS with a valid certificate.` }
      : { id: 'public-url', status: 'fail', detail: `${cfg.publicUrl} answered, but with status ${r.status} instead of success.` };
  }
  const why: Record<ErrorClass, string> = {
    tls: 'Its certificate was rejected (not trusted, expired, or for another name).',
    dns: 'The name does not resolve from inside the cluster.',
    timeout: `No answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`,
    refused: 'The connection was refused or dropped.',
    other: 'The request failed.',
  };
  return { id: 'public-url', status: 'fail', detail: `Could not reach ${cfg.publicUrl} over HTTPS. ${why[r.error]}` };
}

export async function checkWildcard(cfg: HttpsConfig, fetchFn: FetchLike, randomHex: () => string): Promise<HttpsCheck> {
  if (cfg.appsRouting === 'path') {
    return { id: 'wildcard', status: 'skipped', detail: 'Apps are served under /apps/ on this domain, so no wildcard certificate is needed.' };
  }
  if (!cfg.wildcard) return { id: 'wildcard', status: 'skipped', detail: 'Wildcard certificates are off, so app addresses are not checked.' };
  if (!cfg.appsDomain) return { id: 'wildcard', status: 'skipped', detail: 'Apps have no domain of their own, so there is nothing to check.' };
  const host = `mt-check-${randomHex()}-probe.${cfg.appsDomain}`;
  const r = await probe(fetchFn, `https://${host}/`);
  // Any HTTP answer (a 404 is expected) proves the handshake worked with a valid certificate.
  if ('status' in r) return { id: 'wildcard', status: 'ok', detail: `A made-up app address under ${cfg.appsDomain} got a valid certificate.` };
  const hint =
    cfg.mode === 'cloudflare'
      ? " Cloudflare's free certificate covers only the zone and one level below it (example.com and *.example.com). When this domain is itself a subdomain of the zone, app hosts under it are two levels down: turn on Advanced Certificate Manager or Total TLS in Cloudflare, or set those DNS records to DNS only."
      : '';
  const why: Record<ErrorClass, string> = {
    tls: 'The certificate was rejected or does not cover this name.',
    dns: 'The name does not resolve; add a wildcard DNS record (*.' + cfg.appsDomain + ').',
    timeout: `No answer within ${CHECK_TIMEOUT_MS / 1000} seconds.`,
    refused: 'The connection was refused or dropped.',
    other: 'The request failed.',
  };
  return { id: 'wildcard', status: 'fail', detail: `A made-up app address under ${cfg.appsDomain} did not work. ${why[r.error]}${r.error === 'tls' ? hint : ''}` };
}

const bareIp = (ip: string): string => (ip.startsWith('::ffff:') ? ip.slice(7) : ip).trim().toLowerCase();

export function checkClientIp(ip: string, headers: Record<string, string | undefined>): { check: HttpsCheck; seenAs: GetWorkspaceHttpsResponse['seenAs'] } {
  const cfIp = headers['cf-connecting-ip']?.trim();
  const viaCloudflare = Boolean(cfIp) || Boolean(headers['cf-ray']);
  const seenAs = { clientIp: ip, viaCloudflare };
  if (!viaCloudflare) return { seenAs, check: { id: 'client-ip', status: 'ok', detail: `This request was not sent through Cloudflare. The server sees you as ${ip}.` } };
  if (cfIp && bareIp(cfIp) !== bareIp(ip)) {
    return {
      seenAs,
      check: {
        id: 'client-ip',
        status: 'warn',
        detail: `Cloudflare says you are ${cfIp}, but the server sees ${ip}. The number of proxy hops the server trusts is probably wrong, so rate limits and the audit log record the wrong address.`,
      },
    };
  }
  return { seenAs, check: { id: 'client-ip', status: 'ok', detail: `The server sees your real address, ${ip}, as Cloudflare reports it.` } };
}

export function checkProxyMatch(mode: HttpsMode, headers: Record<string, string | undefined>): HttpsCheck {
  const hasRay = Boolean(headers['cf-ray']);
  if (mode === 'cloudflare' && !hasRay) {
    return { id: 'proxy-match', status: 'warn', detail: 'The install is set to Cloudflare, but this request did not come through Cloudflare. Check that the DNS record is proxied (orange cloud).' };
  }
  if (mode !== 'cloudflare' && hasRay) {
    return { id: 'proxy-match', status: 'warn', detail: 'This request came through Cloudflare, but the install is not set to Cloudflare. Switch the mode so addresses and certificates match.' };
  }
  return { id: 'proxy-match', status: 'ok', detail: mode === 'cloudflare' ? 'The request came through Cloudflare, as configured.' : 'The request path matches the configured mode.' };
}

/** Runs every check in parallel. */
export async function runHttpsChecks(
  cfg: HttpsConfig,
  req: { ip: string; headers: Record<string, string | undefined> },
  fetchFn: FetchLike,
  randomHex: () => string,
): Promise<GetWorkspaceHttpsResponse> {
  const [publicUrl, wildcard] = await Promise.all([checkPublicUrl(cfg, fetchFn), checkWildcard(cfg, fetchFn, randomHex)]);
  const { check: clientIp, seenAs } = checkClientIp(req.ip, req.headers);
  return {
    mode: cfg.mode,
    origin: cfg.origin,
    wildcard: cfg.wildcard,
    acmeServer: cfg.acmeServer,
    domain: hostOf(cfg.publicUrl),
    appsDomain: cfg.appsDomain,
    appsRouting: cfg.appsRouting,
    checks: [publicUrl, wildcard, clientIp, checkProxyMatch(cfg.mode, req.headers)],
    seenAs,
  };
}
