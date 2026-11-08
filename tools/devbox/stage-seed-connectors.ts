import { seedConnectors } from '../../packages/test-utils/src/seed-connectors.ts';
import type { SeedConnectorsSaas } from '../../packages/test-utils/src/seed-connectors.ts';
import { seedRefreshToken, seedToken, type SeedProvider } from '../fake-saas/src/tokens.ts';

/*
 * Seeds the connectors world (seed v16) into the stage release (tools/devbox/stage.sh). The seed runs outside the pod, so it reaches the stand-ins through their control port
 * and seals the sign-ins with the pod's own KMS key (MANYTHREADS_KMS_KEY, read from the cluster by stage.sh): a key of another origin would seal tokens the server cannot open.
 *
 * Variables (set by stage.sh): STAGE_SERVER_URL (the server through a port-forward, started in test mode so the dev-actor header is honoured), STAGE_SYSTEM_DATABASE_URL,
 * FAKE_SAAS_CONTROL, FAKE_SAAS_SEED_KEY, FAKE_SAAS_TELEGRAM_TOKEN, MANYTHREADS_KMS_KEY.
 * Written for the integration pass; not run by the coder that wrote it.
 */
const need = (name: string): string => {
  const v = (process.env[name] ?? '').trim();
  if (!v) {
    console.error(`stage seed: ${name} is not set (run it through tools/devbox/stage.sh up)`);
    process.exit(1);
  }
  return v;
};
const url = need('STAGE_SERVER_URL');
const systemUrl = need('STAGE_SYSTEM_DATABASE_URL');
const control = need('FAKE_SAAS_CONTROL').replace(/\/+$/, '');
const seedKey = need('FAKE_SAAS_SEED_KEY');
const telegramToken = need('FAKE_SAAS_TELEGRAM_TOKEN');
need('MANYTHREADS_KMS_KEY');

async function fake(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${control}${path}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${path}: ${String(res.status)} ${text.slice(0, 200)}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

// The stand-ins run in another process, so the few calls the seed makes in-process go over the control port instead. The seed does not wait for them; a failed one is reported.
const pending: Array<Promise<unknown>> = [];
const saas: SeedConnectorsSaas = {
  seedKey,
  workspace: {
    putFile: (email, file) => {
      pending.push(fake('PATCH', `/__fake/accounts/${encodeURIComponent(email)}`, { files: [file] }));
    },
    setFilePermissions: (email, fileId, permissions) => {
      pending.push(fake('PUT', `/__fake/drive/${encodeURIComponent(fileId)}/permissions`, { account: email, permissions }));
    },
  },
  telegram: { bots: [{ token: telegramToken }] },
  control: { url: control, telegramSend: (input) => fake('POST', '/__fake/telegram/send', input) },
  seedTokens: (provider: SeedProvider, email: string) => ({ accessToken: seedToken(provider, seedKey, email), refreshToken: seedRefreshToken(provider, seedKey, email) }),
};

const result = await seedConnectors({ url, db: { systemUrl }, saas, log: (line) => console.log(`stage seed: ${line}`) });
await Promise.all(pending);
console.log(`stage seed: done (#design ${result.designChannelId}, ${String(Object.keys(result.connections).length)} sign-ins)`);
process.exit(0);
