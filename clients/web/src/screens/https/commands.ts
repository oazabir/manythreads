import type { GetWorkspaceHttpsResponse } from '@manythreads/shared';

/*
 * Pure text for the Domain & HTTPS page: what the current mode means and the exact deploy command that switches to each
 * other mode. The server cannot change the mode (it has no rights on the cluster), so the page hands the admin the command.
 */

export type HttpsModeInfo = Pick<GetWorkspaceHttpsResponse, 'mode' | 'origin' | 'wildcard' | 'acmeServer'>;

export type SwitchOption = {
  id: 'none' | 'cloudflare-strict' | 'cloudflare-flexible' | 'letsencrypt';
  title: string;
  /** One sentence on how this mode works. */
  summary: string;
  command: string;
};

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
export const switchOptions = (c: HttpsModeInfo): SwitchOption[] => OPTIONS.filter((o) => o.id !== currentOptionId(c));

/** The current mode in plain words: its name, then what it means. */
export function describeMode(c: HttpsModeInfo): string {
  const o = OPTIONS.find((x) => x.id === currentOptionId(c));
  if (!o) return 'Unknown';
  const staging = c.mode === 'letsencrypt' && c.acmeServer === 'staging' ? " (test certificates: browsers will warn until you switch to the production server, run the command again without '--acme-staging')" : '';
  return `${o.title}: ${o.summary}${staging}`;
}

/** Where app addresses live, e.g. `<app>--<team>.apps.example.com`, or null when apps have no domain of their own. */
export const appHostPattern = (appsDomain: string | null): string | null => (appsDomain ? `<app>--<team>.${appsDomain}` : null);

export const statusWord = (s: GetWorkspaceHttpsResponse['checks'][number]['status']): string =>
  ({ ok: 'ok', warn: 'check', fail: 'failed', skipped: 'skipped' })[s];

export const CHECK_TITLES: Record<GetWorkspaceHttpsResponse['checks'][number]['id'], string> = {
  'public-url': 'Public address works over HTTPS',
  wildcard: 'App addresses get a certificate',
  'client-ip': 'Visitor address is read correctly',
  'proxy-match': 'Request path matches the chosen mode',
};
