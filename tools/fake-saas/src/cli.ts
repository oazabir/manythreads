import { refuseProduction, startFakeSaas } from './server.ts';
import type { SeedGrant, SeedProvider } from './tokens.ts';

/*
 * Run every stand-in on its own (PLAN Bundle D). The stage release and a hand check use it:
 *
 *     pnpm -C tools/fake-saas start --host 0.0.0.0 --public-host 10.0.2.15 --port 18090 --seed stage-seed \
 *       --seed-grant google:nadia@kahf.example --seed-grant microsoft:rafi@kahf.example
 *
 * It prints one line a probe waits for, `FAKE_SAAS {json}`, with the control address, the address of every stand-in and the variables for the server under test.
 * The README lists every flag and variable. It exits with 1 when NODE_ENV=production.
 */

try {
  refuseProduction();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const at = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at < 0) return undefined;
  const a = args[at]!;
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[at + 1];
}
function flags(name: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]!);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  });
  return out;
}
const env = (name: string): string | undefined => (process.env[name] ?? '').trim() || undefined;

const host = flag('host') ?? env('FAKE_SAAS_HOST') ?? '127.0.0.1';
const publicHost = flag('public-host') ?? env('FAKE_SAAS_PUBLIC_HOST');
const port = Number(flag('port') ?? env('FAKE_SAAS_PORT') ?? 0);
const seedKey = flag('seed') ?? env('FAKE_SAAS_SEED');
const controlKey = env('FAKE_SAAS_CONTROL_KEY');
if (!Number.isInteger(port) || port < 0 || port > 65_000) {
  console.error(`the port must be a whole number from 0 to 65000, got "${String(flag('port') ?? env('FAKE_SAAS_PORT'))}"`);
  process.exit(1);
}

const grantSpecs = [...flags('seed-grant'), ...(env('FAKE_SAAS_SEED_GRANTS')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])];
const seedGrants: SeedGrant[] = grantSpecs.map((spec) => {
  const [provider, email] = spec.split(':');
  if ((provider !== 'google' && provider !== 'microsoft' && provider !== 'notion') || !email || !email.includes('@')) {
    console.error(`a seed grant looks like google:nadia@kahf.example (google, microsoft or notion), got "${spec}"`);
    process.exit(1);
  }
  return { provider: provider as SeedProvider, email };
});

const telegramToken = env('FAKE_SAAS_TELEGRAM_TOKEN');
const telegramUser = env('FAKE_SAAS_TELEGRAM_BOT_USERNAME');

const saas = await startFakeSaas({
  host,
  ...(publicHost ? { publicHost } : {}),
  port,
  ...(seedKey ? { seedKey } : {}),
  seedGrants,
  ...(controlKey ? { controlKey } : {}),
  ...(env('FAKE_SAAS_CLIENT_ID') ? { clientId: env('FAKE_SAAS_CLIENT_ID')! } : {}),
  ...(env('FAKE_SAAS_CLIENT_SECRET') ? { clientSecret: env('FAKE_SAAS_CLIENT_SECRET')! } : {}),
  modules: { telegram: { bots: [{ ...(telegramToken ? { token: telegramToken } : {}), ...(telegramUser ? { username: telegramUser } : {}) }] } },
});

const urls = Object.fromEntries(Object.values(saas.standIns).map((h) => [h.id, h.urls]));
console.log(
  `FAKE_SAAS ${JSON.stringify({
    control: saas.control.url,
    urls,
    env: saas.env(),
    // fake values that exist only here: the bot token an admin pastes into the Telegram page, and the seed key the tokens come from
    telegram: { botToken: saas.telegram.bots[0]!.token, botUsername: saas.telegram.bots[0]!.username },
    seedKey: saas.seedKey,
    seedGrants: seedGrants.map((g) => ({ provider: g.provider, email: g.email })),
  })}`,
);
console.log(`fake-saas ready: control ${saas.control.url}${controlKey ? ' (key required)' : ''}; ${Object.keys(saas.standIns).join(', ')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void saas.stop().then(() => process.exit(0));
  });
}
