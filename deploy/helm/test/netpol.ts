import type { K8sDoc } from './chart.ts';

// A small evaluator of Kubernetes NetworkPolicies over rendered YAML: "may this pod call that pod on that port?" with the rules of the NetworkPolicy API
// (a pod no policy selects is open; the rules of the policies that select it add up; an empty `from`/`to` matches everything, an absent `ports` every port;
// a `podSelector` alone means pods of the policy's own namespace). It is what k3s' policy controller does, reduced to what the chart uses.

export interface Pod {
  ns: string;
  labels: Record<string, string>;
}
export interface Peer {
  /** A pod of the cluster ... */
  pod?: Pod;
  /** ... or an address outside it. */
  ip?: string;
}

interface Selector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: 'In' | 'NotIn' | 'Exists' | 'DoesNotExist'; values?: string[] }[];
}

export function selects(sel: Selector | undefined, labels: Record<string, string>): boolean {
  if (!sel) return true;
  for (const [k, v] of Object.entries(sel.matchLabels ?? {})) if (labels[k] !== v) return false;
  for (const e of sel.matchExpressions ?? []) {
    const has = e.key in labels;
    if (e.operator === 'In' && !(has && (e.values ?? []).includes(labels[e.key]!))) return false;
    if (e.operator === 'NotIn' && has && (e.values ?? []).includes(labels[e.key]!)) return false;
    if (e.operator === 'Exists' && !has) return false;
    if (e.operator === 'DoesNotExist' && has) return false;
  }
  return true;
}

const nsLabels = (ns: string): Record<string, string> => ({ 'kubernetes.io/metadata.name': ns });

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
}
export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  if (bits === 0) return true;
  const size = 2 ** (32 - bits);
  return Math.floor(ipToInt(ip) / size) === Math.floor(ipToInt(base!) / size);
}

interface PeerRule {
  podSelector?: Selector;
  namespaceSelector?: Selector;
  ipBlock?: { cidr: string; except?: string[] };
}
interface Rule {
  from?: PeerRule[];
  to?: PeerRule[];
  ports?: { port?: number | string; protocol?: string }[];
}

function peerMatches(rule: PeerRule, policyNs: string, peer: Peer): boolean {
  if (rule.ipBlock) {
    if (peer.ip === undefined) return false;
    return inCidr(peer.ip, rule.ipBlock.cidr) && !(rule.ipBlock.except ?? []).some((c) => inCidr(peer.ip!, c));
  }
  if (!peer.pod) return false;
  if (rule.namespaceSelector !== undefined) {
    if (!selects(rule.namespaceSelector, nsLabels(peer.pod.ns))) return false;
  } else if (peer.pod.ns !== policyNs) return false;
  return rule.podSelector === undefined || selects(rule.podSelector, peer.pod.labels);
}

/**
 * May `from` open a TCP connection to `to` on `port`? Both ends are judged: the target's ingress policies and the source's egress policies (a source that is not a
 * cluster pod has no policy).
 */
export function allows(policies: K8sDoc[], releaseNs: string, from: Peer, to: Peer, port: number): boolean {
  const side = (who: Peer, direction: 'Ingress' | 'Egress', other: Peer): boolean => {
    if (!who.pod) return true;
    const applicable = policies.filter((p) => {
      if (p.kind !== 'NetworkPolicy') return false;
      const ns = p.metadata.namespace ?? releaseNs;
      const types: string[] = p['spec'].policyTypes ?? ['Ingress'];
      return ns === who.pod!.ns && types.includes(direction) && selects(p['spec'].podSelector, who.pod!.labels);
    });
    if (applicable.length === 0) return true;
    return applicable.some((p) => {
      const ns = p.metadata.namespace ?? releaseNs;
      const rules: Rule[] = (direction === 'Ingress' ? p['spec'].ingress : p['spec'].egress) ?? [];
      return rules.some((r) => {
        const peers = direction === 'Ingress' ? r.from : r.to;
        const peerOk = peers === undefined || peers.length === 0 || peers.some((pr) => peerMatches(pr, ns, other));
        const portOk = r.ports === undefined || r.ports.length === 0 || r.ports.some((pp) => pp.port === undefined || Number(pp.port) === port);
        return peerOk && portOk;
      });
    });
  };
  return side(to, 'Ingress', from) && side(from, 'Egress', to);
}
