import type { FetchedDocument, RemoteChanges } from '@manythreads/sdk';
import type { ConnectorRoot, DocumentAccess } from '@manythreads/shared';
import type { DocHttp, Memo } from './http.ts';

// The shape every document reader has (PLAN Bundle D, P16-08): one object per service, given the HTTP client that rides on the person's grant. The facade in
// ../documents-provider.ts finds the grant, builds the client, and turns a `DocError` into the door's error codes; a reader only reads the service.

export interface AdapterCtx {
  http: DocHttp;
  /** Short-lived lookups shared by the calls of one grant (a folder's parent, a space's permissions). Keys must start with `prefix`. */
  memo: Memo;
  /** Names this grant in `memo` keys, so two people never share an entry. */
  prefix: string;
  now(): Date;
}

export interface DocAdapter {
  /** The folders, spaces, sites or databases the person can pick (at most 200). */
  listRoots(ctx: AdapterCtx): Promise<ConnectorRoot[]>;
  /**
   * One page of what changed under `root` since `cursor` (null: everything). `cursor` may be a resume point inside a pass: a reader's `cursor` answer is ALWAYS a valid
   * input to the next call, and while `next` is not null it is the same string, so a caller that stops after N documents stores `cursor` and carries on from there.
   */
  listChanges(ctx: AdapterCtx, input: { root: string; cursor: string | null }): Promise<RemoteChanges>;
  /** The bytes of one document (text kinds cut at 10 MB, a binary kind over it refused). */
  fetch(ctx: AdapterCtx, remoteId: string): Promise<FetchedDocument>;
  /** Who may open it at the service. Anything that could not be read is `groups: true`. */
  access(ctx: AdapterCtx, remoteId: string): Promise<DocumentAccess>;
}

/** An id that came from the person's pick or from our own resume state: plain characters only, so it can sit in a path or a query of ours. */
export const SAFE_ID = /^[A-Za-z0-9_.!~=:@$,+-]{1,300}$/;
export const safeId = (id: string): boolean => SAFE_ID.test(id) && !/^\.+$/.test(id);
