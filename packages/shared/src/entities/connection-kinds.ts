import type { ConnectionKind, ConnectionScope, ConnectionSecretName } from './connection.ts';

// The kinds of outside service a person can add a connection for, as the Add connection flow shows them (PLAN P8-06). The connections plugin holds what each kind
// DOES (its tools, what a call answers); this list holds what a person is TOLD and ASKED: a plain name, one sentence, and which credentials the kind needs. A kind
// that is listed but not `available` is shown greyed out with its reason and cannot be created (the plugin refuses it with the same words).

export interface ConnectionKindCredential {
  /** The name the credential is stored under (a `ConnectionSecretName`). */
  name: ConnectionSecretName;
  label: string;
  hint: string;
}

export interface ConnectionKindInfo {
  kind: ConnectionKind;
  label: string;
  description: string;
  /** Who may have a connection of this kind: a team's (an admin adds it), a person's own, or both. */
  scopes: readonly ConnectionScope[];
  available: boolean;
  /** Why it cannot be added yet, in words for the person who asked. Present exactly when `available` is false. */
  unavailableReason?: string;
  credentials: readonly ConnectionKindCredential[];
}

export const CONNECTION_KINDS: readonly ConnectionKindInfo[] = [
  {
    kind: 'email',
    label: 'Mailbox',
    description: 'A shared mailbox a bot can read, draft in and send from. Sending usually waits for a person to approve it.',
    scopes: ['team'],
    available: true,
    credentials: [{ name: 'password', label: 'Mailbox password or app password', hint: 'Stored sealed. Nobody, including you, can read it back after saving.' }],
  },
  {
    kind: 'ssh',
    label: 'Servers over SSH',
    description: 'Lets a bot run a short list of commands you wrote on your servers, with a certificate made for each call that expires within an hour.',
    scopes: ['team'],
    available: true,
    credentials: [
      { name: 'ca_url', label: 'Certificate authority address', hint: 'The step-ca address, for example https://ca.example.com.' },
      { name: 'provisioner', label: 'Provisioner name', hint: 'The step-ca JWK provisioner the platform signs in with.' },
      { name: 'provisioner_key', label: 'Provisioner key', hint: 'Stored sealed. The provisioner’s private key (JWK).' },
      { name: 'user', label: 'Account on the servers', hint: 'The one account the certificate is made for.' },
      { name: 'hosts', label: 'Servers', hint: 'One per line: the servers a bot may reach.' },
      { name: 'known_hosts', label: 'Known hosts', hint: 'The servers’ public host keys, in known_hosts format.' },
      { name: 'commands', label: 'Allowed commands', hint: 'One per line. A bot can run only these, word for word.' },
      { name: 'ca_cert', label: 'CA certificate (optional)', hint: 'Only when the authority uses a private certificate.' },
    ],
  },
  {
    kind: 'kubernetes',
    label: 'Kubernetes cluster',
    description: 'A cluster a bot may look at (read only) through short-lived access that expires within an hour.',
    scopes: ['team'],
    available: true,
    credentials: [
      { name: 'api_url', label: 'Cluster address', hint: 'The API server address, for example https://cluster.example.com:6443.' },
      { name: 'token', label: 'Bootstrap token', hint: 'Stored sealed. Allowed only to ask for tokens of the service account below.' },
      { name: 'service_account', label: 'Service account', hint: 'The account whose role limits what a bot can read.' },
      { name: 'namespace', label: 'Namespace', hint: 'Where the service account lives.' },
      { name: 'namespaces', label: 'Namespaces a bot may read (optional)', hint: 'Comma separated. Default: the namespace above.' },
      { name: 'ca_cert', label: 'CA certificate (optional)', hint: 'Only when the cluster uses a private certificate.' },
    ],
  },
];

export const connectionKindInfo = (kind: string): ConnectionKindInfo | undefined => CONNECTION_KINDS.find((k) => k.kind === kind);

/** What the screens say when someone who is not a workspace admin tries to add or change a team's connection. */
export const CONNECTION_ADMIN_ONLY = 'Only a workspace admin can add or change a team’s connections. Ask one of them to set it up.';

/** The tools each kind serves, by kind: shown on the Add connection and bot pages. Kept in step with the plugin's `TOOLS` by a test. */
export const CONNECTION_KIND_TOOLS: Readonly<Record<string, readonly string[]>> = {
  email: ['email.read', 'email.draft', 'email.send'],
  ssh: ['ssh.run'],
  kubernetes: ['kubernetes.get'],
};
