import { HttpError } from '@manythreads/sdk';
import { describe, expect, it } from 'vitest';
import { refusePersonalPut } from '../src/personal-routes.ts';
import type { PersonalPutResult } from '../src/personal-store.ts';

// The sentences a refused write of a person's own Memory says (P20-05). The screen shows them as they are, and it offers "Open the latest version" for the
// 409 that says the file changed, so the status and the words are part of the contract. No database: the function only turns a store answer into an error.

const result = (status: PersonalPutResult['status'], extra: Partial<PersonalPutResult> = {}): PersonalPutResult => ({ status, versionNo: 0, callerKind: null, ...extra });
const refused = (r: PersonalPutResult, path = 'memory/facts/tea.md'): HttpError => {
  try {
    refusePersonalPut(r, path);
  } catch (e) {
    return e as HttpError;
  }
  throw new Error('the write was not refused');
};

describe('refusePersonalPut', () => {
  it('says a stale save changed since it was opened, with the version it is at, as a 409', () => {
    const e = refused(result('conflict', { versionNo: 7 }));
    expect(e).toBeInstanceOf(HttpError);
    expect(e.status).toBe(409);
    expect(e.message).toBe('“memory/facts/tea.md” changed since you opened it (it is at version 7). Open it again and redo your edit.');
  });

  it('carries the validator\'s own reason for a file that breaks the format, as a client error', () => {
    const e = refused(result('invalid', { reason: 'the front matter has no type' }));
    expect(e.status).toBeGreaterThanOrEqual(400);
    expect(e.status).toBeLessThan(500);
    expect(e.message).toBe('“memory/facts/tea.md”: the front matter has no type');
    expect(refused(result('invalid')).message).toContain('not a valid memory file');
  });

  it('says the memory is full at 2,000 files, as a 409 with its own code', () => {
    const e = refused(result('too_many_files'));
    expect(e.status).toBe(409);
    expect(e.code).toBe('personal_memory_full');
    expect(e.message).toContain('2,000');
    expect(e.message).toContain('Delete a file');
  });

  it('names the size limit for a file that is too large', () => {
    const e = refused(result('too_large'));
    expect(e.status).toBeLessThan(500);
    expect(e.message).toContain('1,000,000 bytes');
  });

  it('tells a bot that a person-owned file is not replaced, and refuses anyone else with the owner sentence', () => {
    const owned = refused(result('person_owned'), 'memory/facts/mine.md');
    expect(owned.status).toBe(409);
    expect(owned.message).toBe('“memory/facts/mine.md” was written or verified by a person, so a bot does not replace it.');
    const other = refused(result('forbidden'));
    expect(other.status).toBe(403);
    expect(other.message).toBe('Only the owner may write this Memory.');
  });
});
