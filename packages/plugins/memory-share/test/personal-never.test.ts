import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// P20-05: a person's own Memory is never shared. The share builder reads a team's concepts (`memory_concepts` and the team's repo) and nothing else, so a
// person's bundle (`memory_personal_files`, kept as rows) cannot reach a digest. This is the guard: no source file of this plugin may name the person's
// tables or ask for a person's space, so adding such a read fails here and has to be argued in review.

const SRC = join(__dirname, '..', 'src');
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
  });

describe('a person\'s own Memory is never shared', () => {
  it('is not read by any part of the share plugin', () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/memory_personal|owner_person_id|PersonalStore|run_space_context|readable_space_ids/);
    }
  });

  it('builds a digest only from the sending team\'s concepts', () => {
    const build = readFileSync(join(SRC, 'build.ts'), 'utf8');
    expect(build).toContain('FROM app.memory_concepts WHERE team_id = $1');
  });
});
