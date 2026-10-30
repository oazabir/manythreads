import type { EvalBotDefinition } from './eval-run.ts';
import { BOT_EVAL_FOLDER, botEvalSetPath, parseBotEvalSet, type BotEvalSet } from './evals.ts';
import { parseBotMd } from './render.ts';

// Reading a bot's definition and its scenario set for a run (PLAN P7-08). The reading itself (the team repo at a commit, or a folder on disk) is the
// caller's: it passes `read`, which answers a file's text or null when there is no such file. Everything here is parsing and the plain sentence for
// each way a bot can fail to be runnable, so the server's job, the CLI and the tests say the same thing.

/** The bot, ready to run: its definition for the answerer and the set named by `evals.set`. */
export interface LoadedEval {
  definition: EvalBotDefinition;
  set: BotEvalSet;
  setPath: string;
  minScore: number;
}

export type LoadEvalResult =
  | { ok: true; loaded: LoadedEval }
  /**
   * `kind` tells the caller what to do: `no_evals` is not an error (the bot has no set), the others are. `set` is the name BOT.md gives the set,
   * when it got that far, and `minScore` its minimum.
   */
  | { ok: false; kind: 'no_definition' | 'bad_definition' | 'no_evals' | 'no_set_file' | 'bad_set'; message: string; set?: string; minScore?: number };

export type ReadFile = (path: string) => Promise<string | null>;

/** `bots/<slug>/BOT.md` plus `bots/<slug>/evals/<set>.yaml`, parsed and cross-checked. Never throws for a file problem. */
export async function loadBotEval(slug: string, read: ReadFile): Promise<LoadEvalResult> {
  const botPath = `bots/${slug}/BOT.md`;
  const text = await read(botPath);
  if (text === null) return { ok: false, kind: 'no_definition', message: `There is no ${botPath}, so there is nothing to run.` };
  const parsed = parseBotMd(text);
  if (!parsed.ok) {
    return { ok: false, kind: 'bad_definition', message: `${botPath} does not load, so its evals cannot run: ${parsed.failure.message}` };
  }
  const evals = parsed.frontmatter.evals;
  if (!evals) return { ok: false, kind: 'no_evals', message: `${botPath} does not name a scenario set (evals: { set, minScore }), so this bot has no evals.` };

  const setPath = botEvalSetPath(slug, evals.set);
  const setText = await read(setPath);
  if (setText === null) {
    return {
      ok: false,
      kind: 'no_set_file',
      message: `${botPath} names the scenario set "${evals.set}", but the file ${setPath} does not exist. Add it, or change the name in BOT.md.`,
      set: evals.set,
      minScore: evals.minScore,
    };
  }
  const set = parseBotEvalSet(setText);
  if (!set.ok) return { ok: false, kind: 'bad_set', message: `${setPath} cannot be used: ${set.message}`, set: evals.set, minScore: evals.minScore };
  if (set.set.set !== evals.set) {
    return {
      ok: false,
      kind: 'bad_set',
      message: `${setPath} says "set: ${set.set.set}", but BOT.md names the set "${evals.set}". The two must match.`,
      set: evals.set,
      minScore: evals.minScore,
    };
  }
  return {
    ok: true,
    loaded: {
      definition: {
        slug,
        name: parsed.frontmatter.name,
        body: parsed.body,
        native: parsed.frontmatter.capabilities?.native ?? [],
        alias: parsed.frontmatter.model?.aliases?.[0] ?? null,
      },
      set: set.set,
      setPath,
      minScore: evals.minScore,
    },
  };
}

/**
 * Whether a changed repo path can change a bot's evals: its definition, or a file in its `evals/` folder. Returns the bot's slug, or null.
 * One folder deep, like the loader: `bots/a/b/BOT.md` is nobody's.
 */
export function evalBotOfPath(path: string): string | null {
  const m = /^bots\/([^/]+)\/(?:BOT\.md|evals\/[^/]+\.ya?ml)$/.exec(path);
  return m ? m[1]! : null;
}

export { BOT_EVAL_FOLDER };
