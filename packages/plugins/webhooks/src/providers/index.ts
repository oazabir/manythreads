import type { ProviderEventKind, WebhookProvider } from '@manythreads/shared';

// Work package H (P16-10, decisions D18, D19): one pure reader per work app. `verify` checks the app's own signature on the RAW body (constant time, with the replay window
// the app documents) and `normalise` turns the JSON into the one event shape the rest of the platform reads. Both are pure functions with published test vectors, so the
// fake-saas sender and the verifiers agree. STUB: no reader is registered until H fills the map; the door answers 501 meanwhile.

export type VerifyResult = { ok: true } | { ok: false; reason: 'bad_signature' | 'stale' };

export interface NormalisedProviderEvent {
  kind: ProviderEventKind;
  /** The app's id of the thing, for the dedupe key and for a link back. */
  externalId: string;
  url: string | null;
  /** At most 200 characters; outside text, data only. */
  title: string;
  /** At most 80 characters. */
  actor: string;
}

export interface ProviderReader {
  provider: WebhookProvider;
  /** `secret` is the signing secret in the clear; `now` is the server's clock in milliseconds. */
  verify(input: { headers: Readonly<Record<string, string>>; rawBody: Uint8Array; secret: string; now: number; method: string; uri: string }): VerifyResult;
  /** Null: understood and ignored. */
  normalise(input: { headers: Readonly<Record<string, string>>; body: unknown }): NormalisedProviderEvent | null;
}

export const PROVIDER_READERS: Readonly<Partial<Record<WebhookProvider, ProviderReader>>> = {};
