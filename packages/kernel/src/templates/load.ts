import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TEMPLATE_FILE_MAX_CHARS, TeamTemplate, botEvalSetPath, parseBotEvalSet, parseBotMd } from '@manythreads/shared';
import { parse } from 'yaml';
import type { z } from 'zod';

/** Names the file and the field that failed, e.g. `templates/x/template.yaml: channels.0.name: ...`. */
export class TemplateLoadError extends Error {
  constructor(
    readonly file: string,
    readonly field: string | null,
    detail: string,
  ) {
    super(`${file}${field ? `: ${field}` : ''}: ${detail}`);
    this.name = 'TemplateLoadError';
  }
}

const readText = async (file: string): Promise<string> => {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    throw new TemplateLoadError(file, null, `cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
};

const fieldOf = (issue: z.core.$ZodIssue): string => {
  const p = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') p.push(issue.keys.join(','));
  return p.join('.') || '(root)';
};

/** The names a template's bot folder may hold: its definition, and scenario sets under `evals/`. Anything else is a typo, not an extension. */
const EVALS_DIR = 'evals';

/**
 * The bot files of one template: `bots/<slug>/BOT.md` and `bots/<slug>/evals/<set>.yaml`, keyed by their path in the team repo. A template
 * without a `bots/` folder ships none. Every file is read as text and refused when it is larger than a template file may be.
 */
async function readBotFiles(templateDir: string): Promise<Record<string, string>> {
  const botsDir = path.join(templateDir, 'bots');
  let slugs: Dirent[];
  try {
    slugs = (await readdir(botsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new TemplateLoadError(botsDir, null, `cannot read (${err instanceof Error ? err.message : String(err)})`);
  }
  const files: Record<string, string> = {};
  const take = async (file: string, key: string): Promise<void> => {
    const text = await readText(file);
    if (text.length > TEMPLATE_FILE_MAX_CHARS) throw new TemplateLoadError(file, null, `is larger than ${TEMPLATE_FILE_MAX_CHARS / 1024} KB`);
    files[key] = text;
  };
  for (const slug of slugs) {
    const folder = path.join(botsDir, slug.name);
    if (!slug.isDirectory()) throw new TemplateLoadError(folder, null, 'only bot folders belong in bots/');
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(folder, entry.name);
      if (entry.isFile() && entry.name === 'BOT.md') {
        await take(file, `bots/${slug.name}/BOT.md`);
      } else if (entry.isDirectory() && entry.name === EVALS_DIR) {
        for (const set of (await readdir(file, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (!set.isFile() || !set.name.endsWith('.yaml')) {
            throw new TemplateLoadError(path.join(file, set.name), null, 'only <set>.yaml scenario sets belong in evals/');
          }
          await take(path.join(file, set.name), `bots/${slug.name}/${EVALS_DIR}/${set.name}`);
        }
      } else {
        throw new TemplateLoadError(file, null, 'a template bot folder holds BOT.md and evals/<set>.yaml only');
      }
    }
  }
  return files;
}

/**
 * What the schema cannot say about the bot files: every `BOT.md` parses with the shared BOT.md schema, a definition's `evals.set` is a file that
 * exists and reads as a scenario set of that name, and Brain is in every template (SPEC §5.3). A broken definition stops the server at start, like a
 * broken channel list, because a team created from it would otherwise get a bot the loader refuses.
 */
function checkBotFiles(templateDir: string, files: Record<string, string>): void {
  const file = (key: string): string => path.join(templateDir, ...key.split('/'));
  if (files['bots/brain/BOT.md'] === undefined) {
    throw new TemplateLoadError(file('bots/brain/BOT.md'), null, 'every team template ships Brain: bots/brain/BOT.md is missing');
  }
  for (const [key, text] of Object.entries(files)) {
    const bot = /^bots\/([^/]+)\/BOT\.md$/.exec(key);
    if (bot) {
      const parsed = parseBotMd(text);
      if (!parsed.ok) throw new TemplateLoadError(file(key), parsed.failure.fieldPath, parsed.failure.message);
      const set = parsed.frontmatter.evals?.set;
      if (set !== undefined) {
        const setKey = botEvalSetPath(bot[1]!, set);
        if (files[setKey] === undefined) throw new TemplateLoadError(file(key), 'evals.set', `names "${set}" but ${setKey} does not exist`);
      }
      continue;
    }
    const evals = /^bots\/([^/]+)\/evals\/(.+)\.yaml$/.exec(key);
    if (evals) {
      const parsed = parseBotEvalSet(text);
      if (!parsed.ok) throw new TemplateLoadError(file(key), null, parsed.message);
      if (parsed.set.set !== evals[2]) throw new TemplateLoadError(file(key), 'set', `"${parsed.set.set}" must match the file name "${evals[2]}"`);
    }
  }
}

/**
 * Loads every `<dir>/<id>/template.yaml` + `TEAM.md` pair and validates it as a TeamTemplate, together with the bot files under
 * `<dir>/<id>/bots/` (BOT.md and scenario sets, validated with the shared schemas). Sorted by id. Throws TemplateLoadError on the first problem
 * (file + field named); ids must be unique and must match their folder name.
 */
export async function loadTemplates(dir: string): Promise<TeamTemplate[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const templates: TeamTemplate[] = [];
  const seen = new Map<string, string>();
  for (const entry of entries) {
    const yamlFile = path.join(dir, entry.name, 'template.yaml');
    const teamMdFile = path.join(dir, entry.name, 'TEAM.md');
    let raw: unknown;
    try {
      raw = parse(await readText(yamlFile));
    } catch (err) {
      if (err instanceof TemplateLoadError) throw err;
      throw new TemplateLoadError(yamlFile, null, `invalid YAML (${err instanceof Error ? err.message : String(err)})`);
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new TemplateLoadError(yamlFile, null, 'expected a mapping');
    const teamMd = await readText(teamMdFile);
    if ('teamMd' in raw) throw new TemplateLoadError(yamlFile, 'teamMd', 'comes from TEAM.md, remove it from template.yaml');
    if ('files' in raw) throw new TemplateLoadError(yamlFile, 'files', 'come from the bots/ folder, remove it from template.yaml');
    const templateDir = path.join(dir, entry.name);
    const files = await readBotFiles(templateDir);
    const result = TeamTemplate.safeParse({ ...raw, teamMd, files });
    if (!result.success) {
      const issue = result.error.issues[0];
      if (!issue) throw new TemplateLoadError(yamlFile, null, 'invalid template');
      const file =
        issue.path[0] === 'teamMd' ? teamMdFile : issue.path[0] === 'files' && typeof issue.path[1] === 'string' ? path.join(templateDir, ...issue.path[1].split('/')) : yamlFile;
      throw new TemplateLoadError(file, fieldOf(issue), issue.message);
    }
    const template = result.data;
    if (template.id !== entry.name) throw new TemplateLoadError(yamlFile, 'id', `"${template.id}" must match folder name "${entry.name}"`);
    checkBotFiles(templateDir, files);
    const prior = seen.get(template.id);
    if (prior) throw new TemplateLoadError(yamlFile, 'id', `duplicate id "${template.id}" (also in ${prior})`);
    seen.set(template.id, yamlFile);
    templates.push(template);
  }
  return templates;
}
