import { BotServerName, type BotServer, type BotServerAgentName } from '@manythreads/shared';

/*
 * The words and small decisions of the servers part of the Runners page (PLAN P26-13, docs/plans/agents-anywhere.md §5.1), with no React in them so they are tested
 * on their own. Every sentence an admin reads about a server is chosen here. A code is shown once and never kept; a key is never here at all.
 */

export const AGENT_TITLE: Readonly<Record<BotServerAgentName, string>> = { 'claude-code': 'Claude Code', codex: 'Codex', 'hermes-acp': 'Hermes' };

/** Which agents of a server have a sign-in of their own on this page. Hermes uses the workspace's model gateway and has none. */
export const hasOwnSignin = (agent: BotServerAgentName): boolean => agent !== 'hermes-acp';

/** The one line to paste. `code` is shown to the admin once; `-` makes the script ask for the code on the keyboard. */
export const installCommand = (site: string, code: string): string => `curl -fsSL ${site}/install/bridge.sh | sudo bash -s -- --enrol ${code}`;

/** The same, with the code kept out of the shell history and out of `ps`: the script reads it from the keyboard (`/dev/tty`). */
export const askCommand = (site: string): string => installCommand(site, '-');

/** The careful way: download, look, check the hash this page shows, run. */
export const carefulSteps = (site: string, scriptSha256: string, code: string): string[] => [
  `curl -fsSL ${site}/install/bridge.sh -o bridge.sh`,
  'less bridge.sh',
  `echo "${scriptSha256}  bridge.sh" | sha256sum -c -`,
  `sudo bash bridge.sh --enrol ${code}`,
];

export const HASH_NOTE = 'The hash comes from this same site, so it guards against a broken download, not against a site that was taken over.';

/** Why a name is not allowed, or null. The same rule as the server's (a short lower-case name that never changes). */
export function serverNameProblem(name: string): string | null {
  if (name.trim() === '') return 'Give the server a short name.';
  return BotServerName.safeParse(name).success ? null : 'Use lower-case letters, digits and "-", starting with a letter or digit, at most 31 characters.';
}

export const suggestServerName = (label: string): string =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 31);

export function statusWords(s: Pick<BotServer, 'status' | 'enrolled'>): { label: string; tone: 'ok' | 'warn' | 'faint' } {
  if (s.status === 'connected') return { label: 'Connected', tone: 'ok' };
  if (!s.enrolled) return { label: 'Waiting for the installer', tone: 'faint' };
  return { label: 'Not connected', tone: 'warn' };
}

/** `Ubuntu 24.04 · x64 · box-1 · bridge 1.2.3`, or nothing before the first connection. */
export function hostLine(s: Pick<BotServer, 'host' | 'bridgeVersion'>): string | null {
  if (s.host === null) return null;
  return [s.host.system, s.host.arch, s.host.hostname, s.bridgeVersion ? `bridge ${s.bridgeVersion}` : null].filter((x) => x !== null && x !== '').join(' · ');
}

export function agentLine(a: BotServer['agents'][number]): string {
  return `${AGENT_TITLE[a.agent]}${a.version ? ` ${a.version}` : ''}`;
}

export const waitingWords = (name: string): string => `Waiting for ${name} to connect…`;

export function codeWords(s: Pick<BotServer, 'codeExpiresAt'>, now: number = Date.now()): string {
  if (s.codeExpiresAt === null) return 'No code is waiting.';
  const left = Math.max(0, Math.round((Date.parse(s.codeExpiresAt) - now) / 60_000));
  return left <= 0 ? 'The code has expired. Make a new one.' : `The code works once and for ${left} more minute${left === 1 ? '' : 's'}.`;
}

export const REACH_NOTE =
  'A bot on this server can reach everything the bridge’s own user can reach on that machine: its folders, its network and the key it uses to talk to this site. Put only teams you trust together on one server.';

export const SIGNIN_NOTE = 'Each agent signs in to a folder of its own on the server. Your account on that machine is not touched.';

export function rotateWords(s: Pick<BotServer, 'label'>): string {
  return `Change the key of ${s.label}? The server gets a new key over its open connection and starts using it at once. Nothing else needs doing.`;
}

export function removeWords(s: Pick<BotServer, 'label'>): string {
  return `Remove ${s.label}? Its runners go with it and the key stops working. The program stays on the machine until you run the installer there with --uninstall. Bots placed on it must be moved first.`;
}

export const rotatedWords = (s: Pick<BotServer, 'label'>): string => `${s.label} has a new key.`;
export const removedWords = (s: Pick<BotServer, 'label'>): string => `${s.label} was removed.`;
