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
    kind: 'kubernetes',
    label: 'Kubernetes cluster',
    description: 'A cluster a bot may look at and change through short-lived access that expires within an hour.',
    scopes: ['team'],
    available: false,
    unavailableReason: 'Kubernetes access is not available yet: it arrives with the cluster broker, which hands a bot a short-lived key for each task.',
    credentials: [{ name: 'token', label: 'Service account token', hint: 'Stored sealed. Nobody can read it back after saving.' }],
  },
];

export const connectionKindInfo = (kind: string): ConnectionKindInfo | undefined => CONNECTION_KINDS.find((k) => k.kind === kind);

/** What the screens say when someone who is not a workspace admin tries to add or change a team's connection. */
export const CONNECTION_ADMIN_ONLY = 'Only a workspace admin can add or change a team’s connections. Ask one of them to set it up.';

/** The tools each kind serves, by kind: shown on the Add connection and bot pages. Kept in step with the plugin's `TOOLS` by a test. */
export const CONNECTION_KIND_TOOLS: Readonly<Record<string, readonly string[]>> = {
  email: ['email.read', 'email.draft', 'email.send'],
};
