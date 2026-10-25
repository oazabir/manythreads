import { describe, expect, it } from 'vitest';
import { appHostPattern, currentOptionId, describeMode, switchOptions } from '../src/screens/https/commands';

const mode = (m: 'none' | 'cloudflare' | 'letsencrypt', origin: 'strict' | 'flexible' | null = null, acmeServer: 'production' | 'staging' | null = null) => ({
  mode: m, origin, wildcard: false, acmeServer,
});

describe('Domain & HTTPS commands', () => {
  it('offers every mode except the current one, with the exact deploy command', () => {
    const cmds = Object.fromEntries(switchOptions(mode('none')).map((o) => [o.id, o.command]));
    expect(cmds).toEqual({
      'cloudflare-strict': 'tools/devbox/deploy.sh --tls cloudflare --cf-origin strict --origin-cert origin.pem --origin-key origin.key',
      'cloudflare-flexible': 'tools/devbox/deploy.sh --tls cloudflare --cf-origin flexible',
      letsencrypt: 'tools/devbox/deploy.sh --tls letsencrypt --acme-email you@example.com --dns-token-file dns-token.txt',
    });
    expect(switchOptions(mode('cloudflare', 'strict')).map((o) => o.id)).toEqual(['cloudflare-flexible', 'letsencrypt', 'none']);
    expect(switchOptions(mode('letsencrypt', null, 'production')).find((o) => o.id === 'none')?.command).toBe('tools/devbox/deploy.sh --tls none');
  });
  it('names the current mode in plain words', () => {
    expect(currentOptionId(mode('cloudflare', 'flexible'))).toBe('cloudflare-flexible');
    expect(describeMode(mode('cloudflare', 'strict'))).toMatch(/^Cloudflare proxy, Full \(strict\): Cloudflare serves visitors/);
    expect(describeMode(mode('letsencrypt', null, 'staging'))).toContain('test certificates');
  });
  it('does not ask for a DNS token when apps are served by path', () => {
    const p = { ...mode('none'), appsRouting: 'path' as const };
    expect(switchOptions(p).find((o) => o.id === 'letsencrypt')?.command).toBe('tools/devbox/deploy.sh --tls letsencrypt --acme-email you@example.com');
    expect(describeMode({ ...mode('letsencrypt', null, 'production'), appsRouting: 'path' })).toContain('no wildcard certificate');
    expect(switchOptions({ ...mode('none'), appsRouting: 'host' }).find((o) => o.id === 'letsencrypt')?.command).toContain('--dns-token-file');
  });
  it('shows the path address pattern', () => {
    expect(appHostPattern('example.com', 'path')).toBe('https://example.com/apps/<team>/<app>/');
  });
  it('shows the app address pattern', () => {
    expect(appHostPattern('apps.example.com')).toBe('<app>--<team>.apps.example.com');
    expect(appHostPattern(null)).toBeNull();
  });
});
