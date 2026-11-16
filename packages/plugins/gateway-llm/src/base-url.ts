import net from 'node:net';
import { checkAddress, checkHostName, type Lookup } from '@manythreads/sdk/hermes-outbound';
import { lookup as dnsLookup } from 'node:dns';

// Where an admin-entered provider base URL may point (review of Phases 27 and 28, M5). The model proxy makes the call from inside the cluster, so a base URL is a place this
// deployment sends requests (with the provider's key) from its own network. The same outbound guard that holds the team-lead-typed Hermes addresses decides here:
//
//  * a provider that is NOT marked `local` (a hosted vendor, a coding plan) may point at public hosts only: loopback, link-local (the cloud metadata address), the Kubernetes API,
//    this deployment's own names (`manythreads-*`, `*.svc`, `localhost`) and the private ranges (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7) are refused;
//  * a provider the admin marks `local` ("runs inside this deployment") may use loopback, the private ranges and in-cluster names, because that is what local means;
//  * whatever the flag says, link-local and the cloud metadata addresses, the Kubernetes API address and unspecified and multicast addresses are never allowed.
//
// Checked when the provider is saved and again when the setup page's test call is made (the proxy, not this server, opens the connection, so the check cannot sit on the socket).

const blockList = (v4: readonly string[], v6: readonly string[]): net.BlockList => {
  const list = new net.BlockList();
  for (const c of v4) list.addSubnet(c.split('/')[0]!, Number(c.split('/')[1]), 'ipv4');
  for (const c of v6) list.addSubnet(c.split('/')[0]!, Number(c.split('/')[1]), 'ipv6');
  return list;
};

/** Never allowed, even for a local provider: this machine's "nothing", link-local (169.254.169.254 and the IPv6 metadata address), multicast and reserved. */
const NEVER = blockList(['0.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4', '240.0.0.0/4'], ['::/128', 'fe80::/10', 'ff00::/8', 'fd00:ec2::/32']);
/** Inside a network: only a provider the admin marked local may point here (loopback is added through the guard's own list). */
const PRIVATE = blockList(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'], ['fc00::/7']); // secret-scan:ignore range list, not an address
/** Names of the cloud metadata services. */
const METADATA_NAME = /^(metadata\.google\.internal|metadata\.azure\.com|instance-data(\.ec2\.internal)?)$/;

const SENTENCE_BLOCKED = 'That address cannot be used: it points inside this server\'s own network or at a cloud service that hands out credentials. Use the provider\'s public address, or switch on "runs inside this deployment" for a model you host yourself.';
const SENTENCE_NEVER = 'That address cannot be used: link-local and cloud metadata addresses are never allowed, not even for a model that runs inside this deployment.';
const SENTENCE_SCHEME = 'The address must start with https:// (or http://).';

const systemLookup: Lookup = (hostname) =>
  new Promise((resolve, reject) => dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => (err ? reject(err) : resolve(addresses))));

const hostOf = (url: URL): string => url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
const inList = (list: net.BlockList, address: string): boolean => {
  const kind = net.isIP(address);
  return kind !== 0 && list.check(address, kind === 4 ? 'ipv4' : 'ipv6');
};

const LOOPBACK = blockList(['127.0.0.0/8'], ['::1/128']);

/** Why a call to this resolved address may not go out for a provider with this `local` flag, as a sentence, or null. */
function refusalFor(address: string, local: boolean, env: NodeJS.ProcessEnv): string | null {
  if (inList(NEVER, address)) return SENTENCE_NEVER;
  // the guard says no for loopback, link-local, unspecified, multicast and the cluster API address
  const guard = checkAddress(address, env, true);
  if (local) return guard !== null && !inList(LOOPBACK, address) ? SENTENCE_NEVER : null;
  return guard !== null || inList(PRIVATE, address) ? SENTENCE_BLOCKED : null;
}

/**
 * Why this base URL may not be used, as one plain sentence, or null. `lookup` is the test seam for DNS; a name that does not resolve is not refused here (the test call
 * will say the address does not answer), only a name that resolves to a place that is not allowed.
 */
export async function providerBaseProblem(apiBase: string, local: boolean, lookup: Lookup = systemLookup): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return SENTENCE_SCHEME;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return SENTENCE_SCHEME;
  if (url.username !== '' || url.password !== '') return 'Leave the key out of the address; it has its own field.';
  const host = hostOf(url);
  // the Kubernetes API address of this pod is read from the environment, as the guard does; the operator's Hermes allow list is not consulted here
  const env: NodeJS.ProcessEnv = { KUBERNETES_SERVICE_HOST: process.env['KUBERNETES_SERVICE_HOST'] };
  if (METADATA_NAME.test(host)) return SENTENCE_NEVER;
  if (net.isIP(host) !== 0) return refusalFor(host, local, env);
  // this deployment's own names (`localhost`, `manythreads-*`, `*.svc`) are for a provider that says it runs here
  if (!local && checkHostName(host, env) !== null) return SENTENCE_BLOCKED;
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(host);
  } catch {
    return null;
  }
  for (const { address } of addresses) {
    const problem = refusalFor(address, local, env);
    if (problem !== null) return problem;
  }
  return null;
}
