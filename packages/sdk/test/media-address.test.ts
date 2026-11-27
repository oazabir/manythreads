import { describe, expect, it } from 'vitest';
import { mediaAddressFor, requestOriginOf } from '../src/index.ts';

// The address a person's browser connects to for a call (PLAN P38-11): the same-origin path form follows the origin the request came in on (so a second domain or
// a local IP is not blocked by `connect-src 'self'`); an address on a host of its own, or no usable request origin, comes back as configured.

const SITE = 'https://manythreads.example.org';
const PATH_FORM = 'wss://manythreads.example.org/livekit';

describe('requestOriginOf (what the request came in on)', () => {
  it('joins the scheme and the host, lower-cased, with a port when there is one', () => {
    expect(requestOriginOf('https', 'Manythreads.Example.org')).toBe('https://manythreads.example.org');
    expect(requestOriginOf('http', '10.0.0.5:3000')).toBe('http://10.0.0.5:3000');
    expect(requestOriginOf('https', '[::1]:8443')).toBe('https://[::1]:8443');
    expect(requestOriginOf('http', 'localhost')).toBe('http://localhost');
  });
  it('refuses anything that is not a plain host: a path, a user, spaces, a wrong scheme, a port out of range', () => {
    for (const host of ['evil.example/x', 'a@b.example', 'a b.example', 'a.example#x', 'a.example?x', '', '-a.example', 'a..example', 'a.example:99999', 'a.example:']) {
      expect(requestOriginOf('https', host), host).toBeUndefined();
    }
    expect(requestOriginOf('ftp', 'a.example')).toBeUndefined();
    expect(requestOriginOf('javascript', 'a.example')).toBeUndefined();
    expect(requestOriginOf(undefined, 'a.example')).toBeUndefined();
    expect(requestOriginOf('https', undefined)).toBeUndefined();
  });
});

describe('mediaAddressFor, the same-origin path form', () => {
  it('on the site itself the address is the configured one', () => {
    expect(mediaAddressFor(PATH_FORM, 'https://manythreads.example.org', SITE)).toBe(PATH_FORM);
  });
  it('follows a second domain over https (wss, same path)', () => {
    expect(mediaAddressFor(PATH_FORM, 'https://team.other.example', SITE)).toBe('wss://team.other.example/livekit');
  });
  it('follows a local IP with a port over https, and an http page gets ws', () => {
    expect(mediaAddressFor(PATH_FORM, 'https://10.0.0.5:8443', SITE)).toBe('wss://10.0.0.5:8443/livekit');
    expect(mediaAddressFor(PATH_FORM, 'http://192.168.1.20:3000', SITE)).toBe('ws://192.168.1.20:3000/livekit');
    expect(mediaAddressFor(PATH_FORM, 'http://localhost:3000', SITE)).toBe('ws://localhost:3000/livekit');
  });
  it('keeps a deeper path, drops a trailing slash and keeps a query', () => {
    expect(mediaAddressFor('wss://manythreads.example.org/media/livekit/', 'https://x.example', SITE)).toBe('wss://x.example/media/livekit');
    expect(mediaAddressFor('wss://manythreads.example.org/livekit?a=1', 'https://x.example', SITE)).toBe('wss://x.example/livekit?a=1');
  });
  it('on the site itself the scheme is not guessed: a proxy that did not say https changes nothing', () => {
    expect(mediaAddressFor(PATH_FORM, 'http://manythreads.example.org', SITE)).toBe(PATH_FORM);
  });
  it('without a known site address nothing is rewritten', () => {
    expect(mediaAddressFor(PATH_FORM, 'https://x.example', undefined)).toBe(PATH_FORM);
  });
});

describe('mediaAddressFor, everything else is returned unchanged', () => {
  it('a media server on a host of its own', () => {
    expect(mediaAddressFor('wss://media.example.org', 'https://team.other.example', SITE)).toBe('wss://media.example.org');
    expect(mediaAddressFor('wss://media.example.org:7881', 'https://10.0.0.5', SITE)).toBe('wss://media.example.org:7881');
  });
  it('a path on another host than the site', () => {
    expect(mediaAddressFor('wss://media.example.org/livekit', 'https://team.other.example', SITE)).toBe('wss://media.example.org/livekit');
  });
  it('an untrusted or malformed request origin', () => {
    for (const origin of [undefined, '', 'https://evil.example/x', 'https://a@evil.example', 'javascript://x', 'wss://x.example', 'not a url', 'https://x.example:99999']) {
      expect(mediaAddressFor(PATH_FORM, origin, SITE), String(origin)).toBe(PATH_FORM);
    }
  });
  it('a configured address that is not a websocket address or does not parse', () => {
    expect(mediaAddressFor('https://manythreads.example.org/livekit', 'https://x.example', SITE)).toBe('https://manythreads.example.org/livekit');
    expect(mediaAddressFor('nonsense', 'https://x.example', SITE)).toBe('nonsense');
  });
  it('a site address that does not parse', () => {
    expect(mediaAddressFor(PATH_FORM, 'https://x.example', 'nonsense')).toBe(PATH_FORM);
  });
});
