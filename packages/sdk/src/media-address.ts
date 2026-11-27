// The address a browser connects to for a call (the one function every join goes through; PLAN P38-11).
//
// The server is told ONE media address (`MANYTHREADS_LIVEKIT_URL`). When the chart routes the media pod under the main site's own path (`wss://<site>/livekit`), that
// address names one host of the site. A person who opens the site through another host name (a second domain, a local IP such as https://10.0.0.5) would be handed an
// address on a different origin, and the page's Content-Security-Policy (`connect-src 'self'`) would block it. So for that path form the address is rebuilt from the
// origin the person's request came in on, keeping the path. An address on a host of its own (`wss://media.example.org`, or a path on another host) is returned as it is:
// it is the operator's job to allow that host in `connect-src` (docs/plugins/meetings.md).

/** `http://` or `https://`, a host name, an IPv4 address or a bracketed IPv6 address, and an optional port. Nothing else (no user, path, query or fragment). */
const ORIGIN = /^(https?):\/\/((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)|(?:\[[0-9a-f:.]+\]))(:\d{1,5})?$/i;

/** True for `http(s)://host[:port]` and nothing else. */
function plainOrigin(origin: string): boolean {
  const m = ORIGIN.exec(origin);
  if (!m) return false;
  return !m[3] || Number(m[3].slice(1)) <= 65535;
}

/**
 * The origin a request came in on, from the scheme and the host the server already believes (Fastify's `request.protocol` and `request.host`, which follow
 * `x-forwarded-proto` and `x-forwarded-host` only from the proxies `MANYTHREADS_TRUST_PROXY` names). Lower-cased; undefined for anything that is not a plain
 * `http(s)://host[:port]` (a made-up header never becomes part of an address).
 */
export function requestOriginOf(protocol: string | undefined, host: string | undefined): string | undefined {
  if (!protocol || !host) return undefined;
  const origin = `${protocol.trim().toLowerCase()}://${host.trim().toLowerCase()}`;
  return plainOrigin(origin) ? origin : undefined;
}

/**
 * The address to give the browser. `configured` is the media server's public address (`wss://…`). `requestOrigin` is the origin the request came in on (see
 * `requestOriginOf`); `publicUrl` is the site's own address (`MANYTHREADS_PUBLIC_URL`; without it nothing is rewritten).
 *
 * The configured address is rebuilt from the request's origin (`https` becomes `wss`, `http` becomes `ws`; the path stays) only when it is the same-origin path form:
 * it has a path (the media pod is routed under a path of the site), its host is the site's own, and the page is on another host. Everything else comes back unchanged: no usable request origin,
 * an address with no path, an address on another host.
 */
export function mediaAddressFor(configured: string, requestOrigin: string | undefined, publicUrl: string | undefined): string {
  if (!requestOrigin || !plainOrigin(requestOrigin)) return configured;
  let media: URL;
  try {
    media = new URL(configured);
  } catch {
    return configured;
  }
  if (media.protocol !== 'wss:' && media.protocol !== 'ws:') return configured;
  const path = media.pathname.replace(/\/+$/, '');
  if (path === '') return configured;
  // Only the site's own host is rewritten; without a site address to compare with, nothing is (fail closed).
  try {
    if (!publicUrl || new URL(publicUrl).host.toLowerCase() !== media.host.toLowerCase()) return configured;
  } catch {
    return configured;
  }
  const page = new URL(requestOrigin);
  // The page is on the media address's own host: nothing to follow (and no scheme to guess from a proxy that did not say it).
  if (page.host.toLowerCase() === media.host.toLowerCase()) return configured;
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}${path}${media.search}`;
}
