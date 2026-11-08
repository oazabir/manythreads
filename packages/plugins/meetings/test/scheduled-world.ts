import { StartPersonConnectionResponse } from '@manythreads/shared';
import { startFakeProviders, type FakeProviders } from '@manythreads/test-utils';
import { expect } from 'vitest';
import { createWorld, ensureChannels, personas, type Persona, type World } from '../../channels/test/world.ts';

// A world for planned rooms (P16-05): every plugin, the fake media provider, and the fake Google and Microsoft 365 (`tools/fake-saas` stand-ins) so a person can connect a calendar
// the way a browser does (start, the provider's consent page, the callback). Nothing here reaches a real provider.

export { personas };
export type { Persona };

export interface ScheduledWorld {
  w: World;
  fake: FakeProviders;
  /** The Engineering #general channel (everyone on Engineering reads it; Sameera, Tariq and Lena are not in it). */
  general: string;
  /** Connects the person's calendar at the fake provider with the given services (`calendar_write`, `calendar_free_busy`, `calendar`). */
  connect(who: Persona, provider: 'google' | 'microsoft', services?: string[]): Promise<void>;
  close(): Promise<void>;
}

export async function createScheduledWorld(): Promise<ScheduledWorld> {
  const saved: Record<string, string | undefined> = {};
  const fake = await startFakeProviders();
  for (const [k, v] of Object.entries({ ...fake.env(), MANYTHREADS_MEDIA_PROVIDER: 'fake' })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const w = await createWorld();
  await ensureChannels(w);
  const general = await w.channelId('engineering', 'general');
  const raw = (who: Persona, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${w.server.url}${path}`, {
      method,
      redirect: 'manual',
      headers: { 'x-manythreads-dev-actor': JSON.stringify({ kind: 'person', id: who.actorId, workspaceId: who.workspaceId }), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return {
    w,
    fake,
    general,
    async connect(who, provider, services = ['calendar_write', 'calendar_free_busy']) {
      fake.signInAs(who.email);
      const start = await raw(who, 'POST', `/api/me/connections/${provider}/start`, { services });
      expect(start.status).toBe(200);
      const consent = await fetch(StartPersonConnectionResponse.parse(await start.json()).url, { redirect: 'manual' });
      const back = new URL(consent.headers.get('location')!);
      expect((await raw(who, 'GET', `${back.pathname}${back.search}`)).status).toBe(302);
    },
    async close() {
      await w.close();
      await fake.stop();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** An ISO time `minutes` from now, on a whole minute. */
export const inMinutes = (minutes: number): string => new Date(Math.ceil((Date.now() + minutes * 60_000) / 60_000) * 60_000).toISOString();
