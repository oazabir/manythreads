import { DEFER_GIVE_UP_MS } from './constants.ts';
import { contentHash, documentIdFor, type FeedItem } from './render.ts';
import type { LastLine } from './rows.ts';
import type { Provenance, Resolution } from './sources.ts';

// The whole of "what should happen to the bank for this source", as one pure function of (what the source is now, what the log says is in
// the bank, how long the decision has been waiting). No database and no engine, so the table of cases is a unit test.
//
//   idempotent   the same text delivered again is a no-op (the newest line is `retained` with the same hash)
//   replace      an edit is a new document: the old one is forgotten first (an edit may be the correction of a mistake or a secret), then the new is retained
//   forget       deleted, emptied or no longer team-visible: the document goes; nothing was ever held = nothing to do
//   withhold     the narrowest-source rule: nothing is retained, a `withheld` line says why (once per reason); anything held for it goes
//   defer        a run has not closed: look again; after a day the source is withheld as `run_open`

export interface Decision {
  /** The document to take out of the bank, from the newest line. */
  forget: { documentId: string; reason: string } | null;
  /** The document to put in. */
  retain: { documentId: string; hash: string; item: FeedItem; at: Provenance } | null;
  /** Nothing is retained and the log says why. */
  withhold: { at: Provenance; reason: string } | null;
  /** Come back later; the work row stays. */
  defer: { reason: string } | null;
}

const NOTHING: Decision = { forget: null, retain: null, withhold: null, defer: null };

export function decide(input: { kind: string; sourceId: string; res: Resolution; last: LastLine | null; deferredForMs: number; key: Buffer | string }): Decision {
  const { kind, sourceId, res, last } = input;
  const held = last !== null && last.outcome === 'retained' && last.document_id !== null ? last : null;

  switch (res.action) {
    case 'skip':
      return NOTHING;

    case 'forget':
      return held ? { ...NOTHING, forget: { documentId: held.document_id as string, reason: res.reason } } : NOTHING;

    case 'defer':
      if (input.deferredForMs >= DEFER_GIVE_UP_MS) return decide({ ...input, res: { action: 'withhold', at: res.at, reason: res.reason } });
      return { ...NOTHING, defer: { reason: res.reason } };

    case 'withhold': {
      const again = last !== null && last.outcome === 'withheld' && last.reason === res.reason;
      return {
        forget: held ? { documentId: held.document_id as string, reason: res.reason } : null,
        retain: null,
        withhold: again ? null : { at: res.at, reason: res.reason },
        defer: null,
      };
    }

    case 'retain': {
      const hash = contentHash(res.item.content, input.key);
      if (held && held.content_hash === hash) return NOTHING;
      const documentId = documentIdFor(kind, sourceId, hash);
      return {
        // the same id can only come back with the same hash, so a different id is a different version of the source
        forget: held && held.document_id !== documentId ? { documentId: held.document_id as string, reason: 'replaced' } : null,
        retain: { documentId, hash, item: res.item, at: res.at },
        withhold: null,
        defer: null,
      };
    }
  }
}
