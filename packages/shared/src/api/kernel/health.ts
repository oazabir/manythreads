import { z } from 'zod';

export const healthRoute = { method: 'GET', path: '/healthz' } as const;
export const readyRoute = { method: 'GET', path: '/readyz' } as const;

/** `/healthz`: the process is up. `migrations` is the applied count; `plugins` the loaded plugin names. */
export const HealthResponse = z.object({
  status: z.literal('ok'),
  migrations: z.number().int().nonnegative(),
  plugins: z.array(z.string()),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

/** `/readyz`: the database answers and every known migration is applied. Otherwise 503 with an ErrorEnvelope. */
export const ReadyResponse = z.object({
  status: z.literal('ready'),
  migrations: z.number().int().nonnegative(),
});
export type ReadyResponse = z.infer<typeof ReadyResponse>;
