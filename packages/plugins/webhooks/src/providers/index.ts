import type { ProviderEventKind, WebhookProvider } from '@manythreads/shared';
import { asana } from './asana.ts';
import { generic } from './generic.ts';
import { github } from './github.ts';
import { gitlab } from './gitlab.ts';
import { hubspot } from './hubspot.ts';
import { intercom } from './intercom.ts';
import { jira } from './jira.ts';
import { linear } from './linear.ts';
import { EVENT_AGE_MS } from './common.ts';
import { zendesk } from './zendesk.ts';

// Work package H (P16-10, decisions D18, D19): one pure reader per work app. `verify` checks the app's own signature on the RAW body (constant time, with the replay window
// the app documents) and `normalise` turns the JSON into the one event shape the rest of the platform reads. Both are pure functions, so the fake-saas sender and the
// verifiers agree on one set of test vectors (webhooks/test/provider-verify.test.ts).

export type VerifyResult = { ok: true } | { ok: false; reason: 'bad_signature' | 'stale' };

export interface NormalisedProviderEvent {
  kind: ProviderEventKind;
  /** The app's id of the thing, for a link back. */
  externalId: string;
  url: string | null;
  /** At most 200 characters; outside text, data only. */
  title: string;
  /** At most 80 characters. */
  actor: string;
}

export interface ProviderReader {
  provider: WebhookProvider;
  /** `secret` is the signing secret in the clear; `now` is the server's clock in milliseconds. Headers are lower-cased. */
  verify(input: { headers: Readonly<Record<string, string | undefined>>; rawBody: Uint8Array; secret: string; now: number; method: string; uri: string }): VerifyResult;
  /** The app's own id of this delivery (a header or a field of the body), or null: the door then uses a hash of the body. Called after the signature held. */
  deliveryKey(headers: Readonly<Record<string, string | undefined>>, body: unknown): string | null;
  /** When the event happened, in milliseconds, for the apps that send no timestamp with their signature: a call about an event older than seven days is stale. Null: unknown. */
  eventTime?(headers: Readonly<Record<string, string | undefined>>, body: unknown): number | null;
  /** Null: understood and ignored. */
  normalise(input: { headers: Readonly<Record<string, string | undefined>>; body: unknown }): NormalisedProviderEvent | null;
}

export const PROVIDER_READERS: Readonly<Record<WebhookProvider, ProviderReader>> = { github, gitlab, jira, linear, zendesk, intercom, hubspot, asana, generic };

export type Judgement = { ok: true; body: unknown } | { ok: false; reason: 'bad_signature' | 'stale' | 'bad_body' };

/**
 * The whole of "is this call from the app, and is it fresh": the signature over the raw bytes first (nothing is parsed before it holds), then the body as JSON, then the event's own
 * age for the apps that send no timestamp with their signature. Pure; the door and the tests call this one function.
 */
export function judgeDelivery(
  reader: ProviderReader,
  input: { headers: Readonly<Record<string, string | undefined>>; rawBody: Uint8Array; secret: string; now: number; method: string; uri: string },
): Judgement {
  const verdict = reader.verify(input);
  if (!verdict.ok) return verdict;
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(input.rawBody).toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_body' };
  }
  const happened = reader.eventTime?.(input.headers, body) ?? null;
  if (happened !== null && input.now - happened > EVENT_AGE_MS) return { ok: false, reason: 'stale' };
  return { ok: true, body };
}
