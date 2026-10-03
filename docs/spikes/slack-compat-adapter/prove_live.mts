/**
 * P5-01 spike live loop (devbox only): the real Hermes `manythreads` adapter
 * delivers into a real channel thread on a scratch server, and the reply reads
 * back through the normal messages API.
 *
 * Run on the devbox: `pnpm exec tsx docs/spikes/slack-compat-adapter/prove_live.mts`
 * (needs the dev Postgres: `pnpm db:up`). The pairing token travels in process
 * env only and is never printed. Procedure + transcript go in
 * `docs/spikes/slack-compat.md`.
 */
import { execFile } from "node:child_process";
import { MintPairingTokenResponse } from "../../../packages/shared/src/index.ts";
import { createWorld, ensureChannels, personas } from "../../../packages/plugins/channels/test/world.ts";

const { omar, nadia } = personas;
const UV = "/root/.hermes/tools/uv-0.12.3-linux-x64/uv";
const HERMES_AGENT = "/root/.hermes/hermes-agent";
const ADAPTER = new URL("./send_once.py", import.meta.url).pathname;

const run = (cmd: string, args: string[], env: Record<string, string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { env: { ...process.env, ...env } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} failed: ${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 20_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out waiting for the adapter delivery");
    await new Promise((r) => setTimeout(r, 300));
  }
}

const w = await createWorld();
try {
  await ensureChannels(w);
  const dir = await w.call(omar, "GET", "/api/teams/engineering/channels");
  const groups = (dir.body as { groups?: Array<{ name: string; channels: Array<{ name: string }> }> }).groups ?? [];
  console.log("directory status=" + String(dir.status) + " groups=" + groups.map((g) => g.name + ":" + g.channels.map((c) => c.name).join(",")).join(" | "));
  const channelId = await w.channelId("engineering", "dev");

  // Spike scaffolding (template bots land in P5-19): a minimal bot row + actor.
  const bot = await w.system(async (tx) => {
    const row = await tx.query<{ id: string }>(
      `INSERT INTO app.bots (workspace_id, team_id, slug, kind, runtime, visibility, definition_sha, status)
       VALUES ($1, (SELECT id FROM app.teams WHERE slug = 'engineering'), 'spikebot', 'agent', 'rules', 'team', repeat('b', 64), 'active')
       RETURNING id`,
      [omar.workspaceId],
    );
    const botId = row.rows[0]!.id;
    const actor = await tx.query<{ id: string }>(
      `INSERT INTO app.actors (kind, workspace_id, ref_id) VALUES ('bot', $1, $2) RETURNING id`,
      [omar.workspaceId, botId],
    );
    return { actorId: actor.rows[0]!.id };
  });

  const minted = await w.call(omar, "POST", "/api/teams/engineering/bots/spikebot/pairing-tokens", {});
  if (minted.status !== 201) throw new Error(`mint failed: ${minted.status} ${JSON.stringify(minted.body)}`);
  const token = MintPairingTokenResponse.parse(minted.body).token;

  const root = await w.call(nadia, "POST", `/api/channels/${channelId}/messages`, {
    channelId,
    body: "What did the deploy change?",
    threadRootId: null,
  });
  if (root.status !== 201) throw new Error(`root post failed: ${root.status}`);
  const rootId = (root.body as { id: string }).id;

  // The Hermes side: the real ManythreadsAdapter POSTs the door (text authored
  // here — the model arrives with LiteLLM in P5-06/P5-10).
  const text = "[spike P5-01] the deploy changed the loader (via the Hermes manythreads adapter)";
  const out = await run(UV, ["run", "--project", HERMES_AGENT, "python", ADAPTER], {
    MANYTHREADS_SERVER_URL: w.server.url,
    MANYTHREADS_PAIRING_TOKEN: token,
    CHANNEL_ID: channelId,
    THREAD_TS: rootId,
    TEXT: text,
  });
  console.log(`adapter: ${out.replace(token, "<redacted>")}`);

  const reply = await waitFor(async () => {
    const list = await w.call(nadia, "GET", `/api/channels/${channelId}/messages?threadRootId=${rootId}&limit=50`);
    if (list.status !== 200) return undefined;
    const items = (list.body as { items: Array<{ id: string; threadRootId: string | null; authorId: string; body: string }> }).items;
    return items.find((m) => m.threadRootId === rootId && m.authorId === bot.actorId);
  });
  console.log(`thread #dev reply id=${reply.id} author=bot(spikebot)`);
  console.log(`thread #dev reply body=${JSON.stringify(reply.body)}`);
  if (reply.body !== text) throw new Error("reply body mismatch");
  console.log("LIVE LOOP PROOF PASSED: Hermes adapter -> door -> thread, readable via the messages API");
} finally {
  await w.close();
}
