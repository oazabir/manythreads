import type { ConnectorEntry } from './catalog.ts';
import { svc, tool } from './catalog-helpers.ts';

// The catalog entries of the document connectors (PLAN Bundle D, P16-08): Confluence, Dropbox and Box. Owned by the package that builds them (WP-D1), which flips the
// statuses and services here and nowhere else, so two packages never edit the same lines of catalog.ts.
//
// They are signed in to like any other person connection, and what they are for is the knowledge sync (a person picks a space or a folder as a source of a knowledge
// base): the service below is what that sync reads with, read only. No tool for a bot to search or read through them is built yet, so the tools stay listed as
// "not available" and the services say nothing about tools. The export keeps the name `FILES_PLANNED_ENTRIES` because catalog.ts imports it by that name.

const built = { status: 'available', reason: null, phase: 'P16-08' } as const;

export const FILES_PLANNED_ENTRIES: ConnectorEntry[] = [
  {
    id: 'confluence',
    label: 'Confluence',
    provider: 'Atlassian',
    categories: ['files'],
    description: 'Pages as a knowledge source, kept up to date as they change. A page is added to a team base only when everyone on the team may read it there.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    kind: null,
    services: [
      svc('pages', 'Confluence pages (read)', 'Copy the pages of a space you pick into a knowledge base, and keep them up to date. Nothing is written back.', [
        'read:confluence-content.all',
        'read:page:confluence',
        'read:space:confluence',
      ]),
    ],
    tools: [tool('confluence.search', 'Search pages', 'read', 'pages', false), tool('confluence.read_page', 'Read a page', 'read', 'pages', false)],
    triggers: [],
    syncTargets: ['knowledge'],
    ...built,
  },
  {
    id: 'dropbox',
    label: 'Dropbox',
    provider: 'Dropbox',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change. A file is added to a team base only when everyone on the team may open it there.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    kind: null,
    services: [
      svc('files', 'Dropbox files (read)', 'Copy the files of a folder you pick into a knowledge base, and keep them up to date. Nothing is written back.', [
        'files.metadata.read',
        'files.content.read',
        'sharing.read',
      ]),
    ],
    tools: [tool('dropbox.search', 'Search files', 'read', 'files', false), tool('dropbox.read', 'Read a file', 'read', 'files', false)],
    triggers: [],
    syncTargets: ['knowledge'],
    ...built,
  },
  {
    id: 'box',
    label: 'Box',
    provider: 'Box',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change. A file is added to a team base only when everyone on the team may open it there.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    kind: null,
    services: [
      svc('files', 'Box files (read)', 'Copy the files of a folder you pick into a knowledge base, and keep them up to date. Nothing is written back.', ['root_readonly']),
    ],
    tools: [tool('box.search', 'Search files', 'read', 'files', false), tool('box.read', 'Read a file', 'read', 'files', false)],
    triggers: [],
    syncTargets: ['knowledge'],
    ...built,
  },
];
