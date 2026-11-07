import { describe, expect, it } from 'vitest';
import { validateOkfWrite } from '@manythreads/shared';
import { REFERENCE_TEXT_MAX } from '../src/commit.ts';
import { personalPayloadOf, personalReferenceConcept, personalReferencePath, toPersonalItem, type PersonalRow } from '../src/personal.ts';

// The parts of a person's own inbox (P20-04) that need no database: how a row becomes the item the API answers, what the Reference of an item says, and what a
// job payload must look like. The pipeline around them is in personal-inbox.test.ts.

const OWNER = '00000000-0000-7000-8000-0000000a0001';
const ITEM = '00000000-0000-7000-8000-0000000b00ff';
const WS = '00000000-0000-7000-8000-00000000a001';
const AT = '2026-11-07T10:00:00.000Z';

const row = (over: Partial<PersonalRow> = {}): PersonalRow => ({
  id: ITEM,
  workspace_id: WS,
  owner_person_id: OWNER,
  origin: 'person',
  state: 'filed',
  stage: 'done',
  kind: 'markdown',
  name: 'Standup notes.md',
  size: '2048',
  sha256: 'a'.repeat(64),
  blob_key: 'blobs/x',
  dropper_id: null,
  dropper_name: null,
  reason: null,
  hold_reason: null,
  duplicate_of: null,
  source_channel_id: null,
  source_message_id: null,
  filed_paths: ['memory/references/standup-notes-0000b0ff.md'],
  attempts: 1,
  failed_stage: null,
  released_at: null,
  original_removed_at: null,
  created_at: new Date('2026-11-07T09:00:00.000Z'),
  updated_at: new Date('2026-11-07T09:30:00.000Z'),
  filed_at: new Date('2026-11-07T09:30:00.000Z'),
  ...over,
});

describe('toPersonalItem', () => {
  it('names the Personal space of the owner and never a team, and reads the size as a number', () => {
    const item = toPersonalItem(row());
    expect(item).toMatchObject({ id: ITEM, personId: OWNER, space: `person:${OWNER}`, size: 2048, state: 'filed', teamOnly: false, originalKept: true, filedPaths: ['memory/references/standup-notes-0000b0ff.md'] });
    expect(item).not.toHaveProperty('teamId');
    expect(item.filedAt).toBe('2026-11-07T09:30:00.000Z');
  });

  it('says the original is gone once its blob key is, and carries a hold reason and the sentence', () => {
    const held = toPersonalItem(row({ state: 'held', blob_key: null, hold_reason: 'foreign_bundle', reason: 'This looks like a memory bundle from somewhere else.', filed_paths: [], filed_at: null }));
    expect(held).toMatchObject({ state: 'held', originalKept: false, holdReason: 'foreign_bundle', filedAt: null, filedPaths: [] });
    expect(held.reason).toContain('bundle');
  });
});

describe('personalReferenceConcept', () => {
  const meta = { id: ITEM, name: 'Standup notes.md', kind: 'markdown' };

  it('writes a Reference the memory format accepts, at the path the item is always filed at', () => {
    const text = personalReferenceConcept(meta, { text: 'The release moves to Friday.', title: 'Standup, Monday' }, AT);
    const path = personalReferencePath(meta, 'Standup, Monday');
    expect(path).toMatch(/^memory\/references\/standup-monday-[0-9a-f]{8}\.md$/);
    // the same item filed twice is the same file, not a second one
    expect(personalReferencePath(meta, 'Standup, Monday')).toBe(path);
    const verdict = validateOkfWrite(path, text);
    expect(verdict.ok, verdict.ok ? '' : verdict.reason).toBe(true);
    expect(text).toContain('type: Reference');
    expect(text).toContain(`personal-inbox/${ITEM}`);
    expect(text).toContain('The release moves to Friday.');
    expect(text).toContain('Filed from your inbox (`Standup notes.md`)');
    expect(text).not.toContain('Shortened');
  });

  it('titles a note by its name when the reader found no title', () => {
    expect(personalReferenceConcept(meta, { text: 'Words.', title: null }, AT)).toContain('# Standup notes.md');
  });

  it('shortens a long text and says how much the original still has', () => {
    const long = 'word '.repeat(REFERENCE_TEXT_MAX);
    const text = personalReferenceConcept(meta, { text: long, title: null }, AT);
    expect(text).toContain('Shortened');
    expect(text).toContain(`${long.length.toLocaleString('en-US')} characters`);
    expect(text.length).toBeLessThan(long.length);
    expect(validateOkfWrite(personalReferencePath(meta, null), text).ok).toBe(true);
  });

  it('does not leave half of an emoji where it cut', () => {
    const text = personalReferenceConcept(meta, { text: `${'a'.repeat(REFERENCE_TEXT_MAX - 1)}😀 and more`, title: null }, AT);
    expect(text).toContain('Shortened');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text)).toBe(false);
  });
});

describe('personalPayloadOf', () => {
  it('takes a payload with a workspace and an item id, and nothing else', () => {
    expect(personalPayloadOf({ workspaceId: WS, itemId: ITEM })).toEqual({ workspaceId: WS, itemId: ITEM });
    expect(personalPayloadOf({ workspaceId: WS })).toBeNull();
    expect(personalPayloadOf({ itemId: ITEM })).toBeNull();
    expect(personalPayloadOf({ workspaceId: 'x', itemId: ITEM })).toBeNull();
    expect(personalPayloadOf({ workspaceId: WS, itemId: 42 })).toBeNull();
    expect(personalPayloadOf({})).toBeNull();
  });
});
