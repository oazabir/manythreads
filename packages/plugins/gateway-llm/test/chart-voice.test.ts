import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// P15-07: the speech-to-text server and the voice-room settings in the chart. `helm template` (skipped where helm is absent): off means no trace, on renders the workload.

const chart = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../deploy/helm/manythreads');
const haveHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const render = (files: string[], extra: string[] = []): { code: number; out: string } => {
  // the Hermes pod controller is on in the base values and needs the Kubernetes API address, which `helm template` cannot look up (P10-07)
  const args = ['template', 't', chart, '-n', 'manythreads', ...files.flatMap((f) => ['-f', resolve(chart, f)]), '--set', 'hermesPods.apiServer.cidr=10.0.2.15/32', ...extra];
  const r = spawnSync('helm', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
};
const docsOf = (out: string, kind: string): string[] => out.split(/^---$/m).filter((d) => new RegExp(`^kind: ${kind}$`, 'm').test(d));
const named = (out: string, kind: string, name: string): string | undefined => docsOf(out, kind).find((d) => new RegExp(`^  name: ${name}$`, 'm').test(d));

describe.skipIf(!haveHelm)('the chart: speech to text and voice rooms (P15-07)', () => {
  it('defaults render neither the speech-to-text server nor the media server', () => {
    const r = render([]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/manythreads-asr|manythreads-media|NOTETAKER_MAX_ROOMS/);
  });

  it('asr.enabled renders one Deployment and one Service on 8000, with the model inside the image (offline) and no outside address needed', () => {
    const r = render([], ['--set', 'asr.enabled=true', '--set', 'asr.image=manythreads/asr:abc']);
    expect(r.code, r.out).toBe(0);
    const dep = named(r.out, 'Deployment', 'manythreads-asr')!;
    expect(dep).toContain('image: manythreads/asr:abc');
    expect(dep).toContain('containerPort: 8000');
    expect(dep).toContain('HF_HUB_OFFLINE');
    expect(dep).toContain('path: /health');
    expect(dep).toContain('runAsNonRoot: true');
    expect(dep).not.toContain('hostNetwork');
    expect(named(r.out, 'Service', 'manythreads-asr')).toContain('port: 8000');
    expect(r.out).not.toContain('manythreads-media');
  });

  it('the live values turn both on: signalling on /livekit through a stripPrefix Middleware, NAT address, and the asr workload', () => {
    const r = render(['values-live.yaml']);
    expect(r.code, r.out).toBe(0);
    expect(named(r.out, 'Deployment', 'manythreads-asr')).toBeDefined();
    const mw = named(r.out, 'Middleware', 'manythreads-media-strip')!;
    expect(mw).toContain('/livekit');
    const ing = named(r.out, 'Ingress', 'manythreads-media')!;
    expect(ing).toContain('path: /livekit');
    expect(ing).toContain('manythreads-media-strip@kubernetescrd');
    expect(ing).toContain('manythreads-media');
    const cfg = named(r.out, 'ConfigMap', 'manythreads-media-config')!;
    expect(cfg).toContain('node_ip: "10.0.2.15"');
    expect(cfg).toContain('use_external_ip: false');
    expect(cfg).toContain('max_participants: 25');
    expect(r.out).toContain('MANYTHREADS_NOTETAKER_MAX_ROOMS');
  });

  it('media without ingressPath adds no Middleware or second Ingress; turn.enabled adds the UDP port', () => {
    const r = render([], ['--set', 'media.enabled=true', '--set', 'media.publicUrl=wss://media.example.org', '--set', 'media.turn.enabled=true', '--set', 'media.turn.domain=turn.example.org']);
    expect(r.code, r.out).toBe(0);
    expect(named(r.out, 'Middleware', 'manythreads-media-strip')).toBeUndefined();
    expect(named(r.out, 'Ingress', 'manythreads-media')).toBeUndefined();
    const cfg = named(r.out, 'ConfigMap', 'manythreads-media-config')!;
    expect(cfg).toContain('use_external_ip: true');
    expect(cfg).not.toContain('node_ip');
    expect(cfg).toContain('udp_port: 3478');
  });

  it('the CI release keeps both off', () => {
    const r = render(['values-ci.yaml']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toMatch(/manythreads-asr|manythreads-media/);
  });

  it('a media path without a leading slash is refused', () => {
    const r = render([], ['--set', 'media.enabled=true', '--set', 'media.publicUrl=wss://x', '--set', 'media.ingressPath=livekit']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('media.ingressPath must start with /');
  });
});
