import {
  ANSWER_LIMITS,
  ANSWER_MASKED_KIND,
  AnswerPayload,
  type AnswerCitation,
  type AnswerLineageEntry,
  type AnswerOutsideReason,
} from '../entities/answer.ts';
import { removeClaims } from './claims.ts';

// Masking an answer for the people a copy of it is shared with (SPEC §6.3, PLAN P5-17). The decision "may this reader open that source" is not
// made here: the database asks the platform's own policies, as the sharer, against the readers of the place the copy goes to
// (`app.answer_share_view`), and hands this function a verdict per citation. What this function does is the part that must be a pure, tested
// rule: given the original payload, the verdicts and the claims the sharer removed, build the copy — and build it so that the copy can only be
// *less* than the original.
//
//   * a citation whose source the readers may open is kept, with the platform's current reading of its label (a message edited or deleted since
//     the answer was posted is read again, not copied);
//   * every other citation is replaced by a masked one: its number and the kind of source, nothing else — no label, no scope, no date, no
//     snippet, and none of the fields that say where the source lives. A citation with no verdict is masked: absent is never "may be shown";
//   * a citation the sharer removed is gone, with the sentences of the text that rested on it (`removeClaims`);
//   * "Sources reached" keeps what the readers may open; what it drops is counted as `not_shared` (a kind and a count, never a title);
//   * the chips go: a hand-off or a follow-up is the asker's own next step, not something readers of a channel act on;
//   * nothing is added: the text is a subsequence of the original, the citations are a subset by number, and the counts only grow by what was
//     taken out.

export interface CitationVerdict {
  /** The citation's number. */
  n: number;
  /** The readers may open it: the source is found as the sharer and is team-readable (or lives in the place the copy goes to). */
  kept: boolean;
  /** The platform's current label of a kept source. */
  label?: string | null | undefined;
  /** When it was written, as the platform reads it now. */
  at?: string | null | undefined;
}

export interface SourceVerdict {
  kept: boolean;
  /** The platform's current label of a kept source (read again, like a citation's). */
  label?: string | null | undefined;
}

export type ShareItemStatus = 'kept' | 'masked' | 'removed';

/** One citation as the sharer's preview lists it. `label` is the sharer's own view of what it was (it never reaches the copy). */
export interface ShareItem {
  n: number;
  kind: string;
  status: ShareItemStatus;
  label: string;
}

export interface MaskedAnswer {
  /** The copy to post; null when removing the claims left no text at all (nothing to share). */
  copy: AnswerPayload | null;
  items: ShareItem[];
  counts: { kept: number; masked: number; removed: number; sentences: number; sourcesDropped: number };
  maskedNumbers: number[];
  removedNumbers: number[];
  /** The words that were taken out with the removed claims, one entry per sentence: what the sharer's preview shows. */
  removedText: string[];
}

/** Cut to `max` with an ellipsis, never between the two halves of a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
};

/** The citation numbers of an answer, ascending: what a sharer may remove. */
export const citationNumbers = (payload: AnswerPayload): number[] => payload.citations.map((c) => c.n).sort((a, b) => a - b);

/**
 * Builds the copy of `original` that is posted to readers whose view the verdicts describe, with the claims on the citations in `remove` taken
 * out. `remove` names only numbers the answer has (the caller refuses others); a number it has not is ignored here.
 */
export function maskAnswer(
  original: AnswerPayload,
  verdicts: readonly CitationVerdict[],
  sources: readonly SourceVerdict[],
  remove: readonly number[],
): MaskedAnswer {
  const byN = new Map<number, CitationVerdict>();
  for (const v of verdicts) if (!byN.has(v.n)) byN.set(v.n, v);
  const removed = new Set(remove);
  const lineageByN = new Map<number, AnswerLineageEntry>();
  for (const l of original.lineage) if (!lineageByN.has(l.n)) lineageByN.set(l.n, l);

  const citations: AnswerCitation[] = [];
  const lineage: AnswerLineageEntry[] = [];
  const items: ShareItem[] = [];
  const maskedNumbers: number[] = [];
  const removedNumbers: number[] = [];
  for (const c of original.citations) {
    const was = c.kind === ANSWER_MASKED_KIND ? '' : c.label;
    const kindOf = c.kind === ANSWER_MASKED_KIND ? c.source : c.kind;
    if (removed.has(c.n)) {
      removedNumbers.push(c.n);
      items.push({ n: c.n, kind: kindOf, status: 'removed', label: was });
      continue;
    }
    const v = byN.get(c.n);
    if (v?.kept === true && c.kind !== ANSWER_MASKED_KIND) {
      const label = clip(v.label !== undefined && v.label !== null && v.label.trim() !== '' ? v.label.trim() : c.label, ANSWER_LIMITS.label);
      citations.push({ ...c, label });
      const old = lineageByN.get(c.n);
      if (old) {
        lineage.push({
          n: c.n,
          kind: old.kind,
          label,
          at: v.at !== undefined && v.at !== null ? v.at : old.at,
          // the bot's quote was taken from the source as it was: a source that reads otherwise now (edited since) keeps no quote
          snippet: label === old.label ? old.snippet : null,
        });
      }
      items.push({ n: c.n, kind: kindOf, status: 'kept', label });
    } else {
      maskedNumbers.push(c.n);
      citations.push({ kind: ANSWER_MASKED_KIND, n: c.n, source: kindOf });
      lineage.push({ n: c.n, kind: kindOf, label: '', at: null, snippet: null, masked: true });
      items.push({ n: c.n, kind: kindOf, status: 'masked', label: was });
    }
  }

  // what the run read: kept when the readers may open it; the rest is counted by kind, never named
  const reached: AnswerPayload['sourcesReached'] = [];
  const dropped = new Map<string, number>();
  original.sourcesReached.forEach((s, i) => {
    const verdict = sources[i];
    if (verdict?.kept === true) {
      const now = verdict.label !== undefined && verdict.label !== null && verdict.label.trim() !== '' ? clip(verdict.label.trim(), ANSWER_LIMITS.label) : s.label;
      reached.push({ ...s, label: now });
    } else dropped.set(s.kind, (dropped.get(s.kind) ?? 0) + 1);
  });
  const outsideItems = original.outsideScope.items.map((i) => ({ ...i }));
  let sourcesDropped = 0;
  for (const [kind, count] of dropped) {
    sourcesDropped += count;
    const reason: AnswerOutsideReason = 'not_shared';
    const hit = outsideItems.find((i) => i.kind === kind && i.reason === reason);
    if (hit) hit.count += count;
    else outsideItems.push({ kind, reason, count });
  }

  const { body, sentences, removed: removedText } = removeClaims(original.body, removed);
  const copy = body.trim() === '' ? null : AnswerPayload.parse({
    version: 1,
    body,
    citations,
    lineage,
    sourcesReached: reached,
    outsideScope: { count: original.outsideScope.count + sourcesDropped, items: outsideItems.slice(0, ANSWER_LIMITS.outside * 3) },
    answeredFor: original.answeredFor,
    chips: [],
    share: { masked: maskedNumbers.length, removed: removedNumbers.length },
  });
  return {
    copy,
    items,
    counts: {
      kept: citations.length - maskedNumbers.length,
      masked: maskedNumbers.length,
      removed: removedNumbers.length,
      sentences,
      sourcesDropped,
    },
    maskedNumbers,
    removedNumbers,
    removedText: removedText.slice(0, 200),
  };
}
