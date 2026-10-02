import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TeamTemplate } from '@manythreads/shared';
import { parse } from 'yaml';

/** `templates/` at the repository root unless MANYTHREADS_TEMPLATES_DIR says otherwise. */
export const defaultTemplatesDir = (): string =>
  process.env['MANYTHREADS_TEMPLATES_DIR'] ?? fileURLToPath(new URL('../../../../templates/', import.meta.url));

/**
 * Reads every `<dir>/<id>/template.yaml` + `TEAM.md` pair and validates it as a TeamTemplate (the same rules as the
 * kernel's loader: the id matches the folder, `teamMd` comes only from TEAM.md). Sorted by id. Throws naming the file.
 */
export async function loadTeamTemplates(dir: string = defaultTemplatesDir()): Promise<TeamTemplate[]> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const out: TeamTemplate[] = [];
  for (const entry of entries) {
    const yamlFile = path.join(dir, entry.name, 'template.yaml');
    const raw: unknown = parse(await readFile(yamlFile, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${yamlFile}: expected a mapping`);
    if ('teamMd' in raw) throw new Error(`${yamlFile}: teamMd comes from TEAM.md, remove it from template.yaml`);
    const teamMd = await readFile(path.join(dir, entry.name, 'TEAM.md'), 'utf8');
    const parsed = TeamTemplate.safeParse({ ...raw, teamMd });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${yamlFile}: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid template'}`);
    }
    if (parsed.data.id !== entry.name) throw new Error(`${yamlFile}: id "${parsed.data.id}" must match folder name "${entry.name}"`);
    out.push(parsed.data);
  }
  return out;
}
