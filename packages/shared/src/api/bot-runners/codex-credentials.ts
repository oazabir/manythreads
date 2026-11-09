// The Codex runner's sign-in file (PLAN Phase 19, P19-13). The admin uploads `auth.json` as it is; the server stores the bytes exactly and keeps only
// metadata, as for Claude (see credentials.ts). This module is the ONE reader of the file's shape for the browser and the server.
//
// STUB (Bundle E WP-0): the types are the contract other packages build on; `inspectCodexCredentials` refuses everything until WP-R3a fills it. The rules it
// must apply (decision E8): refuse the whole file when it is not JSON, when `auth_mode` is not the ChatGPT sign-in, when `OPENAI_API_KEY` is set (not null),
// when it is larger than MAX_CREDENTIALS_BYTES, or when a `__proto__` key is anywhere in it. The plan name is read from the `id_token` payload in the browser
// only. No function here returns a token except `refreshToken`, for the server's keyed hash, which must never be logged, echoed or stored.

export interface CodexCredentialsSummary {
  /** For example "ChatGPT Plus"; "ChatGPT plan" when the file does not say. */
  planLabel: string;
  /** The ChatGPT account id from `tokens.account_id`, for the server's keyed same-login hash. Never shown, never logged. */
  accountId: string;
}

export type CodexCredentialsInspection = { ok: true; summary: CodexCredentialsSummary; refreshToken: string } | { ok: false; message: string };

/** Reads a Codex sign-in file's text and says what it is, or why it is refused. Stub: refuses every file until the reader is built. */
export function inspectCodexCredentials(text: string): CodexCredentialsInspection {
  void text;
  return { ok: false, message: 'not built' };
}
