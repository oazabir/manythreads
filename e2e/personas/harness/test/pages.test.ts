// The page objects name their screens by testid (e2e/pages/testids.ts). A renamed testid in the web client should fail here, not in a journey at night.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TID } from '../../../pages/testids.ts';

const web = resolve(fileURLToPath(new URL('../../../../clients/web/src', import.meta.url)));
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}
const text = sources(web).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('page object testids', () => {
  it('has no duplicate values', () => {
    const values = Object.values(TID);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(Object.entries(TID))('%s = %s is rendered by the web client', (_name, id) => {
    const quoted = new RegExp(`['"\`]${id.replace(/[-]/g, '\\-')}['"\`]`);
    expect(quoted.test(text), `no element carries "${id}": was it renamed?`).toBe(true);
  });
});
