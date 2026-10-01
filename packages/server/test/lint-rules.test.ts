import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// PLAN Phase 1 criterion 6: a raw hex colour fails lint. Runs the repo's own ESLint config on fixture strings.
const HASH = String.fromCharCode(35); // keeps this file itself free of raw hex literals
const lint = async (code: string, filePath: string) => {
  const eslint = new ESLint({ cwd: new URL('../../../', import.meta.url).pathname });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.severity === 2);
};

describe('lint: design tokens only', () => {
  it('a raw hex colour in a string literal fails', async () => {
    const errors = await lint(`export const c = '${HASH}ff00aa';\n`, 'clients/web/src/hex-fixture.ts');
    expect(errors.map((e) => e.message).join()).toMatch(/Raw hex colours are banned/);
  });

  it('a raw hex colour in a template literal fails', async () => {
    const errors = await lint(`export const c = \`border: 1px solid ${HASH}abc\`;\n`, 'clients/web/src/hex-fixture.ts');
    expect(errors.map((e) => e.message).join()).toMatch(/Raw hex colours are banned/);
  });

  it('packages/shared/src/tokens.ts may hold hex', async () => {
    expect(await lint(`export const c = '${HASH}ff00aa';\n`, 'packages/shared/src/tokens.ts')).toEqual([]);
  });

  it('names ending in Dto fail, and a bare pool.query outside db/ fails', async () => {
    const dto = await lint('export type UserDto = { a: 1 };\n', 'packages/server/src/x.ts');
    expect(dto.length).toBeGreaterThan(0);
    const pool = await lint('declare const pool: { query(s: string): void };\npool.query("select 1");\n', 'packages/server/src/x.ts');
    expect(pool.map((e) => e.message).join()).toMatch(/No bare pool\.query/);
  });
});
