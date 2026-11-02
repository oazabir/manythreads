import type { K8sObject } from './k8s.ts';
import { HOSTNAME_LABEL, MOVE_CONFIRMED_ANNOTATION, NODE_ANNOTATION, SELECTED_NODE_ANNOTATION } from './render.ts';

// Moving a team's pod to another machine deletes its two volumes (PLAN P19-08). The rules that keep that from happening by accident live here, apart from the reconciler:
//  - which machine a volume is really tied to (the scheduler names a Node by its object name, the picker and the nodeSelector by its `kubernetes.io/hostname` label);
//  - whether an admin confirmed this very move a short while ago.

/** How long an admin's "move and make the volumes again" stays valid. After this the controller treats the move as unconfirmed again and deletes nothing. */
export const CONFIRM_WINDOW_MS = 15 * 60 * 1000;

/** The machine's hostname label (the name the picker and the nodeSelector use) for a Node object. */
export function hostnameOf(node: K8sObject): string {
  return node.metadata.labels?.[HOSTNAME_LABEL] ?? node.metadata.name;
}

/** How a claim's machine is known. `unknown`: it is tied to a machine (the scheduler picked one) but that machine cannot be turned into a hostname right now. */
export interface VolumeSite {
  node: string | null;
  unknown: boolean;
}

/**
 * The machine (by hostname) a volume claim is tied to. This controller's own annotation is trusted when it is there (it holds the hostname the pod was pinned to).
 * A claim with only the scheduler's `selected-node` (made before this annotation existed) names the Node by its object name, which can differ from the hostname label
 * (a node started with a hostname override, some clouds): that name is looked up in `nodes`. A name that cannot be found gives `unknown`, and an unknown site is never judged
 * stale (nothing is deleted on a guess). A claim with neither is new or not tied to a machine: `node: null`.
 */
export function volumeSite(claim: K8sObject | null, nodes: readonly K8sObject[] | null): VolumeSite {
  if (!claim) return { node: null, unknown: false };
  const own = claim.metadata.annotations?.[NODE_ANNOTATION];
  if (own !== undefined && own !== '') return { node: own, unknown: false };
  const selected = claim.metadata.annotations?.[SELECTED_NODE_ANNOTATION];
  if (selected === undefined || selected === '') return { node: null, unknown: false };
  const found = nodes?.find((n) => n.metadata.name === selected);
  return found ? { node: hostnameOf(found), unknown: false } : { node: null, unknown: true };
}

/** Does a claim need the node objects to say where it is (it has only the scheduler's note)? */
export function needsNodeLookup(claim: K8sObject | null): boolean {
  const a = claim?.metadata.annotations;
  return !!claim && (a?.[NODE_ANNOTATION] ?? '') === '' && (a?.[SELECTED_NODE_ANNOTATION] ?? '') !== '';
}

/** The mark an admin's confirmation leaves on a claim. */
export function confirmMark(node: string, now: number): string {
  return `${node}@${now}`;
}

/** Does the claim carry a confirmation for exactly `node` that is not older than the window? */
export function confirmedFor(claim: K8sObject, node: string, now: number): boolean {
  const raw = claim.metadata.annotations?.[MOVE_CONFIRMED_ANNOTATION];
  if (raw === undefined) return false;
  const at = raw.lastIndexOf('@');
  if (at <= 0 || raw.slice(0, at) !== node) return false;
  const when = Number(raw.slice(at + 1));
  if (!Number.isFinite(when)) return false;
  // a mark from the future (clock difference of a minute is fine) is not trusted beyond the window either
  return now - when <= CONFIRM_WINDOW_MS && when - now <= 60_000;
}

/** A claim the cluster is already deleting. */
export function isTerminating(obj: K8sObject): boolean {
  return (obj.metadata as { deletionTimestamp?: string }).deletionTimestamp !== undefined;
}
