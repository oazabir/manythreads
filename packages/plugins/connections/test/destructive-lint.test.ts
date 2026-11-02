import { fileURLToPath } from 'node:url';
import { loadTemplates } from '@manythreads/kernel';
import { parseBotMd } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import plugin, { TOOLS } from '../src/index.ts';

// The lint (PLAN P8-01): no destructive tool is ever in a grant of a connection. No database; it reads what the platform ships as data.
//   1. every tool a connection can serve is declared in the plugin's manifest and is not destructive (the broker never grants a destructive one, and the compile skips it);
//   2. no template bot names a destructive tool under `capabilities.connections`: by the manifest when the tool is declared, by its name (delete, remove, ...) when it is not.

const TEMPLATES_DIR = fileURLToPath(new URL('../../../../templates/', import.meta.url));
const DESTRUCTIVE_NAME = /\.(delete|remove|destroy|drop|purge|wipe|erase|trash|revoke|terminate)$/;

describe('no destructive tool in a connection grant', () => {
  const declared = new Map(plugin.manifest.capabilities.map((c) => [c.name, c.destructive]));

  it('every tool a connection kind can serve is declared by the plugin and none is destructive', () => {
    expect(TOOLS.length).toBeGreaterThan(0);
    for (const tool of TOOLS) {
      expect(declared.has(tool.name), `${tool.name} is not declared in the manifest`).toBe(true);
      expect(declared.get(tool.name), `${tool.name} is declared destructive`).toBe(false);
      expect(tool.name, tool.name).not.toMatch(DESTRUCTIVE_NAME);
    }
  });

  it('no declared capability of the plugin is destructive (nothing here could be granted by mistake)', () => {
    for (const [name, destructive] of declared) expect(destructive, name).toBe(false);
  });

  it('no template bot lists a destructive tool under capabilities.connections', async () => {
    const templates = await loadTemplates(TEMPLATES_DIR);
    let checked = 0;
    for (const template of templates) {
      for (const [path, text] of Object.entries(template.files ?? {})) {
        if (!path.endsWith('/BOT.md')) continue;
        const parsed = parseBotMd(text);
        if (!parsed.ok) throw new Error(`${template.id}/${path}: ${parsed.failure.message}`);
        for (const connection of parsed.frontmatter.capabilities?.connections ?? []) {
          for (const tool of connection.tools) {
            checked += 1;
            const where = `${template.id}/${path}: ${connection.name} ${tool}`;
            expect(tool, where).not.toMatch(DESTRUCTIVE_NAME);
            expect(tool.includes('*'), where).toBe(false);
            if (declared.has(tool)) expect(declared.get(tool), where).toBe(false);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('the name check catches what it is meant to', () => {
    for (const bad of ['email.delete', 'drive.file.remove', 'github.repo.destroy', 'db.table.drop']) expect(bad).toMatch(DESTRUCTIVE_NAME);
    for (const ok of ['email.read', 'email.send', 'github.pr.comment', 'drive.search']) expect(ok).not.toMatch(DESTRUCTIVE_NAME);
  });
});
