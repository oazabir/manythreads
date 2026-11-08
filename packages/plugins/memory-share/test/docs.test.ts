import { readFileSync } from 'node:fs';
import * as shared from '@manythreads/shared';
import { ShareDefinition, TeamMemoryInboxConfig } from '@manythreads/shared';
import { SHARE_FILES } from '@manythreads/test-utils';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

// P8-27: docs/plugins/memory-inbox.md and memory-share.md say every command (route), event and job of the two plugins, and the YAML in them is accepted by the code that
// reads it. A route, an event or a queue added without a line in the page fails here; so does an example that the loader would refuse.

const read = (rel: string): string => readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');
const inboxDoc = read('docs/plugins/memory-inbox.md');
const shareDoc = read('docs/plugins/memory-share.md');
const bothDocs = `${inboxDoc}\n${shareDoc}`;

interface ApiRouteLike {
  method: string;
  path: string;
}
const routes = Object.entries(shared)
  .filter(([name, v]) => name.endsWith('Route') && typeof v === 'object' && v !== null && 'method' in v && 'path' in v)
  .map(([name, v]) => ({ name, ...(v as ApiRouteLike) }));

// A voice room's routes (`/api/meetings/…`, Phase 15) belong to the meetings plugin and are listed in docs/plugins/meetings.md, checked at the end of this file.
const meetingRoutes = routes.filter((r) => r.path.startsWith('/api/meetings/'));
const inboxRoutes = routes.filter((r) => !r.path.startsWith('/api/meetings/') && (/\/inbox(\/|-mail|$)/.test(r.path) || r.path.endsWith('/send-to-memory')));
const shareRoutes = routes.filter((r) => !r.path.startsWith('/api/meetings/') && (/\/shares(\/|$)/.test(r.path) || r.path === '/api/workspace/memory-sharing'));

const eventTypes = Object.keys(shared.eventRegistry);
const mine = eventTypes.filter((t) => /^memory\.(item|share|sharing|digest)\./.test(t));

const sourceOf = (rel: string): string => read(rel);
const queuesOf = (rel: string): string[] => [...sourceOf(rel).matchAll(/_QUEUE = '([a-z-]+\.[a-z]+)'/g)].map((m) => m[1] as string);

/** The text of every fenced block of a language. */
const fences = (doc: string, lang: string): string[] => [...doc.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1] as string);

describe('what the pages say', () => {
  it('finds the routes, events and queues it is checking (so the checks below cannot pass on nothing)', () => {
    expect(inboxRoutes.length).toBeGreaterThanOrEqual(13);
    expect(shareRoutes.length).toBeGreaterThanOrEqual(10);
    expect(mine.length).toBeGreaterThanOrEqual(11);
    expect(queuesOf('packages/plugins/memory-inbox/src/receive.ts').length).toBe(7);
  });

  it.each(inboxRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('memory-inbox.md has %s', (_label, r) => {
    expect(inboxDoc, r.name).toContain(r.path);
  });

  it.each(shareRoutes.map((r) => [`${r.method} ${r.path}`, r] as const))('memory-share.md has %s', (_label, r) => {
    expect(shareDoc, r.name).toContain(r.path);
  });

  it.each(mine)('the event %s is in the pages', (type) => {
    expect(bothDocs).toContain(type);
  });

  it.each(queuesOf('packages/plugins/memory-inbox/src/receive.ts'))('memory-inbox.md has the job %s', (queue) => {
    expect(inboxDoc).toContain(queue);
  });

  it.each(queuesOf('packages/plugins/memory-share/src/util.ts').filter((q) => sourceOf('packages/plugins/memory-share/src/jobs.ts').includes(`${q.split('.')[1]!.toUpperCase()}_QUEUE`)))(
    'memory-share.md has the job %s',
    (queue) => {
      expect(shareDoc).toContain(queue);
    },
  );

  it('names the capabilities the inbox registers', () => {
    for (const name of ['inbox.read', 'inbox.drop']) expect(inboxDoc).toContain(name);
  });
});

describe('the voice room routes that touch memory and sharing', () => {
  const meetingsDoc = read('docs/plugins/meetings.md');
  it.each([
    ['sendMeetingToMemoryRoute', '/api/meetings/:meetingId/send-to-memory', 'POST /api/meetings/:meetingId/send-to-memory'],
    ['listMeetingSharesRoute', '/api/meetings/:meetingId/shares', '/shares'],
    ['createMeetingShareRoute', '/api/meetings/:meetingId/shares', '/shares'],
    ['deleteMeetingShareRoute', '/api/meetings/:meetingId/shares/:shareId', '/shares/:shareId'],
  ])('%s is a real route and meetings.md names it', (name, path, inDoc) => {
    expect(meetingRoutes.find((r) => r.name === name)?.path).toBe(path);
    expect(meetingsDoc).toContain(inDoc);
  });
});

describe('the YAML in the pages', () => {
  it('the share file example is accepted by the share definition, with every key it shows', () => {
    const [example] = fences(shareDoc, 'yaml');
    expect(example).toBeDefined();
    const parsed = ShareDefinition.safeParse(parseYaml(example!));
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.to).toEqual(['customer-support', 'marketing']);
      expect(parsed.data.select.minTrust).toBe('machine-confirmed');
      expect(parsed.data.when).toEqual({ cron: '0 8 * * MON' });
      expect(parsed.data.approval).toBe('review');
    }
  });

  it('the seed’s share files are accepted by the same definition', () => {
    for (const file of SHARE_FILES) {
      const parsed = ShareDefinition.safeParse(parseYaml(file.yaml));
      expect(parsed.success, `${file.slug}: ${JSON.stringify(parsed.success ? null : parsed.error.issues)}`).toBe(true);
    }
  });

  it('the inbox settings example in TEAM.md is accepted by the inbox settings', () => {
    const [example] = fences(inboxDoc, 'yaml');
    expect(example).toBeDefined();
    const doc = parseYaml(example!) as { memory: { inbox: unknown } };
    const parsed = TeamMemoryInboxConfig.safeParse(doc.memory.inbox);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ review: 'external', keepOriginals: 'forever', maxBytes: 10485760 });
  });
});
