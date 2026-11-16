import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { haveHelm, idOf, render, renderRaw, type K8sDoc } from './chart.ts';

// P27-02: the values profile of the one-command install (values-install.yaml) plus the small file the installer writes (address, HTTPS choice, image digests, memory).
// `helm template` has no cluster, so the Kubernetes API address is given; the installer leaves it empty and the chart looks it up.

const here = dirname(fileURLToPath(import.meta.url));
const templates = resolve(here, '../../../templates');
const CIDR = 'hermesPods.apiServer.cidr=10.0.2.15/32';
const SSLIP = 'domain=203-0-113-10.sslip.io';
const byKind = (docs: K8sDoc[], kind: string): K8sDoc[] => docs.filter((d) => d.kind === kind);
const serverEnv = (docs: K8sDoc[]): Record<string, string> => {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!;
  const env = dep['spec'].template.spec.containers[0].env as { name: string; value?: string }[];
  return Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
};
const install = (...sets: string[]): K8sDoc[] => render('install', [CIDR, SSLIP, ...sets]);
/** The slug of every team template: a directory under templates/ that has a template.yaml and does not start with an underscore. */
const templateSlugs = (): string[] =>
  readdirSync(templates, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .filter((e) => readdirSync(join(templates, e.name)).includes('template.yaml'))
    .map((e) => e.name)
    .sort();

describe.skipIf(!haveHelm)('the install profile', () => {
  it('renders the platform and nothing a customer machine does not need', () => {
    const ids = install().map(idOf);
    for (const on of ['Cluster/-/manythreads-pg', 'Deployment/-/manythreads-server', 'Deployment/-/manythreads-web', 'Deployment/-/manythreads-litellm', 'Deployment/-/manythreads-hindsight', 'CronJob/-/manythreads-backup']) {
      expect(ids, on).toContain(on);
    }
    // no demo seed, no mail catcher, no in-cluster registry, no test stand-ins, no voice, no speech to text
    for (const off of ['seed', 'mailpit', 'registry', 'fake', 'demo', 'media', 'asr']) expect(ids.filter((i) => i.toLowerCase().includes(off)), off).toEqual([]);
  });

  it('gives every team template an apps namespace and lets a repository be copied from GitHub and GitLab', () => {
    const docs = install();
    const slugs = templateSlugs();
    expect(slugs).toEqual(['customer-support', 'engineering', 'marketing', 'product-design', 'research']);
    const namespaces = byKind(docs, 'Namespace').map((n) => n.metadata.name);
    for (const slug of slugs) expect(namespaces, slug).toContain(`apps-${slug}`);
    expect(serverEnv(docs)['MANYTHREADS_HERMES_PODS_REPO_ORIGIN_ALLOW']).toBe('https://github.com/,https://gitlab.com/');
  });

  it('keeps the agent pod off on a machine under 16 GB and turns it on at 16 GB or more', () => {
    const small = serverEnv(install());
    expect(small['MANYTHREADS_CLAUDE_PODS']).toBeUndefined();
    const large = serverEnv(install('claudePod.enabled=true'));
    expect(large['MANYTHREADS_CLAUDE_PODS']).toBe('1');
    expect(large['MANYTHREADS_CLAUDE_PODS_IMAGE']).toContain('claude-pod');
  });

  it('uses an image given as a digest as it is, and the release tag for a plain name', () => {
    const digest = 'ghcr.io/example/manythreads-server@sha256:' + 'a'.repeat(64);
    const docs = install(`server.image=${digest}`, 'web.image=ghcr.io/example/manythreads-web@sha256:' + 'b'.repeat(64), 'imageTag=v0.27.0');
    const image = (name: string) => (docs.find((d) => d.kind === 'Deployment' && d.metadata.name === name)!['spec'].template.spec.containers[0].image as string);
    expect(image('manythreads-server')).toBe(digest);
    expect(image('manythreads-web')).toBe('ghcr.io/example/manythreads-web@sha256:' + 'b'.repeat(64));
    const plain = render('install', [CIDR, SSLIP, 'imageTag=v0.27.0']);
    expect(plain.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!['spec'].template.spec.containers[0].image).toBe('manythreads/server:v0.27.0');
  });
});

describe.skipIf(!haveHelm)('HTTPS modes of the install profile', () => {
  const ingress = (docs: K8sDoc[]): K8sDoc => byKind(docs, 'Ingress')[0]!;

  it('http only (tls.mode none): an Ingress with no certificate and no issuer', () => {
    const docs = install('tls.mode=none', 'publicUrl=http://203.0.113.10');
    expect(byKind(docs, 'Issuer')).toEqual([]);
    expect(byKind(docs, 'Certificate')).toEqual([]);
    expect(ingress(docs)['spec'].tls).toBeUndefined();
    expect(serverEnv(docs)['MANYTHREADS_PUBLIC_URL']).toBe('http://203.0.113.10');
  });

  it('Let\'s Encrypt for an sslip.io name or a name of the admin\'s own: HTTP challenge, one certificate for the name', () => {
    for (const domain of ['203-0-113-10.sslip.io', 'team.example.com']) {
      const docs = render('install', [CIDR, `domain=${domain}`, 'tls.mode=letsencrypt', 'tls.letsencrypt.email=me@example.com']);
      const issuer = byKind(docs, 'Issuer')[0]!;
      expect(issuer['spec'].acme.server).toBe('https://acme-v02.api.letsencrypt.org/directory');
      expect(issuer['spec'].acme.solvers[0].http01.ingress.ingressClassName).toBe('traefik');
      const cert = byKind(docs, 'Certificate')[0]!;
      expect(cert['spec'].dnsNames).toEqual([domain]);
      expect(ingress(docs)['spec'].tls[0]).toEqual({ hosts: [domain], secretName: 'manythreads-tls' });
    }
  });

  it('Let\'s Encrypt staging is a choice (the installer tries it first)', () => {
    const docs = install('tls.mode=letsencrypt', 'tls.letsencrypt.server=staging');
    expect(byKind(docs, 'Issuer')[0]!['spec'].acme.server).toContain('acme-staging-v02');
  });

  it('a custom name mapped later keeps the first name working and shares the certificate', () => {
    const docs = render('install', [CIDR, 'domain=team.example.com', 'extraDomains={203-0-113-10.sslip.io}', 'tls.mode=letsencrypt']);
    expect(byKind(docs, 'Certificate')[0]!['spec'].dnsNames).toEqual(['team.example.com', '203-0-113-10.sslip.io']);
    const rules = ingress(docs)['spec'].rules as { host: string }[];
    expect(rules.map((r) => r.host)).toEqual(['team.example.com', '203-0-113-10.sslip.io']);
    expect(ingress(docs)['spec'].tls[0].hosts).toEqual(['team.example.com', '203-0-113-10.sslip.io']);
    expect(serverEnv(docs)['MANYTHREADS_PUBLIC_URL']).toBe('https://team.example.com');
  });

  it('self-signed on a bare address: a certificate for the address, an Ingress that answers any host', () => {
    const docs = render('install', [CIDR, 'domain=203.0.113.10', 'tls.mode=selfsigned']);
    expect(byKind(docs, 'Issuer')[0]!['spec'].selfSigned).toEqual({});
    const cert = byKind(docs, 'Certificate')[0]!;
    expect(cert['spec'].ipAddresses).toEqual(['203.0.113.10']);
    expect(cert['spec'].dnsNames).toBeUndefined();
    expect(cert['spec'].duration).toBe('87600h');
    expect(cert['spec'].secretName).toBe('manythreads-tls');
    const spec = ingress(docs)['spec'];
    expect(spec.rules[0].host).toBeUndefined();
    expect(spec.tls[0]).toEqual({ secretName: 'manythreads-tls' });
    // Traefik's default certificate is this one, so the apps namespaces answer with it too
    expect(byKind(docs, 'TLSStore')[0]!['spec'].defaultCertificate.secretName).toBe('manythreads-tls');
    expect(serverEnv(docs)['MANYTHREADS_PUBLIC_URL']).toBe('https://203.0.113.10');
  });

  it('self-signed for a name adds the name and any addresses', () => {
    const docs = render('install', [CIDR, 'domain=box.lan', 'tls.mode=selfsigned', 'tls.selfSigned.ipAddresses={10.0.0.5}']);
    const cert = byKind(docs, 'Certificate')[0]!;
    expect(cert['spec'].dnsNames).toEqual(['box.lan']);
    expect(cert['spec'].ipAddresses).toEqual(['10.0.0.5']);
  });

  it('Cloudflare with an origin certificate: no issuer, the Origin CA Secret on the Ingress', () => {
    const docs = install('tls.mode=cloudflare');
    expect(byKind(docs, 'Issuer')).toEqual([]);
    expect(ingress(docs)['spec'].tls[0].secretName).toBe('manythreads-origin-cert');
  });

  it('refuses a mode it does not know with a plain message', () => {
    const r = renderRaw('install', [CIDR, 'tls.mode=acme']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('selfsigned');
  });

  it('the idiom of the other values files still renders: live values with letsencrypt carry the one name', () => {
    const docs = render('live', ['tls.mode=letsencrypt', 'tls.letsencrypt.email=a@b.c', 'tls.wildcard=false']);
    expect(byKind(docs, 'Certificate')[0]!['spec'].dnsNames).toEqual(['manythreads.kahf.to']);
  });
});

describe('the profile file', () => {
  it('names no image (the installer\'s file does, by digest) and no live address', () => {
    const text = readFileSync(resolve(here, '../manythreads/values-install.yaml'), 'utf8');
    expect(text.split('\n').filter((l) => /^\s*image\s*:/.test(l))).toEqual([]);
    expect(text).not.toMatch(/kahf/i);
  });
});
