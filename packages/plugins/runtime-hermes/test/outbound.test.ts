import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { OutboundBlockedError, assertAllowedUrl, checkAddress, checkHostName, createGuardedFetch, type Lookup } from '../src/outbound.ts';

// The guard for addresses a team lead types. Names and addresses are judged at every use; what a name resolves to is judged address by address.

const lookupTo = (...addresses: string[]): Lookup => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const none = {} as NodeJS.ProcessEnv;

describe('the default policy (no allow list)', () => {
  it.each([
    '127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1', '169.254.169.254', '169.254.0.5', 'fe80::1', '0.0.0.0', '224.0.0.1', '10.43.0.1', '10.96.0.1',
    '::ffff:a2b:1', '::ffff:10.43.0.1', '::7f00:1', '64:ff9b::7f00:1', '::ffff:7f00:1', '::ffff:a9fe:a9fe',
  ])('refuses the address %s', (address) => {
    expect(checkAddress(address, none)).not.toBeNull();
  });

  it.each(['10.42.0.1', '192.168.1.20', '172.16.5.5', 'fd12:3456::1', '93.184.216.34', '2606:4700::1111'])('allows the address %s', (address) => {
    expect(checkAddress(address, none)).toBeNull();
  });

  it('allows the live mode A address (the cni0 bridge, RFC 1918)', async () => {
    await expect(assertAllowedUrl(new URL('http://10.42.0.1:8642'), none)).resolves.toBeUndefined();
  });

  it.each(['localhost', 'a.localhost', 'kubernetes', 'kubernetes.default', 'kubernetes.default.svc', 'manythreads-postgres', 'manythreads-server', 'x.ns.svc.cluster.local', 'metadata.google.internal'])(
    'refuses the name %s',
    (host) => {
      expect(checkHostName(host, none)).not.toBeNull();
    },
  );

  it.each(['http://[::ffff:a2b:1]/', 'http://[::ffff:10.43.0.1]/', 'http://[::7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[::ffff:127.0.0.1]/'])('refuses the URL %s (the parser rewrites mapped addresses to hex)', async (url) => {
    await expect(assertAllowedUrl(new URL(url), none)).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('refuses the pod’s own API service address from the environment, mapped or not', () => {
    expect(checkAddress('::ffff:ac14:1', { KUBERNETES_SERVICE_HOST: '172.20.0.1' })).not.toBeNull();
    expect(checkAddress('172.20.0.1', { KUBERNETES_SERVICE_HOST: '172.20.0.1' })).not.toBeNull();
  });

  it('refuses a name that RESOLVES to loopback or to the metadata address, and a mixed answer', async () => {
    await expect(assertAllowedUrl(new URL('http://innocent.example/'), none, lookupTo('127.0.0.1'))).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(assertAllowedUrl(new URL('http://innocent.example/'), none, lookupTo('169.254.169.254'))).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(assertAllowedUrl(new URL('http://innocent.example/'), none, lookupTo('93.184.216.34', '::1'))).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(assertAllowedUrl(new URL('http://innocent.example/'), none, lookupTo('93.184.216.34'))).resolves.toBeUndefined();
  });
});

describe('the operator’s allow list', () => {
  const env = { MANYTHREADS_HERMES_ALLOWED_HOSTS: 'hermes.corp.example, *.hermes.example, 10.20.0.0/16, 127.0.0.1' } as NodeJS.ProcessEnv;

  it('allows only what is listed, and a listed entry overrides the denials', async () => {
    await expect(assertAllowedUrl(new URL('http://10.20.3.4:8642'), env)).resolves.toBeUndefined();
    await expect(assertAllowedUrl(new URL('http://127.0.0.1:8642'), env)).resolves.toBeUndefined();
    await expect(assertAllowedUrl(new URL('http://10.42.0.1:8642'), env)).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(assertAllowedUrl(new URL('http://93.184.216.34'), env)).rejects.toBeInstanceOf(OutboundBlockedError);
    await expect(assertAllowedUrl(new URL('http://hermes.corp.example/'), env, lookupTo('93.184.216.34'))).resolves.toBeUndefined();
    await expect(assertAllowedUrl(new URL('http://x.hermes.example/'), env, lookupTo('93.184.216.34'))).resolves.toBeUndefined();
    await expect(assertAllowedUrl(new URL('http://other.example/'), env, lookupTo('93.184.216.34'))).rejects.toBeInstanceOf(OutboundBlockedError);
  });

  it('a listed in-cluster name is allowed, but never to a link-local or loopback address it resolves to', async () => {
    const e = { MANYTHREADS_HERMES_ALLOWED_HOSTS: 'manythreads-hermes.ns.svc.cluster.local' } as NodeJS.ProcessEnv;
    await expect(assertAllowedUrl(new URL('http://manythreads-hermes.ns.svc.cluster.local:8642'), e, lookupTo('10.43.5.5'))).resolves.toBeUndefined();
    await expect(assertAllowedUrl(new URL('http://manythreads-hermes.ns.svc.cluster.local:8642'), e, lookupTo('169.254.169.254'))).rejects.toBeInstanceOf(OutboundBlockedError);
  });
});

describe('the guarded fetch', () => {
  const serve = async (): Promise<{ url: string; hits: () => number; close: () => void }> => {
    let hits = 0;
    const server = http.createServer((_req, res) => {
      hits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits: () => hits, close: () => server.close() };
  };

  it('never connects to a literal loopback address, and nothing arrives', async () => {
    const s = await serve();
    try {
      await expect(createGuardedFetch({ env: none })(s.url)).rejects.toBeInstanceOf(OutboundBlockedError);
      expect(s.hits()).toBe(0);
    } finally {
      s.close();
    }
  });

  it('refuses a hostname that resolves to 127.0.0.1 or to 169.254.169.254 at the moment of use, even if it resolved harmlessly before', async () => {
    const s = await serve();
    const port = new URL(s.url).port;
    let answer = '93.184.216.34';
    const guarded = createGuardedFetch({ env: none, lookup: async () => [{ address: answer, family: 4 }] });
    try {
      // first answer is public (not reachable from here, so the connect itself fails — but it is NOT blocked by policy)
      answer = '127.0.0.1';
      await expect(guarded(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(OutboundBlockedError);
      answer = '169.254.169.254';
      await expect(guarded(`http://rebind.example:${port}/`)).rejects.toBeInstanceOf(OutboundBlockedError);
      expect(s.hits()).toBe(0);
    } finally {
      s.close();
    }
  });

  it('connects when the operator lists the address, and refuses a redirect', async () => {
    const s = await serve();
    const env = { MANYTHREADS_HERMES_ALLOWED_HOSTS: '127.0.0.1' } as NodeJS.ProcessEnv;
    try {
      const res = await createGuardedFetch({ env })(s.url);
      expect(await res.text()).toBe('hello');
      const hop = http.createServer((_req, r) => {
        r.writeHead(302, { location: 'http://169.254.169.254/' });
        r.end();
      });
      await new Promise<void>((r) => hop.listen(0, '127.0.0.1', r));
      await expect(createGuardedFetch({ env })(`http://127.0.0.1:${(hop.address() as { port: number }).port}/`)).rejects.toThrow(/redirect/);
      hop.close();
    } finally {
      s.close();
    }
  });
});
