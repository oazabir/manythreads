import type { ConnectorEntry } from './catalog.ts';
import { planned, soon, svc, tool } from './catalog-helpers.ts';

// The catalog entries of the document connectors (PLAN Bundle D, P16-08): Confluence, Dropbox and Box. Owned by the package that builds them (WP-D1), which flips the
// statuses and services here and nowhere else, so two packages never edit the same lines of catalog.ts.

export const FILES_PLANNED_ENTRIES: ConnectorEntry[] = [
  planned({
    id: 'confluence',
    label: 'Confluence',
    provider: 'Atlassian',
    categories: ['files'],
    description: 'Pages as a knowledge source, kept up to date as they change. A page is added to a team base only when everyone on the team may read it there.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('pages', 'Pages (read)', 'Search and read pages.', ['read:confluence-content.all', 'offline_access'], false)],
    tools: [tool('confluence.search', 'Search pages', 'read', 'pages', false), tool('confluence.read_page', 'Read a page', 'read', 'pages', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
  planned({
    id: 'dropbox',
    label: 'Dropbox',
    provider: 'Dropbox',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('files', 'Files (read)', 'Search and read files.', ['files.metadata.read', 'files.content.read'], false)],
    tools: [tool('dropbox.search', 'Search files', 'read', 'files', false), tool('dropbox.read', 'Read a file', 'read', 'files', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
  planned({
    id: 'box',
    label: 'Box',
    provider: 'Box',
    categories: ['files'],
    description: 'Files as a knowledge source, kept up to date as they change.',
    source: 'first_party',
    auth: 'oauth',
    heldBy: ['team', 'person'],
    services: [svc('files', 'Files (read)', 'Search and read files.', ['root_readonly'], false)],
    tools: [tool('box.search', 'Search files', 'read', 'files', false), tool('box.read', 'Read a file', 'read', 'files', false)],
    syncTargets: ['knowledge'],
    ...soon('P16-08', 'Documents as knowledge arrive in a later phase.'),
  }),
];
