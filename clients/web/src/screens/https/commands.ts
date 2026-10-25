import type { GetWorkspaceHttpsResponse } from '@manythreads/shared';

/*
 * Pure text for the Domain & HTTPS page: what the current mode means and the exact deploy command that switches to each
 * other mode. The server cannot change the mode (it has no rights on the cluster), so the page hands the admin the command.
 */

export type HttpsModeInfo = Pick<GetWorkspaceHttpsResponse, 'mode' | 'origin' | 'wildcard' | 'acmeServer'> & Partial<Pick<GetWorkspaceHttpsResponse, 'appsRouting'>>;

export type SwitchOption = {
  id: 'none' | 'cloudflare-strict' | 'cloudflare-flexible' | 'letsencrypt';
  title: string;
  /** One sentence on how this mode works. */
  summary: string;
  command: string;
};

/** Apps served by path (the default) need no wildcard certificate, so no DNS token either. An older server that does not say is treated as `host`. */
const byPath = (c: HttpsModeInfo): boolean => c.appsRouting === 'path';

const DEPLOY = 'tools/devbox/deploy.sh';

const OPTIONS: SwitchOption[] = [
  {
    id: 'cloudflare-strict',
    title: 'Cloudflare proxy, Full (strict)',
    summary: 'Cloudflare serves visitors, and this cluster holds a Cloudflare origin certificate so the hop to Cloudflare is encrypted too.',
    command: `${DEPLOY} --tls cloudflare --cf-origin strict --origin-cert origin.pem --origin-key origin.key`,
  },
  {
    id: 'cloudflare-flexible',
    title: 'Cloudflare proxy, Flexible',
    summary: 'Cloudflare serves visitors over HTTPS and talks plain HTTP to this cluster, so nothing needs installing here but the last hop is not encrypted.',
    command: `${DEPLOY} --tls cloudflare --cf-origin flexible`,
  },
  {
    id: 'letsencrypt',
    title: "Let's Encrypt",
    summary: "This cluster gets its own free certificate and serves visitors directly; a wildcard certificate needs a DNS token so app addresses are covered.",
    command: `${DEPLOY} --tls letsencrypt --acme-email you@example.com --dns-token-file dns-token.txt`,
  },
  {
    id: 'none',
    title: 'No HTTPS',
    summary: 'Plain HTTP only. Fine for a trial on a private network, not for anything people reach over the internet.',
    command: `${DEPLOY} --tls none`,
  },
];

export const currentOptionId = (c: HttpsModeInfo): SwitchOption['id'] =>
  c.mode === 'cloudflare' ? (c.origin === 'flexible' ? 'cloudflare-flexible' : 'cloudflare-strict') : c.mode;

/** The deploy command for every mode except the one in use. */
const forRouting = (o: SwitchOption, c: HttpsModeInfo): SwitchOption =>
  o.id === 'letsencrypt' && byPath(c)
    ? {
        ...o,
        summary: 'This cluster gets its own free certificate for the domain and serves visitors directly. Apps live under /apps/ on the same domain, so no wildcard certificate or DNS token is needed.',
        command: `${DEPLOY} --tls letsencrypt --acme-email you@example.com`,
      }
    : o;

export const switchOptions = (c: HttpsModeInfo): SwitchOption[] => OPTIONS.filter((o) => o.id !== currentOptionId(c)).map((o) => forRouting(o, c));

/** The current mode in plain words: its name, then what it means. */
export function describeMode(c: HttpsModeInfo): string {
  const found = OPTIONS.find((x) => x.id === currentOptionId(c));
  if (!found) return 'Unknown';
  const o = forRouting(found, c);
  const staging = c.mode === 'letsencrypt' && c.acmeServer === 'staging' ? " (test certificates: browsers will warn until you switch to the production server, run the command again without '--acme-staging')" : '';
  return `${o.title}: ${o.summary}${staging}`;
}

/** Where app addresses live: `https://example.com/apps/<team>/<app>/` when routed by path, `<app>--<team>.apps.example.com` otherwise; null when apps have no domain. */
export const appHostPattern = (appsDomain: string | null, routing: 'path' | 'host' = 'host'): string | null =>
  appsDomain ? (routing === 'path' ? `https://${appsDomain}/apps/<team>/<app>/` : `<app>--<team>.${appsDomain}`) : null;

export const statusWord = (s: GetWorkspaceHttpsResponse['checks'][number]['status']): string =>
  ({ ok: 'ok', warn: 'check', fail: 'failed', skipped: 'skipped' })[s];

export const CHECK_TITLES: Record<GetWorkspaceHttpsResponse['checks'][number]['id'], string> = {
  'public-url': 'Public address works over HTTPS',
  wildcard: 'App addresses get a certificate',
  'client-ip': 'Visitor address is read correctly',
  'proxy-match': 'Request path matches the chosen mode',
};
