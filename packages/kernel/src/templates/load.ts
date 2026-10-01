import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TeamTemplate } from '@majlis/shared';
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

/**
 * Loads every `<dir>/<id>/template.yaml` + `TEAM.md` pair and validates it as a TeamTemplate.
 * Sorted by id. Throws TemplateLoadError on the first problem (file + field named); ids must be unique
 * and must match their folder name.
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
    const result = TeamTemplate.safeParse({ ...raw, teamMd });
    if (!result.success) {
      const issue = result.error.issues[0];
      if (!issue) throw new TemplateLoadError(yamlFile, null, 'invalid template');
      const file = issue.path[0] === 'teamMd' ? teamMdFile : yamlFile;
      throw new TemplateLoadError(file, fieldOf(issue), issue.message);
    }
    const template = result.data;
    if (template.id !== entry.name) throw new TemplateLoadError(yamlFile, 'id', `"${template.id}" must match folder name "${entry.name}"`);
    const prior = seen.get(template.id);
    if (prior) throw new TemplateLoadError(yamlFile, 'id', `duplicate id "${template.id}" (also in ${prior})`);
    seen.set(template.id, yamlFile);
    templates.push(template);
  }
  return templates;
}
