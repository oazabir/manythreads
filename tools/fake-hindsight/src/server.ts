import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/*
 * fake-hindsight — a Hindsight API that is not Hindsight (PLAN P5-12, `tools/fake-hindsight`).
 *
 * It speaks the endpoints the memory-hindsight client uses (`PUT /v1/default/banks/{bank}`, `POST .../memories`, `POST .../memories/recall`,
 * `DELETE .../documents/{id}`, `GET /health`), keeps one store PER BANK in memory, and records every request so a test can assert which bank a
 * call named. It does not call an LLM: retain stores each item's content as one "fact" verbatim, recall ranks a bank's facts by how many of the
 * query's words they contain (zero overlap = not returned). That is enough for the property the tests exist for — a recall in bank A returns
 * nothing that was retained in bank B — because the fake, like the real engine, can only ever search the bank in the URL.
 *
 * Habits copied from the real container (docs/plugins/memory-hindsight.md, re-checked by test/hindsight.integration.test.ts):
 *  - retaining under an existing `document_id` replaces that document's facts (upsert);
 *  - deleting a document that does not exist is a 404;
 *  - with an api key configured, every request without `Authorization: Bearer <key>` is a 401.
 */

export interface FakeHindsightFact {
  id: string;
  text: string;
  context: string | null;
  tags: string[];
  metadata: Record<string, string>;
  documentId: string;
  type: 'world';
}

export interface FakeHindsightCall {
  method: string;
  /** The path as received, still percent-encoded. */
  path: string;
  /** The bank the path names, decoded; null for a request that names none. */
  bank: string | null;
  body: unknown;
  /** False when the call was refused for a missing or wrong api key. */
  authorized: boolean;
}

export interface FakeHindsightState {
  /** bank id -> facts in retain order. */
  banks: Map<string, FakeHindsightFact[]>;
  calls: FakeHindsightCall[];
}

export interface FakeHindsightOptions {
  port?: number;
  host?: string;
  apiKey?: string;
}

export interface FakeHindsight {
  readonly url: string;
  readonly state: FakeHindsightState;
  /** Every distinct bank any request named, in first-seen order. */
  banksTouched(): string[];
  close(): Promise<void>;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export async function startFakeHindsight(options: FakeHindsightOptions = {}): Promise<FakeHindsight> {
  const state: FakeHindsightState = { banks: new Map(), calls: [] };
  let counter = 0;

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve(text ? JSON.parse(text) : undefined);
        } catch {
          resolve(text);
        }
      });
    });
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = req.url ?? '/';
      const body = await readBody(req);
      const match = /^\/v1\/default\/banks\/([^/]+)(\/.*)?$/.exec(path.split('?')[0] ?? '');
      let bank: string | null = null;
      if (match?.[1] !== undefined) {
        try {
          bank = decodeURIComponent(match[1]);
        } catch {
          bank = match[1];
        }
      }
      const authorized = options.apiKey === undefined || req.headers['authorization'] === `Bearer ${options.apiKey}`;
      state.calls.push({ method, path, bank, body, authorized });
      if (!authorized) return send(res, 401, { detail: 'Unauthorized' });

      if (method === 'GET' && path === '/health') return send(res, 200, { status: 'healthy' });
      if (match?.[1] === undefined || bank === null) return send(res, 404, { detail: 'Not Found' });
      const rest = match[2] ?? '';

      if (method === 'PUT' && rest === '') {
        if (!state.banks.has(bank)) state.banks.set(bank, []);
        return send(res, 200, { bank_id: bank });
      }

      if (method === 'POST' && rest === '/memories') {
        const items = (body as { items?: unknown } | undefined)?.items;
        if (!Array.isArray(items)) return send(res, 422, { detail: 'items required' });
        const facts = state.banks.get(bank) ?? [];
        state.banks.set(bank, facts);
        for (const raw of items as Array<Record<string, unknown>>) {
          if (typeof raw['content'] !== 'string') return send(res, 422, { detail: 'content required' });
          counter += 1;
          const documentId = typeof raw['document_id'] === 'string' ? raw['document_id'] : `doc-${counter}`;
          for (let i = facts.length - 1; i >= 0; i -= 1) if (facts[i]!.documentId === documentId) facts.splice(i, 1);
          facts.push({
            id: `fact-${counter}`,
            text: raw['content'],
            context: typeof raw['context'] === 'string' ? raw['context'] : null,
            tags: Array.isArray(raw['tags']) ? (raw['tags'] as unknown[]).filter((t): t is string => typeof t === 'string') : [],
            metadata: (raw['metadata'] ?? {}) as Record<string, string>,
            documentId,
            type: 'world',
          });
        }
        return send(res, 200, { success: true, bank_id: bank, items_count: items.length, async: false });
      }

      if (method === 'POST' && rest === '/memories/recall') {
        const request = (body ?? {}) as { query?: unknown; tags?: unknown };
        if (typeof request.query !== 'string') return send(res, 422, { detail: 'query required' });
        const wanted = new Set(words(request.query));
        const tags = Array.isArray(request.tags) ? (request.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
        const ranked = (state.banks.get(bank) ?? [])
          .filter((f) => tags.every((t) => f.tags.includes(t)))
          .map((f) => ({ f, score: words(f.text).filter((w) => wanted.has(w)).length }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);
        return send(res, 200, {
          results: ranked.map(({ f }) => ({
            id: f.id,
            text: f.text,
            type: f.type,
            context: f.context,
            tags: f.tags,
            metadata: f.metadata,
            document_id: f.documentId,
          })),
        });
      }

      const doc = /^\/documents\/([^/]+)$/.exec(rest);
      if (method === 'DELETE' && doc?.[1] !== undefined) {
        const documentId = decodeURIComponent(doc[1]);
        const facts = state.banks.get(bank) ?? [];
        const kept = facts.filter((f) => f.documentId !== documentId);
        if (kept.length === facts.length) return send(res, 404, { detail: 'Document not found' });
        state.banks.set(bank, kept);
        return send(res, 200, { success: true, deleted: facts.length - kept.length });
      }
      return send(res, 404, { detail: 'Not Found' });
    })().catch(() => send(res, 500, { detail: 'fake failed' }));
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 0);
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    banksTouched: () => [...new Set(state.calls.map((c) => c.bank).filter((b): b is string => b !== null))],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
