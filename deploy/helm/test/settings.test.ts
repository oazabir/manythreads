import { describe, expect, it } from 'vitest';
import { haveHelm, idOf, render, renderNotes, renderRaw, type K8sDoc } from './chart.ts';
import { allows, type Peer, type Pod } from './netpol.ts';

// P10-07 and P10-08 acceptance, the settings that are not the default: backup to object storage, a RuntimeClass, a team's proxy, the OpenTelemetry environment, NOTES.txt.

const BASE_SET = ['hermesPods.apiServer.cidr=10.0.2.15/32'];
const STORE = ['postgres.objectStore.enabled=true', 'postgres.objectStore.bucket=mt-backups', 'postgres.objectStore.existingSecret=mt-store', 'postgres.objectStore.endpoint=https://s3.example.test'];
const byKind = (docs: K8sDoc[], kind: string): K8sDoc[] => docs.filter((d) => d.kind === kind);
const serverEnv = (docs: K8sDoc[]): Record<string, string> => {
  const dep = docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'manythreads-server')!;
  const env = dep['spec'].template.spec.containers[0].env as { name: string; value?: string }[];
  return Object.fromEntries(env.filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
};

describe.skipIf(!haveHelm)('backup to object storage (postgres.objectStore)', () => {
  it('is off by default: no ObjectStore, no ScheduledBackup, no plug-in on the Cluster', () => {
    const docs = render('live');
    expect(byKind(docs, 'ObjectStore')).toEqual([]);
    expect(byKind(docs, 'ScheduledBackup')).toEqual([]);
    expect(byKind(docs, 'Cluster')[0]!['spec'].plugins).toBeUndefined();
  });

  it('renders the ObjectStore, the plug-in entry that archives the log, and a ScheduledBackup through the plug-in', () => {
    const docs = render('live', STORE);
    const store = byKind(docs, 'ObjectStore')[0]!;
    expect(store.apiVersion).toBe('barmancloud.cnpg.io/v1');
    expect(store['spec'].configuration.destinationPath).toBe('s3://mt-backups/');
    expect(store['spec'].configuration.endpointURL).toBe('https://s3.example.test');
    expect(store['spec'].configuration.s3Credentials.accessKeyId).toEqual({ name: 'mt-store', key: 'access-key' });
    expect(store['spec'].configuration.s3Credentials.secretAccessKey).toEqual({ name: 'mt-store', key: 'secret-key' });
    expect(store['spec'].retentionPolicy).toBe('30d');
    const cluster = byKind(docs, 'Cluster')[0]!;
    expect(cluster['spec'].plugins).toEqual([{ name: 'barman-cloud.cloudnative-pg.io', isWALArchiver: true, parameters: { barmanObjectName: store.metadata.name } }]);
    const sb = byKind(docs, 'ScheduledBackup')[0]!;
    expect(sb['spec'].method).toBe('plugin');
    expect(sb['spec'].pluginConfiguration.name).toBe('barman-cloud.cloudnative-pg.io');
    expect(sb['spec'].cluster.name).toBe(cluster.metadata.name);
    // CloudNativePG's schedule has a seconds field: the usual five-field line is given a "0" in front
    expect(sb['spec'].schedule).toBe('0 0 2 * * *');
    // the nightly dump stays
    expect(idOf(docs.find((d) => d.kind === 'CronJob')!)).toBe('CronJob/-/manythreads-backup');
  });

  it('refuses a half-made setting with a plain message', () => {
    for (const [drop, text] of [
      ['postgres.objectStore.bucket=', 'objectStore.bucket'],
      ['postgres.objectStore.existingSecret=', 'existingSecret'],
      ['postgres.objectStore.retention=forever', 'retention'],
      ['postgres.mode=statefulset', 'postgres.mode=cnpg'],
    ] as const) {
      const r = renderRaw('live', [...STORE, drop]);
      expect(r.code, drop).not.toBe(0);
      expect(r.err, drop).toContain(text);
    }
  });

  it('keeps a six-field schedule as it is', () => {
    const docs = render('live', [...STORE, 'postgres.objectStore.schedule=30 15 3 * * *']);
    expect(byKind(docs, 'ScheduledBackup')[0]!['spec'].schedule).toBe('30 15 3 * * *');
  });
});

describe.skipIf(!haveHelm)('the hindsight database object', () => {
  it('adopts the existing database: present, owned by the hindsight role, kept when removed', () => {
    const db = byKind(render('live'), 'Database')[0]!;
    expect(db['spec']).toMatchObject({ cluster: { name: 'manythreads-pg' }, name: 'hindsight', owner: 'hindsight', ensure: 'present', databaseReclaimPolicy: 'retain' });
  });
  it('is not rendered where Hindsight is off, or when asked not to', () => {
    expect(byKind(render('ci'), 'Database')).toEqual([]);
    expect(byKind(render('live', ['hindsight.database.object=false']), 'Database')).toEqual([]);
  });
});

describe.skipIf(!haveHelm)('RuntimeClass (gVisor where present)', () => {
  it('is empty by default: the pods run on the cluster default', () => {
    const env = serverEnv(render('live'));
    expect(env['MANYTHREADS_HERMES_PODS_RUNTIME_CLASS_NAME']).toBe('');
  });

  it('a class the cluster lacks stops the render with a plain message that names the value and the way out', () => {
    // `helm template` has no cluster, so the look-up finds no class: the same thing an install on a cluster without gVisor sees
    const r = renderRaw('live', ['hermesPods.runtimeClassName=gvisor']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('hermesPods.runtimeClassName is "gvisor"');
    expect(r.err).toContain('no RuntimeClass of that name');
    expect(r.err).toContain('leave hermesPods.runtimeClassName empty');
  });

  it('the same for the Claude pods, when they are turned on', () => {
    const r = renderRaw('live', ['claudePod.enabled=true', 'claudePod.runtimeClassName=gvisor']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('claudePod.runtimeClassName is "gvisor"');
  });

  it('with the check switched off (no cluster to ask) the name reaches the server for both kinds of pod', () => {
    const env = serverEnv(render('live', ['hermesPods.runtimeClassName=gvisor', 'hermesPods.runtimeClassCheck=false', 'claudePod.enabled=true', 'claudePod.runtimeClassName=gvisor-2']));
    expect(env['MANYTHREADS_HERMES_PODS_RUNTIME_CLASS_NAME']).toBe('gvisor');
    expect(env['MANYTHREADS_CLAUDE_PODS_RUNTIME_CLASS_NAME']).toBe('gvisor-2');
  });

  it('a name that is not a RuntimeClass name is refused whatever the check says', () => {
    const r = renderRaw('live', ['hermesPods.runtimeClassName=bad name;rm', 'hermesPods.runtimeClassCheck=false']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('not a valid RuntimeClass name');
  });
});

describe.skipIf(!haveHelm)("a team's proxy (hermesPods.teamProxies)", () => {
  const ENG = ['hermesPods.teamProxies[0].team=engineering', 'hermesPods.teamProxies[0].cidrs={203.0.113.10/32}', 'hermesPods.teamProxies[0].port=3128'];
  const BOTS = 'manythreads-bots';
  const pod = (extra: Record<string, string> = {}): Pod => ({ ns: BOTS, labels: { 'app.kubernetes.io/name': 'manythreads', 'app.kubernetes.io/component': 'hermes-pod', 'manythreads.io/team': 'engineering', ...extra } });
  const out = (ip: string): Peer => ({ ip });

  it('without a proxy every team keeps the public internet on 80 and 443, and nothing else (as before)', () => {
    const docs = render('live');
    const can = (from: Pod, ip: string, port: number): boolean => allows(docs, 'manythreads', { pod: from }, out(ip), port);
    expect(can(pod(), '93.184.216.34', 443)).toBe(true);
    expect(can(pod(), '93.184.216.34', 80)).toBe(true);
    expect(can(pod(), '93.184.216.34', 22)).toBe(false);
    expect(can(pod(), '10.1.2.3', 443)).toBe(false); // private addresses stay shut
  });

  it('a team with a proxy reaches only the proxy address and port outside the cluster; other teams are unchanged', () => {
    const docs = render('live', ENG);
    const can = (from: Pod, ip: string, port: number): boolean => allows(docs, 'manythreads', { pod: from }, out(ip), port);
    const proxied = pod({ 'manythreads.io/egress': 'proxy' });
    expect(can(proxied, '203.0.113.10', 3128)).toBe(true);
    expect(can(proxied, '203.0.113.10', 443)).toBe(false);
    expect(can(proxied, '203.0.113.11', 3128)).toBe(false);
    expect(can(proxied, '93.184.216.34', 443)).toBe(false);
    expect(can(proxied, '93.184.216.34', 80)).toBe(false);
    // the platform inside the cluster stays reachable: the Kubernetes API and the server
    expect(can(proxied, '10.0.2.15', 6443)).toBe(true);
    expect(allows(docs, 'manythreads', { pod: proxied }, { pod: { ns: 'manythreads', labels: { 'app.kubernetes.io/component': 'server' } } }, 3000)).toBe(true);
    // a pod of another team, or the same team without the label, is not touched
    expect(can(pod({ 'manythreads.io/team': 'marketing' }), '93.184.216.34', 443)).toBe(true);
    expect(can(pod(), '93.184.216.34', 443)).toBe(true);
    // and a proxy listed for one team gives another team's proxied pod nothing
    expect(can(pod({ 'manythreads.io/team': 'marketing', 'manythreads.io/egress': 'proxy' }), '203.0.113.10', 3128)).toBe(false);
  });

  it('a team with a proxy and no entry in the chart reaches nothing outside the cluster (fails closed)', () => {
    const docs = render('live');
    const proxied = pod({ 'manythreads.io/egress': 'proxy' });
    expect(allows(docs, 'manythreads', { pod: proxied }, out('93.184.216.34'), 443)).toBe(false);
    expect(allows(docs, 'manythreads', { pod: proxied }, out('203.0.113.10'), 3128)).toBe(false);
  });

  it('refuses an entry that would open the internet or is not an address', () => {
    for (const [cidr, text] of [
      ['0.0.0.0/0', 'whole internet'],
      ['10.0.0.0/0', 'whole internet'],
      ['proxy.example.com', 'not an IPv4 address'],
      ['203.0.113.10', 'not an IPv4 address'],
    ] as const) {
      const r = renderRaw('live', ['hermesPods.teamProxies[0].team=engineering', `hermesPods.teamProxies[0].cidrs={${cidr}}`]);
      expect(r.code, cidr).not.toBe(0);
      expect(r.err, cidr).toContain(text);
    }
    expect(renderRaw('live', ['hermesPods.teamProxies[0].team=engineering']).err).toContain('needs at least one address');
  });
});

describe.skipIf(!haveHelm)('OpenTelemetry', () => {
  it('is off while no endpoint is set: the server gets neither variable', () => {
    const env = serverEnv(render('live'));
    expect(Object.keys(env).filter((k) => k.includes('OTEL'))).toEqual([]);
  });
  it('with an endpoint the server gets the endpoint and the sample ratio', () => {
    const env = serverEnv(render('live', ['server.otel.endpoint=http://otel-collector:4318', 'server.otel.sampleRatio=0.25']));
    expect(env['MANYTHREADS_OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://otel-collector:4318');
    expect(env['MANYTHREADS_OTEL_SAMPLE_RATIO']).toBe('0.25');
  });
  it('the sample ratio defaults to everything', () => {
    expect(serverEnv(render('live', ['server.otel.endpoint=http://c:4318']))['MANYTHREADS_OTEL_SAMPLE_RATIO']).toBe('1');
  });
});

describe.skipIf(!haveHelm)('NOTES.txt', () => {
  it('tells the UNLOGGED rule and the restore recipe', () => {
    const notes = renderNotes();
    expect(notes).toContain('UNLOGGED');
    expect(notes).toContain('EMPTY after a failover');
    expect(notes).toContain('tools/backup/restore.sh');
    expect(notes).toContain('Continuous backup (point-in-time restore) is OFF');
  });
  it('with the object store on, gives the point-in-time recipe and says it was not tried on a cluster', () => {
    const notes = renderNotes(STORE);
    expect(notes).toContain('barman-cloud.cloudnative-pg.io');
    expect(notes).toContain('recoveryTarget');
    expect(notes).toContain('NOT tried on a cluster');
  });
  it('says what one instance means', () => {
    expect(renderNotes()).toContain('no standby');
    expect(renderNotes(['postgres.instances=3'])).toContain('a standby takes over');
  });
});

describe.skipIf(!haveHelm)('the base values need the API address, and say so', () => {
  it('a bare render fails with the message that names the value (a real install looks the address up)', () => {
    const r = renderRaw('base');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('hermesPods.apiServer.cidr is required');
    expect(renderRaw('base', BASE_SET).code).toBe(0);
  });
});
