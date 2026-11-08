/*
 * What fake-saas itself remembers, beside what each stand-in keeps: the webhooks its sender posted. It holds no secret: the signing secret a test passes in is used to
 * sign and then forgotten, and only the headers it produced are kept.
 */

export interface SentWebhook {
  provider: string;
  kind: string;
  tamper: string;
  /** Where it was posted, without the query. */
  target: string;
  /** What the receiver answered, per attempt (a replay posts twice). */
  statuses: number[];
  at: string;
}

export interface FakeSaasState {
  webhooksSent: SentWebhook[];
}

export function createState(): FakeSaasState {
  return { webhooksSent: [] };
}

export function resetState(state: FakeSaasState): void {
  state.webhooksSent.length = 0;
}
