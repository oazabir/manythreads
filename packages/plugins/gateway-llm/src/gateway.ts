import { createLiteLlmClient, type LlmGateway } from './litellm.ts';

// Where the gateway finds its proxy, and the queue names the plugin registers. The URL and master key come from the
// environment (deploy/compose/dev.env.example documents both): the compose service `manythreads-llm` publishes
// MANYTHREADS_LITELLM_URL, and the master key is shared with the proxy's own LITELLM_MASTER_KEY. When the URL is absent the
// gateway still mints and stores keys locally and records the config, but pushes nothing — that keeps a dev box and the test
// suite working without a proxy, and the apply-config job logs the omission.

/** Queues this plugin owns (the kernel requires `<plugin>.<name>`). */
export const APPLY_CONFIG_QUEUE = 'gateway-llm.apply-config';
export const SYNC_KEY_QUEUE = 'gateway-llm.sync-key';
export const RECONCILE_QUEUE = 'gateway-llm.reconcile';
export const BOOT_HEAL_QUEUE = 'gateway-llm.boot-heal';

/** A client from `MANYTHREADS_LITELLM_URL` / `MANYTHREADS_LITELLM_MASTER_KEY`; disabled when the URL is unset. */
export function gatewayFromEnv(env: NodeJS.ProcessEnv = process.env): LlmGateway {
  const baseUrl = (env['MANYTHREADS_LITELLM_URL'] ?? '').trim().replace(/\/+$/, '');
  const masterKey = (env['MANYTHREADS_LITELLM_MASTER_KEY'] ?? '').trim() || null;
  return createLiteLlmClient({ baseUrl: baseUrl || null, masterKey });
}
