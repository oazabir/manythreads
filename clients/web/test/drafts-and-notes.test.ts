// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { noteDraft, placeDraft } from '../src/channels/draftPlaces';
import { writeDraft } from '../src/channels/serverDraft';
import { readThreadNote, writeThreadNote } from '../src/taskview/ThreadNote';

// Owner, 2026-11-23: every box's draft is listed on the Drafts page with the place it belongs to (kept in this browser); a thread's note is kept in this browser.

const index = (): Record<string, { path: string; label: string; preview: string }> => JSON.parse(window.localStorage.getItem('manythreads.draft-places') ?? '{}');

beforeEach(() => window.localStorage.clear());

describe('draft places', () => {
  it('a saved draft is listed with the page and label its box was opened on, and goes when it is sent or cleared', () => {
    placeDraft('channel:c-1', '/t/engineering/c/dev', 'Message #dev');
    writeDraft('channel:c-1', 'half a thought   about the release');
    expect(index()['channel:c-1']).toMatchObject({ path: '/t/engineering/c/dev', label: 'Message #dev', preview: 'half a thought about the release' });
    writeDraft('channel:c-1', '');
    expect(index()['channel:c-1']).toBeUndefined();
  });

  it('a box with no place known is not listed; the newest drafts are kept, at most 200', () => {
    noteDraft('thread:unknown', 'text');
    expect(index()['thread:unknown']).toBeUndefined();
    for (let i = 0; i < 205; i++) {
      placeDraft(`k:${i}`, `/p/${i}`, `Box ${i}`);
      noteDraft(`k:${i}`, `draft ${i}`);
    }
    expect(Object.keys(index())).toHaveLength(200);
  });
});

describe('thread notes', () => {
  it('keeps a note per thread and removes an empty one', () => {
    writeThreadNote('root-1', 'Ask Rafi about the rollback');
    expect(readThreadNote('root-1')).toBe('Ask Rafi about the rollback');
    expect(readThreadNote('root-2')).toBe('');
    writeThreadNote('root-1', '   ');
    expect(window.localStorage.getItem('manythreads.thread-note:root-1')).toBeNull();
  });
});
