import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import type { KnowledgeSource } from '@manythreads/shared';
import { describe, expect, it } from 'vitest';
import { ConnectorSourceLine, TEAM_RULE_SENTENCE, providerName, rootsAreFor } from '../src/screens/knowledge/ConnectorSourceForm';

// The Sources list of a base shows a source read from a connected app (PLAN Bundle D, P16-08): where it comes from, whose connection reads it, how it went, and how many
// documents were left out because not everyone on the team can open them (a count; never a name).

const source = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: '0198f0a0-0000-7000-8000-000000000001',
  kind: 'connector',
  url: null,
  label: 'Engineering',
  syncMinutes: 60,
  lastSyncedAt: '2026-11-01T10:00:00.000Z',
  error: null,
  provider: 'google_drive',
  status: 'ready',
  remoteRoot: 'Engineering',
  readWith: 'Omar’s Google Drive',
  skippedLimited: 0,
  documentCount: 3,
  ...over,
});
const html = (s: KnowledgeSource): string => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ConnectorSourceLine, { source: s })));

describe('a source from a connected app', () => {
  it('names the app and the folder, whose connection reads it, when it was read and how many documents it holds', () => {
    const out = html(source());
    expect(out).toContain('Google Drive: Engineering');
    expect(out).toContain('Read with Omar’s Google Drive');
    expect(out).toContain('3 documents');
    expect(out).not.toContain('not added');
  });

  it('says how many documents were left out, and why, without a name', () => {
    expect(html(source({ skippedLimited: 4 }))).toContain('4 documents not added: not everyone on the team can open them.');
    expect(html(source({ skippedLimited: 1 }))).toContain('1 document not added: not everyone on the team can open it.');
  });

  it('a paused source says the sign-in is gone and offers to connect again', () => {
    const out = html(source({ status: 'paused', error: 'Omar’s Google Drive is no longer connected.' }));
    expect(out).toContain('Paused: Omar’s Google Drive is no longer connected.');
    expect(out).toContain('/settings/connections');
    expect(out).toContain('data-status="paused"');
  });

  it('a source that could not be read asks for attention with the reason', () => {
    expect(html(source({ status: 'attention', error: 'Google Drive did not answer.' }))).toContain('Needs attention: Google Drive did not answer.');
  });

  it('the team rule is one plain sentence and every app has a name', () => {
    expect(TEAM_RULE_SENTENCE).toBe('Documents everyone on this team can already open will be copied into this base. Others stay with the people who can open them.');
    expect(providerName('sharepoint')).toBe('SharePoint');
    expect(providerName(null)).toBe('Connected app');
  });
});

describe('the folder list of the add form', () => {
  it('is offered only for the app it was asked for, never the previous app’s list under a new name', () => {
    expect(rootsAreFor({ provider: 'notion' }, 'notion')).toBe(true);
    expect(rootsAreFor({ provider: 'notion' }, 'box')).toBe(false);
    expect(rootsAreFor(undefined, 'notion')).toBe(false);
  });
});
