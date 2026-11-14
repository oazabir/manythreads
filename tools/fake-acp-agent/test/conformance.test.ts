import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRIPT, type Flavor } from '../src/script.ts';
import { OURS, harness } from './helpers.ts';

/*
 * The fake agent against what the real adapters sent (the bridge's recorded fixtures, P25-01): the client side of each flavor's "work" recording is replayed to the
 * fake's own "work" scenario, and what comes back is compared with the recording by kind of update, by the keys of each kind (and of its `_meta`), and by the
 * order in which the kinds first appear. A fake that grows a field or a kind no real adapter sends fails here, so a bridge tested on it is not tested on fiction.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agent-bridge', 'test', 'fixtures', 'acp');

/** Kinds the fake plays that no recording of that adapter holds, on purpose: docs/spikes/acp-measured.md says "Claude sent none (thinking) on Haiku", and the bridge has to take it if it comes. */
const UNMEASURED: Record<Flavor, string[]> = { claude: ['agent_thought_chunk'], codex: [], hermes: [] };

type Obj = Record<string, unknown>;
interface Line {
  dir: string;
  msg: { method?: string; params?: { update?: Obj } & Obj };
}

const fixture = (name: string): Line[] =>
  readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);

const updatesOf = (name: string): Obj[] => fixture(name).filter((l) => l.dir === 'a2c' && l.msg.method === 'session/update').map((l) => l.msg.params!.update!);

/** Every recording of one adapter (work, edit, permission, cancel, resume): what it is known to send. */
const allUpdatesOf = (flavor: Flavor): Obj[] =>
  readdirSync(FIXTURES)
    .filter((f) => f.startsWith(`${flavor}-`) && f.endsWith('.jsonl'))
    .flatMap((f) => updatesOf(f));

/** Kinds whose place in the stream is the adapter's own business (it mixes `usage_update` and bookkeeping in everywhere): left out of the order check. */
const LOOSE = new Set(['usage_update', 'session_info_update', 'available_commands_update', 'config_option_update', 'current_mode_update']);

/** For each kind of update: the keys it carries at the top, and under each `_meta.<adapter>` object. */
function shapes(updates: Obj[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const u of updates) {
    const kind = String(u['sessionUpdate']);
    const keys = out.get(kind) ?? new Set<string>();
    out.set(kind, keys);
    for (const [k, v] of Object.entries(u)) {
      keys.add(k);
      if (k === '_meta' && v !== null && typeof v === 'object') {
        for (const [adapter, inner] of Object.entries(v as Obj)) {
          keys.add(`_meta.${adapter}`);
          if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) for (const sub of Object.keys(inner)) keys.add(`_meta.${adapter}.${sub}`);
        }
      }
    }
  }
  return out;
}

const firstOrder = (updates: Obj[]): string[] => [...new Set(updates.map((u) => String(u['sessionUpdate'])))];

async function fakeUpdates(flavor: Flavor): Promise<Obj[]> {
  const h = harness({ ...DEFAULT_SCRIPT, flavor });
  await h.run(async (agent) => {
    await agent.request('initialize', { protocolVersion: 1, clientCapabilities: OURS });
    const { sessionId } = await agent.request('session/new', { cwd: '/work/demo', mcpServers: [] });
    await agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '[[work]]' }] });
  });
  return h.updates;
}

for (const flavor of ['claude', 'codex', 'hermes'] as const) {
  describe(`${flavor}: the fake against the recorded work run`, () => {
    it('sends no kind of update, and no field of one, that the adapter did not send', async () => {
      const real = shapes(allUpdatesOf(flavor));
      const fake = shapes(await fakeUpdates(flavor));
      expect([...real.keys()].length).toBeGreaterThan(2);
      for (const [kind, keys] of fake) {
        if (UNMEASURED[flavor].includes(kind) && !real.has(kind)) continue;
        expect(real.has(kind), `kind ${kind}`).toBe(true);
        const allowed = real.get(kind)!;
        const extra = [...keys].filter((k) => !allowed.has(k));
        expect(extra, `${kind}: keys the adapter never sent`).toEqual([]);
      }
    });

    it('and the kinds that both send first appear in the same order', async () => {
      const real = firstOrder(updatesOf(`${flavor}-work.jsonl`)).filter((k) => !LOOSE.has(k));
      const fake = firstOrder(await fakeUpdates(flavor)).filter((k) => real.includes(k) && !LOOSE.has(k));
      const realCommon = real.filter((k) => fake.includes(k));
      expect(fake).toEqual(realCommon);
    });
  });
}
