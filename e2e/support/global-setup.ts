import { mkdirSync } from 'node:fs';
import { request } from '@playwright/test';
import { AUTH_DIR, PERSONA_KEYS, PERSONA_PASSWORD, WEB, authState, personaEmail } from './env.ts';

/**
 * Persona sign-in states: e2e/.auth/<persona>.json, created through the real password sign-in (POST
 * /api/auth/password/sign-in through the web origin's proxy), so a spec that opens a page as Nadia carries exactly the
 * cookies a browser would. Skipped for the api-only project (no web server then).
 */
export default async function globalSetup(): Promise<void> {
  if (process.env['MANYTHREADS_E2E_API_ONLY'] === '1') return;
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const key of PERSONA_KEYS) {
    const ctx = await request.newContext({ baseURL: WEB });
    const res = await ctx.post('/api/auth/password/sign-in', { data: { email: personaEmail(key), password: PERSONA_PASSWORD } });
    if (!res.ok()) throw new Error(`sign-in as ${key} failed: ${res.status()} ${await res.text()}`);
    await ctx.storageState({ path: authState(key) });
    await ctx.dispose();
  }
}
