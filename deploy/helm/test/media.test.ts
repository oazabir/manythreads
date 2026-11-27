import { describe, expect, it } from 'vitest';
import { haveHelm, idOf, render, renderNotes, renderRaw, type K8sDoc } from './chart.ts';

// P38-09: calls (the LiveKit media pod) and TURN. The chart default stays off (the installer turns it on); with it on, TURN without TLS needs no certificate or load balancer,
// the relay ports have their own range, and a changed setting restarts the pod.

const CIDR = 'hermesPods.apiServer.cidr=10.0.2.15/32';
const ON = ['media.enabled=true', 'media.ingressPath=/livekit'];
const TURN = ['media.turn.enabled=true', 'media.turn.domain=turn.example.test'];
const livekit = (docs: K8sDoc[]): string => (docs.find((d) => d.kind === 'ConfigMap' && d.metadata.name === 'manythreads-media-config')!['data']['livekit.yaml'] as string);
const deployment = (docs: K8sDoc[]): K8sDoc => docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-media')!;
const checksum = (docs: K8sDoc[]): string => deployment(docs)['spec'].template.metadata.annotations['checksum/config'] as string;
const serverEnv = (docs: K8sDoc[]): Record<string, string> => {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!;
  const env = dep['spec'].template.spec.containers[0].env as { name: string; value?: string }[];
  return Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
};
const base = (...sets: string[]): K8sDoc[] => render('base', [CIDR, ...sets]);

describe.skipIf(!haveHelm)('calls and TURN (media.*)', () => {
  it('is off by default: nothing of the media server renders', () => {
    const ids = base().map(idOf);
    expect(ids.filter((i) => i.toLowerCase().includes('media'))).toEqual([]);
    expect(serverEnv(base())['MANYTHREADS_LIVEKIT_URL']).toBeUndefined();
  });

  it('turn on without TURN: only the audio settings, no turn block', () => {
    const cfg = livekit(base(...ON));
    expect(cfg).toContain('port_range_start: 50000');
    expect(cfg).toContain('tcp_port: 7881');
    expect(cfg).not.toContain('turn:');
    expect(cfg).not.toContain('advertise_internal_ip');
  });

  it('TURN over UDP only (tlsPort 0): no tls_port and no external_tls, and the domain is required', () => {
    const cfg = livekit(base(...ON, ...TURN, 'media.turn.tlsPort=0'));
    expect(cfg).toContain('turn:\n  enabled: true');
    expect(cfg).toContain('domain: "turn.example.test"');
    expect(cfg).toContain('udp_port: 3478');
    expect(cfg).not.toContain('tls_port');
    expect(cfg).not.toContain('external_tls');
    const r = renderRaw('base', [CIDR, ...ON, 'media.turn.enabled=true', 'media.turn.tlsPort=0']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('media.turn.enabled needs media.turn.domain');
  });

  it('TURN over TLS (tlsPort above 0) writes tls_port and external_tls', () => {
    const cfg = livekit(base(...ON, ...TURN, 'media.turn.tlsPort=5349'));
    expect(cfg).toContain('tls_port: 5349');
    expect(cfg).toContain('external_tls: true');
    expect(cfg).toContain('udp_port: 3478');
  });

  it('refuses TURN with neither a UDP nor a TLS port', () => {
    const r = renderRaw('base', [CIDR, ...ON, ...TURN, 'media.turn.tlsPort=0', 'media.turn.udpPort=0']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('media.turn.udpPort or media.turn.tlsPort');
  });

  it('relay port range: 50101-50300 by default, and the values given', () => {
    const cfg = livekit(base(...ON, ...TURN));
    expect(cfg).toContain('relay_range_start: 50101');
    expect(cfg).toContain('relay_range_end: 50300');
    const own = livekit(base(...ON, ...TURN, 'media.turn.relayPortStart=51000', 'media.turn.relayPortEnd=51050'));
    expect(own).toContain('relay_range_start: 51000');
    expect(own).toContain('relay_range_end: 51050');
    const bad = renderRaw('base', [CIDR, ...ON, ...TURN, 'media.turn.relayPortStart=51000', 'media.turn.relayPortEnd=50999']);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('relayPortEnd');
    const overlap = renderRaw('base', [CIDR, ...ON, ...TURN, 'media.rtcPortEnd=50200']);
    expect(overlap.code).not.toBe(0);
    expect(overlap.err).toContain('must not overlap');
    const onPort = renderRaw('base', [CIDR, ...ON, ...TURN, 'media.turn.relayPortStart=3400', 'media.turn.relayPortEnd=3500']);
    expect(onPort.code).not.toBe(0);
    expect(onPort.err).toContain('must not contain the port 3478');
    const slash = renderRaw('base', [CIDR, 'media.enabled=true', 'media.ingressPath=livekit']);
    expect(slash.code).not.toBe(0);
    expect(slash.err).toContain('media.ingressPath must start with /');
  });

  it('the relay lists are empty by default, and carry the CIDRs given', () => {
    const none = livekit(base(...ON, ...TURN));
    expect(none).not.toContain('allow_restricted_peer_cidrs');
    expect(none).not.toContain('deny_peer_cidrs');
    const cfg = livekit(
      base(...ON, ...TURN, 'media.turn.allowRestrictedPeerCidrs={192.168.0.0/16,10.0.0.0/8}', 'media.turn.denyPeerCidrs={10.9.0.0/16}'),
    );
    expect(cfg).toContain('allow_restricted_peer_cidrs:\n    - "192.168.0.0/16"\n    - "10.0.0.0/8"');
    expect(cfg).toContain('deny_peer_cidrs:\n    - "10.9.0.0/16"');
    const bad = renderRaw('base', [CIDR, ...ON, ...TURN, 'media.turn.denyPeerCidrs={nonsense}']);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toContain('CIDR');
    for (const wrong of ['192.168.0.0/99', '999.1.1.1/8', '10.1.2.3', 'fd00::/200']) {
      expect(renderRaw('base', [CIDR, ...ON, ...TURN, `media.turn.denyPeerCidrs={${wrong}}`]).code, wrong).not.toBe(0);
    }
    expect(livekit(base(...ON, ...TURN, 'media.turn.allowRestrictedPeerCidrs={fd00::/8,172.16.0.0/12,10.1.2.3/32}'))).toContain('"fd00::/8"');
  });

  it('advertiseInternalIp writes advertise_internal_ip next to nodeIp', () => {
    const cfg = livekit(base(...ON, 'media.nodeIp=10.0.2.15', 'media.useExternalIp=false', 'media.advertiseInternalIp=true'));
    expect(cfg).toContain('node_ip: "10.0.2.15"');
    expect(cfg).toContain('use_external_ip: false');
    expect(cfg).toContain('advertise_internal_ip: true');
  });

  it('the address browsers use: wss://<domain>/livekit when empty, an explicit publicUrl wins', () => {
    expect(serverEnv(base(...ON, 'domain=chat.example.test'))['MANYTHREADS_LIVEKIT_URL']).toBe('wss://chat.example.test/livekit');
    expect(serverEnv(base('media.enabled=true', 'media.ingressPath=/calls', 'domain=chat.example.test'))['MANYTHREADS_LIVEKIT_URL']).toBe('wss://chat.example.test/calls');
    expect(serverEnv(base(...ON, 'domain=chat.example.test', 'media.publicUrl=wss://media.example.test'))['MANYTHREADS_LIVEKIT_URL']).toBe('wss://media.example.test');
    const r = renderRaw('base', [CIDR, 'media.enabled=true']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('media.publicUrl');
  });

  it('the pod carries a checksum of its config: the same settings give the same value, a changed setting a new one', () => {
    const a = checksum(base(...ON, ...TURN));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(checksum(base(...ON, ...TURN))).toBe(a);
    expect(checksum(base(...ON, ...TURN, 'media.turn.relayPortEnd=50400'))).not.toBe(a);
    expect(checksum(base(...ON, ...TURN, 'media.turn.tlsPort=0'))).not.toBe(a);
    expect(checksum(base(...ON))).not.toBe(a);
    expect(checksum(base(...ON, 'media.nodeIp=10.0.2.15'))).not.toBe(checksum(base(...ON)));
  });

  it('the /livekit Ingress covers every name of the site, like the main Ingress: a second domain gets the rule, one name is unchanged, a bare IP has no host', () => {
    const ing = (docs: K8sDoc[], name: string): K8sDoc => docs.find((d) => d.kind === 'Ingress' && d.metadata.name === name)!;
    const hosts = (d: K8sDoc): (string | undefined)[] => (d['spec'].rules as { host?: string }[]).map((r) => r.host);
    const one = base(...ON, 'domain=chat.example.test');
    expect(hosts(ing(one, 'manythreads-media'))).toEqual(['chat.example.test']);
    expect(ing(one, 'manythreads-media')['spec'].rules[0].http.paths).toEqual([{ path: '/livekit', pathType: 'Prefix', backend: { service: { name: 'manythreads-media', port: { name: 'signal' } } } }]);
    const two = base(...ON, 'domain=chat.example.test', 'extraDomains={other.example.test,chat.example.test}');
    expect(hosts(ing(two, 'manythreads-media'))).toEqual(hosts(ing(two, 'manythreads')));
    expect(hosts(ing(two, 'manythreads-media'))).toEqual(['chat.example.test', 'other.example.test']);
    const second = (ing(two, 'manythreads-media')['spec'].rules as { host: string; http: { paths: { path: string; backend: unknown }[] } }[])[1]!;
    expect(second.http.paths[0]).toMatchObject({ path: '/livekit', backend: { service: { name: 'manythreads-media' } } });
    // the strip-prefix Middleware is named by the Ingress, so it applies to the rule of the second domain too
    expect(ing(two, 'manythreads-media').metadata.annotations!['traefik.ingress.kubernetes.io/router.middlewares']).toBe('manythreads-manythreads-media-strip@kubernetescrd');
    expect(two.some((d) => d.kind === 'Middleware' && d.metadata.name === 'manythreads-media-strip' && d['spec'].stripPrefix.prefixes[0] === '/livekit')).toBe(true);
    // a bare IP address: one rule with no host (an Ingress cannot match on an address), as the main Ingress has
    const ip = base(...ON, 'domain=10.0.0.5');
    expect(hosts(ing(ip, 'manythreads-media'))).toEqual([undefined]);
    expect(hosts(ing(ip, 'manythreads'))).toEqual([undefined]);
  });

  it('with a certificate the media Ingress names the same hosts as the main one', () => {
    const docs = base(...ON, 'domain=chat.example.test', 'extraDomains={other.example.test}', 'tls.mode=letsencrypt', 'tls.wildcard=false', 'hermesPods.apps.routing=path');
    const tlsOf = (name: string) => docs.find((d) => d.kind === 'Ingress' && d.metadata.name === name)!['spec'].tls;
    expect(tlsOf('manythreads-media')).toEqual(tlsOf('manythreads'));
    expect(tlsOf('manythreads-media')[0].hosts).toEqual(['chat.example.test', 'other.example.test']);
  });

  it('the pod stays on the host network and signalling is the only Service port', () => {
    const docs = base(...ON, ...TURN);
    expect(deployment(docs)['spec'].template.spec.hostNetwork).toBe(true);
    const svc = docs.find((d) => d.kind === 'Service' && d.metadata.name === 'manythreads-media')!;
    expect(svc['spec'].ports).toEqual([{ name: 'signal', port: 7880, targetPort: 'signal' }]);
    expect(docs.filter((d) => d.kind === 'NetworkPolicy').map((d) => JSON.stringify(d['spec'].podSelector)).filter((s) => s.includes('media'))).toEqual([]);
  });

  it('NOTES.txt lists the ports to open, TURN included, and never 7880', () => {
    const notes = renderNotes([...ON, ...TURN, 'media.turn.tlsPort=0']);
    expect(notes).toContain('UDP 50000-50100');
    expect(notes).toContain('TCP 7881');
    expect(notes).toContain('UDP 3478 (TURN) and UDP 50101-50300');
    expect(notes).not.toContain('TURN over TLS');
    expect(notes).toContain('Do not open TCP 7880');
    expect(renderNotes()).not.toContain('Calls (voice and video rooms)');
  });

  it('the live release still renders as before: its own publicUrl and nodeIp, no TURN, only the checksum annotation is new', () => {
    const docs = render('live');
    const cfg = livekit(docs);
    expect(cfg).toContain('node_ip: "10.0.2.15"');
    expect(cfg).toContain('use_external_ip: false');
    expect(cfg).not.toContain('turn:');
    expect(cfg).not.toContain('advertise_internal_ip');
    expect(serverEnv(docs)['MANYTHREADS_LIVEKIT_URL']).toBe('wss://manythreads.kahf.to/livekit');
    expect(checksum(docs)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the install profile with calls off renders no media object; the profile itself does not turn calls on', () => {
    const docs = render('install', [CIDR, 'domain=203-0-113-10.sslip.io']);
    expect(docs.map(idOf).filter((i) => i.toLowerCase().includes('media'))).toEqual([]);
    const withCalls = render('install', [CIDR, 'domain=203-0-113-10.sslip.io', ...ON, ...TURN, 'media.turn.tlsPort=0']);
    expect(serverEnv(withCalls)['MANYTHREADS_LIVEKIT_URL']).toBe('wss://203-0-113-10.sslip.io/livekit');
    expect(livekit(withCalls)).not.toContain('tls_port');
  });
});
