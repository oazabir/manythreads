import type { PluginContext, PluginTx } from '@manythreads/sdk';
import { safeFetch, SafeFetchError, type SafeFetchDeps, type SafeFetchErrorCode } from '@manythreads/sdk/safe-fetch';
import { findDocument, ingest, sha256Hex, type BaseRef, type DocumentKind, type IngestResult } from './ingest.ts';
import { extractText, ExtractError, maxExtractBytes } from './extract/index.ts';
import { DOC_COLUMNS, DOC_FROM, type DocRow, type SourceRow } from './rows.ts';

// A web page or file as a source (PLAN P8-07, P8-08): the platform fetches one address on the source's rhythm, turns it into text, and the usual
// path (hash comparison, new version only when the text changed, passages, the converted copy in the repo) does the rest. What makes this safe to
// offer to a team lead:
//  * the fetch is the SDK's `safeFetch` (public addresses only, ports 80 and 443, redirects re-checked, one clock for the whole read, a byte cap),
//  * the `pre_egress` chain runs before every address it reaches (an air-gapped workspace reads nothing, a strict one only its allowed hosts), and
//    fails closed when no guard is loaded,
//  * the page is read by the bounded extractor in a worker thread like any upload.
// A page is compared by its TEXT: a page whose markup or script changes on every load but says the same thing is not a new version.

const FETCH_MS = 15_000;
const MAX_REDIRECTS = 3;

let testDeps: SafeFetchDeps | undefined;
/** Tests only: where addresses are resolved and dialled (a local fake site). */
export function setFetchDepsForTests(deps: SafeFetchDeps | undefined): void {
  testDeps = deps;
}

const WORDS: Record<SafeFetchErrorCode, string> = {
  bad_url: 'That address is not one this can read.',
  blocked_scheme: 'Only http and https addresses can be read.',
  blocked_port: 'Only the usual web ports (80 and 443) can be read.',
  blocked_host: 'That address is inside this deployment or a private network, which is not read.',
  blocked_address: 'That address is inside this deployment or a private network, which is not read.',
  blocked_by_policy: 'The workspace guard does not let this address be read.',
  host_cooling: 'That site did not answer a moment ago; it will be tried again later.',
  dns_failed: 'The site’s name could not be found.',
  too_many_redirects: 'The address sends the reader round in circles.',
  bad_redirect: 'The address sends the reader somewhere that is not allowed.',
  timeout: 'The site took too long to answer.',
  too_large: 'The page or file is larger than the limit.',
  bad_status: 'The site answered with an error.',
  bad_type: 'That address is not a page or a file this can read (web page, PDF, Markdown, text or CSV).',
  bad_encoding: 'The site’s answer could not be unpacked.',
  network: 'The site could not be reached.',
};

export function fetchFailureWords(err: unknown): string {
  if (err instanceof SafeFetchError) {
    if (err.code === 'bad_status' && err.status !== null) return `The site answered with an error (${String(err.status)}).`;
    if (err.code === 'blocked_by_policy' && err.message.trim().length > 0 && err.message.length <= 300) return err.message;
    return WORDS[err.code];
  }
  return 'The site could not be read.';
}

/** The workspace's model-guard preset and egress allowlist, when the model gateway keeps them (they decide `air-gapped` and `strict-egress`). */
async function egressSetup(tx: PluginTx, workspaceId: string): Promise<{ preset: string; allowlist: string[] }> {
  const present = (await tx.query<{ ok: boolean }>(`SELECT to_regclass('app.llm_settings') IS NOT NULL AS ok`)).rows[0]?.ok === true;
  if (!present) return { preset: 'standard', allowlist: [] };
  const row = (await tx.query<{ preset: string; egress_allowlist: string[] }>('SELECT preset, egress_allowlist FROM app.llm_settings WHERE workspace_id = $1::uuid', [workspaceId])).rows[0];
  return { preset: row?.preset ?? 'standard', allowlist: row?.egress_allowlist ?? [] };
}

export interface FetchedPage {
  kind: DocumentKind;
  bytes: Uint8Array;
  /** The final address, after redirects. */
  url: string;
}

const ACCEPT = 'text/html,text/markdown,text/plain,text/csv,application/pdf;q=0.9,*/*;q=0.1';
const TYPE = /^(text\/(html|markdown|x-markdown|plain|csv)|application\/(xhtml\+xml|pdf|octet-stream))\b/i;

function kindOf(contentType: string | null, url: URL): 'html' | DocumentKind {
  const type = (contentType ?? '').toLowerCase();
  const path = url.pathname.toLowerCase();
  if (type.startsWith('application/pdf') || path.endsWith('.pdf')) return 'pdf';
  if (type.startsWith('text/csv') || path.endsWith('.csv')) return 'csv';
  if (type.includes('markdown') || path.endsWith('.md') || path.endsWith('.markdown')) return 'markdown';
  if (type.startsWith('text/plain') || path.endsWith('.txt')) return 'text';
  return 'html';
}

/** Reads one address through the guard. Throws `SafeFetchError` (or an `ExtractError` when the page has no text). A web page comes back as Markdown. */
export async function fetchSourcePage(ctx: PluginContext, tx: PluginTx, workspaceId: string, teamId: string, address: string): Promise<FetchedPage> {
  const setup = await egressSetup(tx, workspaceId);
  const result = await safeFetch(
    address,
    {
      maxBytes: maxExtractBytes(),
      timeoutMs: FETCH_MS,
      maxRedirects: MAX_REDIRECTS,
      overflow: 'fail',
      accept: ACCEPT,
      contentType: TYPE,
      userAgent: 'Mozilla/5.0 (compatible; ManythreadsKnowledge/1.0)',
      check: async (url) => {
        const decision = await ctx.hooks.runPreEgress(tx, {
          destination: 'knowledge_source',
          workspaceId,
          teamId,
          text: url.href,
          preset: setup.preset,
          allowlist: setup.allowlist,
          targets: [{ name: 'knowledge', host: url.hostname.toLowerCase(), local: false }],
          recorded: false,
        });
        if (decision.hooks === 0 || decision.outcome !== 'allow') {
          throw new SafeFetchError('blocked_by_policy', decision.message ?? 'The workspace guard does not let this address be read.');
        }
      },
    },
    testDeps,
  );
  const kind = kindOf(result.contentType, result.url);
  if (kind !== 'html') return { kind, bytes: result.body, url: result.url.href };
  const read = await extractText(result.body, 'html');
  return { kind: 'markdown', bytes: new TextEncoder().encode(read.text), url: result.url.href };
}

/** The name a web document shows: what the lead called it, else the address without its scheme, cut to fit. */
export function nameOfSource(source: Pick<SourceRow, 'url' | 'label'>): string {
  if (source.label) return source.label.slice(0, 200);
  const bare = (source.url ?? 'web page').replace(/^https?:\/\//i, '').replace(/[/?#]+$/, '');
  return bare.slice(0, 200) || 'web page';
}

export type UrlSyncOutcome = IngestResult['outcome'] | 'error';

/**
 * Reads a `url` source once and moves its document: unchanged text changes nothing, new text is the next version (the old passages stay for citations),
 * a page that cannot be read leaves the last good version in use and puts the reason on the source (which makes the base ask for attention).
 */
export async function syncUrlSource(ctx: PluginContext, tx: PluginTx, base: BaseRef, source: SourceRow): Promise<{ outcome: UrlSyncOutcome; blobsToDelete: string[] }> {
  const at = ctx.runtime.now();
  const fail = async (reason: string): Promise<{ outcome: UrlSyncOutcome; blobsToDelete: string[] }> => {
    await tx.query('UPDATE app.knowledge_sources SET last_synced_at = $2, error = $3 WHERE id = $1', [source.id, at, reason.slice(0, 400)]);
    return { outcome: 'error', blobsToDelete: [] };
  };
  let page: FetchedPage;
  await tx.query('SAVEPOINT knowledge_fetch');
  try {
    page = await fetchSourcePage(ctx, tx, base.workspaceId, base.teamId, source.url as string);
    await tx.query('RELEASE SAVEPOINT knowledge_fetch');
  } catch (err) {
    await tx.query('ROLLBACK TO SAVEPOINT knowledge_fetch');
    await tx.query('RELEASE SAVEPOINT knowledge_fetch');
    return fail(err instanceof ExtractError ? err.message : fetchFailureWords(err));
  }
  const existing = (await tx.query<DocRow>(`SELECT ${DOC_COLUMNS} FROM ${DOC_FROM} WHERE d.source_id = $1`, [source.id])).rows[0];
  // a new document must not take over another source's document of the same name
  let name = existing?.name ?? nameOfSource(source);
  if (!existing) {
    for (let n = 2; (await findDocument(tx, base.id, { name })) !== undefined && n < 50; n++) name = `${nameOfSource(source).slice(0, 190)} (${String(n)})`;
  }
  const result = await ingest(
    ctx,
    tx,
    base,
    { name, kind: page.kind, bytes: page.bytes, sha256: sha256Hex(page.bytes), size: page.bytes.length, blobKey: null, source: 'url', sourceId: source.id },
    existing ? { id: existing.id } : undefined,
  );
  await tx.query('UPDATE app.knowledge_sources SET last_synced_at = $2, error = NULL WHERE id = $1', [source.id, at]);
  return { outcome: result.outcome, blobsToDelete: result.blobsToDelete };
}
