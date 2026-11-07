import type { CustomEmoji } from '@manythreads/shared';
import { EMOJI_GROUPS, SHORTCODE_ALIASES } from './emoji';

/*
 * The `:emoji:` list that opens while typing (PLAN P21-04): a colon that starts a word and two letters after it. Plain functions; the composer draws the list.
 */

export type EmojiTrigger = { query: string; start: number };

/** A `:` that starts a word with two or more name characters after it and up to the caret. A time (10:30), an address (http://) and a finished `:name:` do not open it. */
export function detectEmojiTrigger(text: string, caret: number): EmojiTrigger | null {
  const m = /(^|[\s(])(:)([a-z][a-z0-9_+-]{1,29})$/i.exec(text.slice(0, caret));
  if (!m) return null;
  const query = m[3] ?? '';
  return { query, start: caret - query.length - 1 };
}

export type EmojiSuggestion = {
  /** The name without colons (`smile`, or a custom emoji's name). */
  code: string;
  /** The character for a built-in emoji; null for a custom one. */
  char: string | null;
  custom: CustomEmoji | null;
};

type Candidate = EmojiSuggestion & { words: string[]; order: number };

let table: Candidate[] | null = null;

/** Every built-in emoji once (the first picker group that holds it), plus the aliases people know (`+1`, `thumbsup`). */
function builtins(): Candidate[] {
  if (table) return table;
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let order = 0;
  for (const g of EMOJI_GROUPS) {
    for (const e of g.items) {
      if (seen.has(e.char)) continue;
      seen.add(e.char);
      out.push({ code: '', char: e.char, custom: null, words: e.name.toLowerCase().split(/\s+/).filter(Boolean), order: order++ });
    }
  }
  for (const [alias, char] of Object.entries(SHORTCODE_ALIASES)) {
    const hit = out.find((c) => c.char === char);
    if (hit && !hit.words.includes(alias)) hit.words.push(alias);
  }
  table = out;
  return out;
}

/** 0: a word of the name is the query; 1: a word starts with it; 2: the name has it inside; null: no match. */
function scoreOf(words: readonly string[], q: string): { score: number; word: string } | null {
  const exact = words.find((w) => w === q);
  if (exact) return { score: 0, word: exact };
  const prefix = words.find((w) => w.startsWith(q));
  if (prefix) return { score: 1, word: prefix };
  const inside = words.find((w) => q.length >= 3 && w.includes(q));
  if (inside) return { score: 2, word: inside };
  return null;
}

/**
 * The emoji a typed `:query` points at, best first, at most `limit`: the workspace's own pictures and the built-in ones together. A name that is the query
 * comes first, then names that start with it, then names that hold it; within a step a custom emoji comes before a built-in one.
 */
export function suggestEmoji(query: string, custom: readonly CustomEmoji[], limit = 8): EmojiSuggestion[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, '');
  if (q.length < 2) return [];
  const hits: Array<{ score: number; kind: number; order: number; item: EmojiSuggestion }> = [];
  custom.forEach((c, i) => {
    const hit = scoreOf([c.name.toLowerCase(), ...c.name.toLowerCase().split('_')], q);
    if (hit) hits.push({ score: hit.score, kind: 0, order: i, item: { code: c.name, char: null, custom: c } });
  });
  for (const b of builtins()) {
    const hit = scoreOf(b.words, q);
    if (hit) hits.push({ score: hit.score, kind: 1, order: b.order, item: { code: hit.word.replace(/[^a-z0-9_+-]/g, ''), char: b.char, custom: null } });
  }
  hits.sort((a, b) => a.score - b.score || a.kind - b.kind || a.order - b.order);
  return hits.slice(0, limit).map((h) => h.item);
}
