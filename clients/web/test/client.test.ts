import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, buildPath, createApiClient, readCookie, type Transport, type TransportRequest } from '../src/api/client';

const Item = z.object({ id: z.string(), n: z.number() });
const NewItem = z.object({ n: z.number().int().min(1, 'n must be at least 1') }).strict();
const getRoute = { method: 'GET', path: '/api/items/:id' } as const;
const postRoute = { method: 'POST', path: '/api/items' } as const;

function setup(respond: (req: TransportRequest) => { status: number; body?: unknown } | Promise<never>, cookie = 'a=1; manythreads_csrf=tok%2F123; b=2') {
  const seen: TransportRequest[] = [];
  const transport: Transport = async (req) => {
    seen.push(req);
    const r = await respond(req);
    return { status: r.status, body: r.body };
  };
  const onSessionExpired = vi.fn();
  const api = createApiClient({ transport, cookies: () => cookie, onSessionExpired });
  return { api, seen, onSessionExpired };
}

describe('api client: parsing', () => {
  it('parses the request before sending and the response after receiving', async () => {
    const { api, seen } = setup(() => ({ status: 200, body: { id: 'x', n: 3, extra: 'dropped' } }));
    const out = await api.call(postRoute, { request: NewItem, response: Item }, { n: 3 });
    expect(out).toEqual({ id: 'x', n: 3 });
    expect(seen[0]?.body).toBe('{"n":3}');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
    expect(seen[0]?.credentials).toBe('include');
  });

  it('fails early on an invalid request without calling the transport', async () => {
    const { api, seen } = setup(() => ({ status: 200, body: {} }));
    const err = await api.call(postRoute, { request: NewItem, response: Item }, { n: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'validation_failed', message: 'n must be at least 1', path: ['n'], status: 0 });
    expect(seen).toHaveLength(0);
  });

  it('rejects a response that does not match its schema', async () => {
    const { api } = setup(() => ({ status: 200, body: { id: 1 } }));
    await expect(api.call(getRoute, { response: Item }, undefined, { id: 'a' })).rejects.toMatchObject({ code: 'bad_response', status: 200 });
  });

  it('substitutes and encodes path params, and sends a GET body as a query string', async () => {
    const { api, seen } = setup(() => ({ status: 200, body: { id: 'a/b', n: 1 } }));
    await api.call(getRoute, { response: Item }, { q: 'x y', skip: undefined } as never, { id: 'a/b' });
    expect(seen[0]?.url).toBe('/api/items/a%2Fb?q=x+y');
    expect(seen[0]?.body).toBeUndefined();
    expect(() => buildPath('/api/items/:id', {})).toThrow(/Missing path param :id/);
  });

  it('accepts an empty response for a schema that allows it', async () => {
    const { api } = setup(() => ({ status: 204 }));
    await expect(api.call({ method: 'DELETE', path: '/api/items/:id' }, { response: z.undefined() }, undefined, { id: 'a' })).resolves.toBeUndefined();
  });
});

describe('api client: CSRF', () => {
  it('sends x-csrf-token from the manythreads_csrf cookie on unsafe methods only', async () => {
    const { api, seen } = setup(() => ({ status: 200, body: { id: 'x', n: 1 } }));
    await api.call(postRoute, { response: Item });
    await api.call({ method: 'PATCH', path: '/api/items' }, { response: Item });
    await api.call({ method: 'DELETE', path: '/api/items' }, { response: Item });
    await api.call(getRoute, { response: Item }, undefined, { id: 'a' });
    expect(seen.map((r) => r.headers['x-csrf-token'])).toEqual(['tok/123', 'tok/123', 'tok/123', undefined]);
  });

  it('sends no header when the cookie is absent', async () => {
    const { api, seen } = setup(() => ({ status: 200, body: { id: 'x', n: 1 } }), 'a=1');
    await api.call(postRoute, { response: Item });
    expect(seen[0]?.headers).not.toHaveProperty('x-csrf-token');
  });

  it('reads cookies by exact name', () => {
    expect(readCookie('manythreads_csrf', 'x_manythreads_csrf=no; manythreads_csrf=yes')).toBe('yes');
    expect(readCookie('manythreads_csrf', undefined)).toBeUndefined();
  });
});

describe('api client: errors', () => {
  const envelope = { error: { code: 'validation_failed', message: 'Password must be at least 8 characters', path: ['password'] } };

  it('maps an ErrorEnvelope to a typed ApiError', async () => {
    const { api } = setup(() => ({ status: 400, body: envelope }));
    const err = await api.call(postRoute, { response: Item }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'validation_failed', message: 'Password must be at least 8 characters', path: ['password'], status: 400 });
  });

  it('maps a non-envelope failure to a generic ApiError', async () => {
    const { api } = setup(() => ({ status: 502, body: '<html>bad gateway</html>' }));
    await expect(api.call(postRoute, { response: Item })).rejects.toMatchObject({ code: 'internal', status: 502 });
  });

  it('maps a transport failure to code network', async () => {
    const { api } = setup(() => Promise.reject(new Error('offline')));
    await expect(api.call(postRoute, { response: Item })).rejects.toMatchObject({ code: 'network', status: 0, message: 'offline' });
  });

  it('401 raises the session-expired event and still throws', async () => {
    const { api, onSessionExpired } = setup(() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Session expired' } } }));
    await expect(api.call(getRoute, { response: Item }, undefined, { id: 'a' })).rejects.toMatchObject({ code: 'unauthenticated', status: 401 });
    expect(onSessionExpired).toHaveBeenCalledTimes(1);
  });

  it('401 on a sign-in style call does not raise session-expired', async () => {
    const { api, onSessionExpired } = setup(() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Email or password is incorrect.' } } }));
    await expect(api.call(postRoute, { response: Item }, undefined, undefined, { noSessionExpiry: true })).rejects.toMatchObject({ message: 'Email or password is incorrect.' });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it('403 and 404 do not raise session-expired', async () => {
    const { api, onSessionExpired } = setup(() => ({ status: 403, body: { error: { code: 'forbidden', message: 'No' } } }));
    await expect(api.call(postRoute, { response: Item })).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    expect(onSessionExpired).not.toHaveBeenCalled();
  });
});
