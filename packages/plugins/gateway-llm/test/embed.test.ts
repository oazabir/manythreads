import {
  createPluginContext,
  createSecretService,
  createSystemPool,
  ExtensionRegistries,
  createMemoryKv,
  withSystem,
  type Tx,
} from "@manythreads/kernel";
import type { PluginEvent, PluginTx } from "@manythreads/sdk";
import {
  botsMigrationSource,
  channelsMigrationSource,
  createPersonas,
  createTestDatabase,
  dropTestDatabase,
  gatewayLlmMigrationSource,
  guardrailsDlpMigrationSource,
  guardrailsEgressMigrationSource,
  personas,
  teamsMigrationSource,
  testKernelMigrationSource,
  type TestDatabase,
} from "@manythreads/test-utils";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import guardrailsDlp from "../../guardrails-dlp/src/index.ts";
import guardrailsEgress from "../../guardrails-egress/src/index.ts";
import gatewayLlm from "../src/index.ts";
import type { LlmProviderServices } from "../src/provider.ts";
import { embedTexts } from "../src/embed.ts";

// The clip door of the `llm` provider (P32-03, decision D13) against a real database: the model must be set up and inside this deployment, what goes to the
// proxy (a recording `fetch`), that no transaction is open while the proxy works, the 8 MB cap, how failures are told apart, the spend line, the stand-in.

const { omar } = personas;

let db: TestDatabase;
let sysPool: pg.Pool;
let ctx: ReturnType<typeof createPluginContext>;
let gateway: LlmProviderServices;
const emitted: PluginEvent[] = [];

const sys = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withSystem(fn, { pool: sysPool, workspaceId: omar.workspaceId });

beforeAll(async () => {
  delete process.env["MANYTHREADS_LITELLM_URL"];
  db = await createTestDatabase({
    sources: [
      testKernelMigrationSource,
      teamsMigrationSource,
      channelsMigrationSource,
      botsMigrationSource,
      gatewayLlmMigrationSource,
      guardrailsDlpMigrationSource,
      guardrailsEgressMigrationSource,
    ],
  });
  await createPersonas(db);
  sysPool = createSystemPool(db.systemUrl, 2);
  const deps: Parameters<typeof createPluginContext>[1] = {
    registries: new ExtensionRegistries(),
    storage: createMemoryKv(),
    mail: { configured: true, send: () => Promise.resolve() },
    runtime: { publicUrl: "http://localhost:3000", now: () => new Date() },
    secrets: createSecretService(),
    emit: async (_tx: unknown, event: PluginEvent) => void emitted.push(event),
    systemPool: sysPool,
  } as never;
  for (const guardrail of [guardrailsEgress, guardrailsDlp])
    await guardrail.register(createPluginContext(guardrail.manifest, deps));
  ctx = createPluginContext(gatewayLlm.manifest, deps);
  await gatewayLlm.register(ctx);
  gateway = ctx.providers.get<LlmProviderServices>("llm")!;
}, 180_000);

afterAll(async () => {
  await sysPool?.end();
  if (db) await dropTestDatabase(db);
});

const env = {
  MANYTHREADS_LITELLM_URL: "http://litellm.test:4000/",
  MANYTHREADS_LITELLM_MASTER_KEY: "sk-master-test",
} as NodeJS.ProcessEnv;
const bind = (model: string | null) =>
  sys(async (tx) => {
    await tx.query(
      `DELETE FROM app.llm_aliases WHERE workspace_id = $1 AND alias = 'embed'`,
      [omar.workspaceId],
    );
    await tx.query(
      `DELETE FROM app.llm_providers WHERE workspace_id = $1 AND lower(name) = 'embed-test'`,
      [omar.workspaceId],
    );
    if (model === null) return;
    const providerId = (
      await tx.query<{ id: string }>(
        `INSERT INTO app.llm_providers (workspace_id, name, kind, api_base, local) VALUES ($1, 'embed-test', 'openai_compatible', 'http://manythreads-asr:8000/v1', true) RETURNING id`,
        [omar.workspaceId],
      )
    ).rows[0]!.id;
    await tx.query(
      `INSERT INTO app.llm_aliases (workspace_id, alias, model, provider_id) VALUES ($1, 'embed', $2, $3)`,
      [omar.workspaceId, model, providerId],
    );
  });
function proxy(
  answer: (input: string[]) => { status?: number; body: unknown },
) {
  const seen: Array<{
    url: string;
    auth: string;
    model: string;
    input: string[];
  }> = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const doc = JSON.parse(String(init?.body)) as {
      model: string;
      input: string[];
    };
    seen.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>)["authorization"] ?? "",
      model: doc.model,
      input: doc.input,
    });
    const a = answer(doc.input);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, seen };
}
const vectors = (input: string[]) => ({
  body: {
    data: input.map((_, i) => ({
      index: i,
      embedding: Array.from({ length: 768 }, (_x, k) => (k === i ? 1 : 0)),
    })),
    usage: { prompt_tokens: 7 },
  },
});
const call = (texts: string[], purpose: "passage" | "query", f: typeof fetch) =>
  sys((tx) =>
    embedTexts(
      ctx,
      tx as unknown as PluginTx,
      { workspaceId: omar.workspaceId, texts, purpose },
      { env, fetch: f },
    ),
  );

describe("the embedding door (P35-06)", () => {
  it("is offered by the gateway provider (the knowledge plugin switches to hybrid search on it)", () => {
    expect(typeof (gateway as unknown as { embed?: unknown }).embed).toBe(
      "function",
    );
  });

  it("says unbound when the workspace has no embed model, and sends nothing", async () => {
    await bind(null);
    const p = proxy(vectors);
    expect(await call(["a"], "passage", p.fetch)).toMatchObject({
      ok: false,
      reason: "unbound",
    });
    expect(p.seen).toEqual([]);
    expect(await gateway.embedReady(omar.workspaceId)).toBe(false);
    await bind("openai/BAAI/bge-base-en-v1.5");
    expect(await gateway.embedReady(omar.workspaceId)).toBe(true);
  });

  it("embeds through the proxy with the master key, in order, with the BGE instruction on a question only, and writes a spend line", async () => {
    await bind("openai/BAAI/bge-base-en-v1.5");
    const p = proxy(vectors);
    const passages = await call(
      ["first passage", "second passage"],
      "passage",
      p.fetch,
    );
    expect(passages).toMatchObject({ ok: true });
    if (passages.ok)
      expect(passages.vectors.map((v) => v.indexOf(1))).toEqual([0, 1]);
    expect(p.seen[0]).toMatchObject({
      url: "http://litellm.test:4000/embeddings",
      auth: "Bearer sk-master-test",
      model: "embed",
      input: ["first passage", "second passage"],
    });
    await call(["where is the deploy guide?"], "query", p.fetch);
    expect(p.seen[1]!.input[0]).toBe(
      "Represent this sentence for searching relevant passages: where is the deploy guide?",
    );
    const lines = await sys(
      async (tx) =>
        (
          await tx.query<{ alias: string; prompt_tokens: number }>(
            `SELECT alias, prompt_tokens FROM app.llm_spend WHERE workspace_id = $1 AND alias = 'embed'`,
            [omar.workspaceId],
          )
        ).rows,
    );
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toMatchObject({ alias: "embed", prompt_tokens: 7 });
  });

  it("answers unavailable for a model that is down or answers wrongly, refused for a bad input, and never throws", async () => {
    await bind("openai/BAAI/bge-base-en-v1.5");
    expect(
      await call(
        ["a"],
        "passage",
        proxy(() => ({ status: 503, body: { error: "down" } })).fetch,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      await call(
        ["a", "b"],
        "passage",
        proxy(() => ({ body: { data: [{ index: 0, embedding: [1] }] } })).fetch,
      ),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    expect(
      await call(
        ["a"],
        "passage",
        proxy(() => ({ status: 400, body: { error: "bad" } })).fetch,
      ),
    ).toMatchObject({ ok: false, reason: "refused" });
    const failing = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await call(["a"], "passage", failing)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await call(
        Array.from({ length: 65 }, () => "x"),
        "passage",
        proxy(vectors).fetch,
      ),
    ).toMatchObject({ ok: false, reason: "refused" });
  });
});
