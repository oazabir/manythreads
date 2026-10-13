import type { MemoryLogLine } from '@manythreads/sdk';
import { DEFER_GIVE_UP_MS } from './constants.ts';
import { documentIdFor, conceptDigest, type ConceptItem } from './render.ts';

// The whole of "what should happen to the bank for this concept", as one pure function of (what the file is now, what the log says is in the
// bank, how long the decision has been waiting). No database and no engine, so the table of cases is a unit test. The cases are the feed's
// (docs/plugins/memory.md "How a change reaches the bank"), for one kind of source:
//
//   idempotent   the same concept delivered again is a no-op (the newest line is `retained` with the same digest)
//   replace      an edit is a new document: the old one is forgotten first (an edit may be the correction of a mistake or a secret), then the new one in
//   forget       the file was deleted, is no longer a concept, or is `deprecated`: the document goes; nothing was ever held = nothing to do
//   withhold     the concept cannot be put in the bank (it is not valid OKF, or the bot run that wrote it read something narrower than the team):
//                nothing is retained, a `withheld` line says why (once per reason), anything held for it goes
//   defer        the run that wrote it has not closed: look again; after a day it is withheld as `run_open`

export interface Provenance {
  teamId: string;
  workspaceId: string;
  actorId: string | null;
  link: string;
}

export type Resolution =
  | { action: 'retain'; at: Provenance; item: ConceptItem }
  | { action: 'forget'; reason: string }
  | { action: 'withhold'; at: Provenance; reason: string }
  | { action: 'defer'; at: Provenance; reason: string }
  | { action: 'skip'; reason: string };

export interface Decision {
  /** The document to take out of the bank, from the newest line. */
  forget: { documentId: string; reason: string } | null;
  /** The document to put in. */
  retain: { documentId: string; hash: string; item: ConceptItem; at: Provenance } | null;
  /** Nothing is retained and the log says why. */
  withhold: { at: Provenance; reason: string } | null;
  /** Come back later; the work row stays. */
  defer: { reason: string } | null;
}

const NOTHING: Decision = { forget: null, retain: null, withhold: null, defer: null };

export function decide(input: { path: string; res: Resolution; last: MemoryLogLine | null; deferredForMs: number; key: Buffer | string }): Decision {
  const { res, last } = input;
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
      const hash = conceptDigest(res.item, input.key);
      if (held && held.content_hash === hash) return NOTHING;
      const documentId = documentIdFor(input.path, hash);
      return {
        // the same id can only come back with the same digest, so a different id is a different version of the concept
        forget: held && held.document_id !== documentId ? { documentId: held.document_id as string, reason: 'replaced' } : null,
        retain: { documentId, hash, item: res.item, at: res.at },
        withhold: null,
        defer: null,
      };
    }
  }
}
