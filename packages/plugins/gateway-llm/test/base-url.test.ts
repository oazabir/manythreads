import { describe, expect, it } from 'vitest';
import { providerBaseProblem } from '../src/base-url.ts';

// Review M5: where an admin-entered provider base URL may point. DNS is a stand-in so the test needs no network.

const names: Record<string, string[]> = {
  'api.z.ai': ['203.0.113.7'],
  'sneaky.example.com': ['169.254.169.254'],
  'internal.example.com': ['10.43.0.17'],
  'rebind.example.com': ['203.0.113.7', '127.0.0.1'],
  'gpu-box.lan': ['192.168.1.20'],
  'v6.example.com': ['::ffff:10.0.0.5'],
};
const lookup = async (host: string) => {
  const hit = names[host];
  if (!hit) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
  return hit.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const problem = (base: string, local = false) => providerBaseProblem(base, local, lookup);

describe('a provider that is not marked local', () => {
  it('accepts a public address and a name that resolves to one, and a name that does not resolve at all', async () => {
    for (const base of ['https://api.z.ai/api/coding/paas/v4', 'https://203.0.113.7/v1', 'https://openrouter.ai/api/v1', 'http://api.z.ai/v1']) expect(await problem(base), base).toBeNull();
  });
  it.each([
    ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
    ['the metadata address as a name that resolves to it', 'https://sneaky.example.com/'],
    ['the metadata service by name', 'http://metadata.google.internal/computeMetadata/v1/'],
    ['the IPv6 metadata address', 'http://[fd00:ec2::254]/'],
    ['loopback', 'http://127.0.0.1:11434'],
    ['loopback written as a name', 'http://localhost:11434'],
    ['loopback in IPv6', 'http://[::1]:8080'],
    ['a private address', 'http://10.0.4.7:11434'],
    ['a private address on 192.168', 'http://192.168.1.20/v1'],
    ['a private address on 172.16', 'http://172.20.0.4/v1'],
    ['the cluster API service address', 'https://10.43.0.1/'],
    ['a name of this deployment', 'http://manythreads-server.manythreads.svc.cluster.local:3000'],
    ['an in-cluster service name', 'http://ollama.models.svc:11434'],
    ['a name that resolves to a private address', 'https://internal.example.com/'],
    ['a name that resolves to a private address on the local network', 'http://gpu-box.lan:11434'],
    ['a name with one private address among public ones (DNS rebinding)', 'https://rebind.example.com/'],
    ['an IPv4-mapped IPv6 private address', 'http://[::ffff:10.0.0.5]/'],
    ['an IPv4-mapped IPv6 address in hex', 'http://[::ffff:a00:5]/'],
    ['a name that resolves to a mapped private address', 'https://v6.example.com/'],
  ])('refuses %s', async (_what, base) => {
    expect(await problem(base), base).toMatch(/cannot be used/);
  });
  it('refuses a scheme other than http and https, and a key inside the address', async () => {
    expect(await problem('file:///etc/passwd')).toMatch(/must start with https/);
    expect(await problem('gopher://api.z.ai/')).toMatch(/must start with https/);
    expect(await problem('https://user:secret@api.z.ai/')).toMatch(/key out of the address/);
  });
});

describe('a provider marked as running inside this deployment', () => {
  it('may use loopback, the private ranges and in-cluster names', async () => {
    for (const base of ['http://localhost:11434', 'http://127.0.0.1:11434', 'http://10.0.4.7:11434', 'http://192.168.1.20/v1', 'http://ollama.models.svc:11434', 'http://gpu-box.lan:11434', 'http://internal.example.com/']) {
      expect(await problem(base, true), base).toBeNull();
    }
  });
  it('never gets link-local, the metadata services or the cluster API', async () => {
    for (const base of ['http://169.254.169.254/', 'https://sneaky.example.com/', 'http://metadata.google.internal/', 'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'https://10.43.0.1/', 'http://0.0.0.0:8080', 'http://224.0.0.1/']) {
      expect(await problem(base, true), base).toMatch(/never allowed|cannot be used/);
    }
  });
});
