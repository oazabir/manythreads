import type { z } from 'zod';
import {
  ErrorEnvelope,
  GuestKnockResponse,
  GuestLinkPeekResponse,
  GuestOkResponse,
  GuestSessionResponse,
  GuestTokenResponse,
  guestHeartbeatRoute,
  guestKnockRoute,
  guestLeaveRoute,
  guestLinkPeekRoute,
  guestSessionRoute,
  guestTokenRoute,
} from '@manythreads/shared';
import { ApiError } from '../api/client';
import { trackRequest } from '../api/ready';

/*
 * The guest page's own calls (P17-04). Nobody is signed in here: no session cookie, no CSRF token and no "your session expired" redirect. The guest's credential
 * is the `mt_guest` cookie the knock sets (HttpOnly, only sent to `/api/guest`); the page never sees it. Every call is same-origin, so the browser sends the
 * `Origin` the server checks.
 */

export interface GuestApi {
  peek(token: string): Promise<GuestLinkPeekResponse>;
  knock(token: string, displayName: string): Promise<GuestKnockResponse>;
  session(): Promise<GuestSessionResponse>;
  token(): Promise<GuestTokenResponse>;
  leave(): Promise<GuestOkResponse>;
  heartbeat(): Promise<GuestOkResponse>;
}

async function send<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
  const res = await trackRequest(async () => {
    let r: Response;
    try {
      r = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError({ code: 'network', message: 'Could not reach the server. Check your connection and try again.', status: 0 });
    }
    const text = await r.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  });
  if (res.status >= 200 && res.status < 300) {
    const ok = schema.safeParse(res.body);
    if (!ok.success) throw new ApiError({ code: 'bad_response', message: 'The server sent an answer this page cannot read.', status: res.status });
    return ok.data;
  }
  const env = ErrorEnvelope.safeParse(res.body);
  throw new ApiError(
    env.success
      ? { code: env.data.error.code, message: env.data.error.message, status: res.status }
      : { code: res.status === 401 ? 'unauthenticated' : 'internal', message: `Request failed (${res.status})`, status: res.status },
  );
}

export const realGuestApi: GuestApi = {
  // the link's secret goes in the body, never in an address (addresses land in logs)
  peek: (token) => send('POST', guestLinkPeekRoute.path, GuestLinkPeekResponse, { token }),
  knock: (token, displayName) => send('POST', guestKnockRoute.path, GuestKnockResponse, { token, displayName }),
  session: () => send('GET', guestSessionRoute.path, GuestSessionResponse),
  token: () => send('POST', guestTokenRoute.path, GuestTokenResponse),
  leave: () => send('POST', guestLeaveRoute.path, GuestOkResponse),
  heartbeat: () => send('POST', guestHeartbeatRoute.path, GuestOkResponse),
};
