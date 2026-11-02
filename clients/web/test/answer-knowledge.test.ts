import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AnswerPayloadView } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { Answer, knowledgeSince, parseKnowledgeRef } from '../src/channels/Answer';

// "The source has changed since" on the Answer (PLAN P8-08): the run's log names a passage as `<base>/<document> v<version>`; the client compares
// that version with what the base says now.

describe('the reference of a knowledge passage in the run log', () => {
  it('reads base, document and version', () => {
    expect(parseKnowledgeRef('manuals/Refund policy.md v3')).toEqual({ base: 'manuals', document: 'Refund policy.md', version: 3 });
    expect(parseKnowledgeRef('manuals/a/b.md v12')).toEqual({ base: 'manuals', document: 'a/b.md', version: 12 });
  });

  it('refuses anything else', () => {
    for (const ref of ['', 'manuals', 'manuals/doc.md', 'manuals/doc.md v', 'manuals/doc.md vx', 'a b/doc.md v1', '/doc.md v1', 'manuals/doc.md v1234567890']) {
      expect(parseKnowledgeRef(ref), ref).toBeNull();
    }
  });
});

describe('what the base says of a document now', () => {
  const documents = [
    { name: 'policy.md', version: 4 },
    { name: 'faq.md', version: 1 },
  ];

  it('says changed when a newer version exists', () => {
    expect(knowledgeSince({ document: 'policy.md', version: 3 }, documents)).toEqual({ state: 'changed', now: 4 });
  });

  it('says nothing when the version read is the current one', () => {
    expect(knowledgeSince({ document: 'policy.md', version: 4 }, documents)).toBeNull();
    expect(knowledgeSince({ document: 'faq.md', version: 1 }, documents)).toBeNull();
  });

  it('says gone when the document is no longer in the base', () => {
    expect(knowledgeSince({ document: 'old.md', version: 1 }, documents)).toEqual({ state: 'gone' });
  });
});

describe('the Answer with a knowledge source reached', () => {
  const payload = AnswerPayloadView.parse({
    version: 1,
    body: 'Refunds take five days.',
    citations: [],
    lineage: [],
    sourcesReached: [{ kind: 'knowledge', ref: 'manuals/policy.md v3', label: null, marker: 'full' }],
    outsideScope: { count: 0, items: [] },
    answeredFor: { personId: null, name: null, scope: 'team', alias: null, botId: '0190a000-0000-7000-8000-000000000021', runId: '0190a000-0000-7000-8000-000000000022' },
    chips: [],
  });

  it('names the document and version it read, and draws no warning until the base has been asked', () => {
    const out = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Answer, { payload, teamSlug: 'support' })));
    expect(out).toContain('Knowledge');
    expect(out).toContain('manuals/policy.md v3');
    expect(out).not.toContain('answer-source-changed');
  });
});
