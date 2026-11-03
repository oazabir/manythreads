import { describe, expect, it } from 'vitest';
import {
  CONNECTION_KIND_TOOLS,
  CONNECTION_KINDS,
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  ConnectorEntry,
  availableServices,
  availableTools,
  categoryCounts,
  connectorEntry,
  scopesForServices,
  scopesForTools,
  searchConnectors,
  toolsOfService,
} from '../src/index.ts';

// P16-01: the connector catalog is the one list the gallery, the connections plugin and the docs read. These checks keep it honest: every entry is valid, ids and
// tool names are unique, a connector that is not built offers nothing, a destructive tool is never offered, and the three connections the Add connection flow
// creates today are the ones in `entities/connection-kinds.ts` (not a second description of them).

describe('the catalog', () => {
  it('holds only valid entries, each with a unique id', () => {
    for (const e of CONNECTOR_CATALOG) expect(() => ConnectorEntry.parse(e), e.id).not.toThrow();
    const ids = CONNECTOR_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names every tool once, across all connectors', () => {
    const names = CONNECTOR_CATALOG.flatMap((e) => e.tools.map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('covers all nine shelves, and every shelf has at least one connector', () => {
    expect(CONNECTOR_CATEGORIES.map((c) => c.label)).toEqual(['Mail', 'Calendar', 'Files', 'Tickets', 'CRM', 'Code', 'Chat', 'Finance', 'Design']);
    for (const [shelf, n] of Object.entries(categoryCounts())) expect(n, shelf).toBeGreaterThan(0);
  });

  it('names the providers of the connector tasks of the plan', () => {
    for (const id of ['google', 'microsoft', 'jira', 'linear', 'github', 'asana', 'zendesk', 'freshdesk', 'intercom', 'hubspot', 'salesforce', 'notion', 'confluence', 'dropbox', 'box', 'telegram', 'whatsapp', 'teams', 'slack']) {
      expect(connectorEntry(id), id).toBeDefined();
    }
  });

  it('a planned connector says why and which task builds it, and offers no tool and no service', () => {
    const planned = CONNECTOR_CATALOG.filter((e) => e.status === 'planned');
    expect(planned.length).toBeGreaterThan(10);
    for (const e of planned) {
      expect(e.reason, e.id).toMatch(/\S/);
      expect(e.phase, e.id).toMatch(/^P\d+-\d+$/);
      expect(availableTools(e), e.id).toEqual([]);
      expect(availableServices(e), e.id).toEqual([]);
    }
  });

  it('an available connector has no reason, and an unbuilt tool or service of it is never offered', () => {
    for (const e of CONNECTOR_CATALOG.filter((x) => x.status === 'available')) {
      expect(e.reason, e.id).toBeNull();
      for (const t of e.tools.filter((x) => !x.available)) expect(availableTools(e).map((x) => x.name)).not.toContain(t.name);
    }
  });

  it('a destructive tool is listed and tagged but never available, and never offered', () => {
    const destructive = CONNECTOR_CATALOG.flatMap((e) => e.tools.filter((t) => t.destructive).map((t) => ({ e, t })));
    expect(destructive.length).toBeGreaterThanOrEqual(3);
    for (const { e, t } of destructive) {
      expect(t.available, t.name).toBe(false);
      expect(availableTools(e).map((x) => x.name)).not.toContain(t.name);
    }
  });

  it('every tool names a service of its own connector (or none, when the connector has no scopes)', () => {
    for (const e of CONNECTOR_CATALOG) {
      const services = new Set(e.services.map((s) => s.id));
      for (const t of e.tools) {
        if (t.service !== null) expect(services.has(t.service), `${e.id}/${t.name}`).toBe(true);
        // an available tool needs an available service, or its sign-in would never ask for the scope
        if (t.available && t.service !== null) expect(e.services.find((s) => s.id === t.service)?.available, `${e.id}/${t.name}`).toBe(true);
      }
    }
  });

  it('a connector signed in with OAuth lists its scopes; one with a key lists none', () => {
    for (const e of CONNECTOR_CATALOG) if (e.auth === 'api_key') expect(e.services.flatMap((s) => s.scopes), e.id).toEqual([]);
    for (const e of CONNECTOR_CATALOG.filter((x) => x.status === 'available' && x.auth === 'oauth')) expect(availableServices(e).length, e.id).toBeGreaterThan(0);
  });
});

describe('the connections of the Add connection flow', () => {
  it('are built from the kinds list: same ids, labels, sentences and tools', () => {
    for (const k of CONNECTION_KINDS) {
      const e = connectorEntry(k.kind);
      expect(e, k.kind).toBeDefined();
      expect(e).toMatchObject({ kind: k.kind, label: k.label, description: k.description, heldBy: ['team'] });
      expect(e!.status).toBe(k.available ? 'available' : 'planned');
      expect(availableTools(e!).map((t) => t.name)).toEqual([...(CONNECTION_KIND_TOOLS[k.kind] ?? [])]);
    }
  });

  it('mark what changes something outside as a write', () => {
    const email = connectorEntry('email')!;
    expect(email.tools.map((t) => [t.name, t.access])).toEqual([
      ['email.read', 'read'],
      ['email.draft', 'write'],
      ['email.send', 'write'],
    ]);
  });
});

describe('scopes per tool (incremental sign-in)', () => {
  const google = connectorEntry('google')!;
  const calendar = 'https://www.googleapis.com/auth/calendar.events.readonly';
  const drive = 'https://www.googleapis.com/auth/drive.readonly';

  it('turning on only Calendar asks for the Calendar scope alone', () => {
    expect(scopesForTools(google, ['google_calendar.list_events'])).toEqual([calendar]);
    expect(scopesForServices(google, ['calendar'])).toEqual([calendar]);
  });

  it('two tools of one service ask for its scopes once', () => {
    expect(scopesForTools(google, ['google_drive.search', 'google_drive.read'])).toEqual([drive]);
    expect(toolsOfService(google, 'drive')).toEqual(['google_drive.search', 'google_drive.read']);
  });

  it('a tool that is not built, is destructive or is unknown asks for nothing', () => {
    expect(scopesForTools(google, ['google_drive.delete', 'nope.nothing'])).toEqual([]);
    expect(scopesForServices(google, ['meet', 'nope'])).toEqual([]);
  });

  it('sending and labelling ask for their own scopes, and only when they are ticked (P16-03)', () => {
    expect(scopesForTools(google, ['gmail.send'])).toEqual(['https://www.googleapis.com/auth/gmail.send']);
    expect(scopesForServices(google, ['gmail_labels'])).toEqual(['https://www.googleapis.com/auth/gmail.modify']);
    expect(scopesForServices(google, ['calendar_free_busy'])).toEqual(['https://www.googleapis.com/auth/calendar.freebusy']);
    expect(toolsOfService(google, 'calendar_write')).toEqual(['google_calendar.create_event', 'google_calendar.update_event']);
  });
});

describe('searching the gallery', () => {
  const ids = (q: Parameters<typeof searchConnectors>[0]): string[] => searchConnectors(q).map((e) => e.id);

  it('with nothing asked shows everything, what works today first', () => {
    const all = searchConnectors();
    expect(all).toHaveLength(CONNECTOR_CATALOG.length);
    const firstPlanned = all.findIndex((e) => e.status === 'planned');
    expect(all.slice(firstPlanned).every((e) => e.status === 'planned')).toBe(true);
  });

  it('“calendar” finds Google and Microsoft', () => {
    expect(ids({ query: 'calendar' })).toEqual(expect.arrayContaining(['google', 'microsoft']));
  });

  it('every word must match, in any order and any case', () => {
    expect(ids({ query: 'CALENDAR google' })).toEqual(['google']);
    expect(ids({ query: 'zzz-nothing' })).toEqual([]);
  });

  it('a shelf lists every connector on it, including one that is on several', () => {
    expect(ids({ category: 'tickets' })).toEqual(expect.arrayContaining(['jira', 'linear', 'zendesk', 'github']));
    expect(ids({ category: 'finance' })).toEqual(expect.arrayContaining(['stripe']));
    expect(ids({ category: 'mail' })).toEqual(expect.arrayContaining(['email', 'google', 'microsoft']));
  });

  it('puts a name match before a match in the description', () => {
    const found = ids({ query: 'notion' });
    expect(found[0]).toBe('notion');
  });

  it('a hostile query takes linear time and builds no pattern', () => {
    const started = performance.now();
    searchConnectors({ query: `${'(a+)+'.repeat(2000)} ${'\\'.repeat(5000)}` });
    expect(performance.now() - started).toBeLessThan(500);
  });
});
