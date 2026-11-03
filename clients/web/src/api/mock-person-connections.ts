import {
  ClearOAuthAppResponse,
  ListOAuthAppsResponse,
  ListPersonConnectionsResponse,
  PersonProviderId,
  PutOAuthAppRequest,
  clearOAuthAppRoute,
  disconnectPersonConnectionRoute,
  listOAuthAppsRoute,
  listPersonConnectionsRoute,
  putOAuthAppRoute,
  startPersonConnectionRoute,
  type OAuthAppStatus,
  type PersonConnectionProvider,
} from '@manythreads/shared';

/*
 * The mock of the connected-accounts page (P8-02): the same routes, shapes and words the connections plugin answers with. Google is set up and not connected,
 * Notion is set up and connected, Microsoft is not set up on this server (its Connect answers 409 as the server does). Connect does not leave the page in the
 * mock: the address it returns is this page with `connected=<provider>`, and the provider counts as connected from then on, as if the provider had sent the
 * browser back. Tokens are not modelled at all.
 */

type Route = { method: string; path: string };
type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type On = (route: Route, handler: (c: Ctx) => unknown) => void;

export type PersonConnectionsMockHooks = {
  fail(status: number, code: 'not_found' | 'conflict' | 'forbidden' | 'validation_failed', message: string): never;
};

type Svc = { id: string; label: string; description: string; tools: string[]; writes: boolean };
type Row = { id: PersonProviderId; label: string; configured: boolean; connected: boolean; state: 'ok' | 'needs_reconnect' | null; accountLabel: string | null; granted: Set<string>; services: Svc[]; defaults: string[] };

const svc = (id: string, label: string, description: string, tools: string[], writes = false): Svc => ({ id, label, description, tools, writes });

export function installPersonConnectionsMock(on: On, h: PersonConnectionsMockHooks): void {
  const rows: Row[] = [
    {
      id: 'google', label: 'Google', configured: true, connected: false, state: null, accountLabel: null, granted: new Set(), defaults: ['drive', 'calendar'],
      services: [
        svc('drive', 'Google Drive (read)', 'Search your files and read the text of a document or sheet.', ['google_drive.search', 'google_drive.read']),
        svc('gmail', 'Gmail (read)', 'Search your mail and read a message.', ['gmail.search', 'gmail.read']),
        svc('gmail_drafts', 'Gmail drafts', 'Save a draft in your mailbox. Nothing is sent, and each draft waits for your approval.', ['gmail.draft'], true),
        svc('calendar', 'Google Calendar (read)', 'List your upcoming events.', ['google_calendar.list']),
        svc('calendar_write', 'Google Calendar (add events)', 'Add an event to your calendar. Each event waits for your approval.', ['google_calendar.create'], true),
      ],
    },
    {
      id: 'microsoft', label: 'Microsoft', configured: false, connected: false, state: null, accountLabel: null, granted: new Set(), defaults: ['onedrive', 'calendar'],
      services: [
        svc('onedrive', 'OneDrive (read)', 'Search your files and read the text of a file.', ['onedrive.search', 'onedrive.read']),
        svc('mail', 'Outlook mail (read)', 'Search your mail and read a message.', ['outlook.search', 'outlook.read']),
        svc('mail_drafts', 'Outlook drafts', 'Save a draft in your mailbox. Nothing is sent, and each draft waits for your approval.', ['outlook.draft'], true),
        svc('calendar', 'Outlook calendar (read)', 'List your upcoming events.', ['outlook_calendar.list']),
        svc('calendar_write', 'Outlook calendar (add events)', 'Add an event to your calendar. Each event waits for your approval.', ['outlook_calendar.create'], true),
      ],
    },
    {
      id: 'notion', label: 'Notion', configured: true, connected: true, state: 'ok', accountLabel: 'Kahf Software', granted: new Set(['notion']), defaults: ['notion'],
      services: [svc('notion', 'Notion', 'Search the pages you share with manythreads and read one.', ['notion.search', 'notion.read'])],
    },
  ];

  const body = (r: Row): PersonConnectionProvider => ({
    id: r.id,
    label: r.label,
    configured: r.configured,
    problem: null,
    refreshedAt: r.connected ? '2026-11-03T08:00:00.000Z' : null,
    connected: r.connected,
    state: r.connected ? r.state : null,
    accountLabel: r.connected ? r.accountLabel : null,
    redirectUri: `https://manythreads.example/api/me/connections/${r.id}/callback`,
    services: r.services.map((s) => ({ ...s, granted: r.granted.has(s.id) })),
  });
  const find = (id: string | undefined): Row => {
    const parsed = PersonProviderId.safeParse(id);
    const r = parsed.success ? rows.find((x) => x.id === parsed.data) : undefined;
    if (!r) h.fail(404, 'not_found', 'No such provider.');
    return r;
  };

  // The OAuth apps an admin enters (P16-02): the id is kept to show, the secret is only counted. Nothing of it is ever handed back.
  const apps = new Map<string, { clientId: string; tenant: string | null; updatedAt: string }>();
  const appStatus = (r: Row): OAuthAppStatus => {
    const mine = apps.get(r.id);
    return {
      provider: r.id,
      label: r.label,
      redirectUri: `https://manythreads.example/api/me/connections/${r.id}/callback`,
      source: mine ? 'workspace' : r.configured ? 'server' : null,
      clientId: mine?.clientId ?? null,
      tenant: mine?.tenant ?? null,
      supportsTenant: r.id === 'microsoft',
      tenantKind: r.id === 'microsoft' ? 'directory' : null,
      hasSecret: mine !== undefined || r.configured,
      updatedAt: mine?.updatedAt ?? null,
    };
  };
  on(listOAuthAppsRoute, () => ListOAuthAppsResponse.parse({ apps: rows.map(appStatus) }));
  on(putOAuthAppRoute, ({ params, body: b }) => {
    const r = find(params['provider']);
    const parsed = PutOAuthAppRequest.safeParse(b);
    if (!parsed.success) h.fail(400, 'validation_failed', 'Enter the client id and the client secret.');
    if (parsed.data.tenant && r.id !== 'microsoft') h.fail(400, 'validation_failed', 'Only Microsoft has a directory setting.');
    apps.set(r.id, { clientId: parsed.data.clientId, tenant: parsed.data.tenant || null, updatedAt: '2026-11-03T09:00:00.000Z' });
    r.configured = true;
    return { app: appStatus(r) };
  });
  on(clearOAuthAppRoute, ({ params }) => {
    const r = find(params['provider']);
    return ClearOAuthAppResponse.parse({ cleared: apps.delete(r.id) });
  });

  on(listPersonConnectionsRoute, () => ListPersonConnectionsResponse.parse({ providers: rows.map(body) }));

  on(startPersonConnectionRoute, ({ params, body: b }) => {
    const r = find(params['provider']);
    if (!r.configured) h.fail(409, 'conflict', `${r.label} is not set up on this server yet. A workspace admin has to add this server’s ${r.label} app (its client id and secret) first.`);
    const wanted = Array.isArray(b['services']) ? (b['services'] as string[]) : r.defaults;
    const unknown = wanted.find((s) => !r.services.some((x) => x.id === s));
    if (unknown) h.fail(400, 'validation_failed', `${r.label} has no service called “${unknown.slice(0, 40)}”.`);
    r.connected = true;
    r.state = 'ok';
    r.accountLabel = r.accountLabel ?? `omar@kahf.example (${r.label})`;
    for (const s of wanted) r.granted.add(s);
    return { url: `/settings/connections?connected=${r.id}` };
  });

  on(disconnectPersonConnectionRoute, ({ params }) => {
    const r = find(params['provider']);
    const was = r.connected;
    r.connected = false;
    r.state = null;
    r.accountLabel = null;
    r.granted.clear();
    return { disconnected: was };
  });
}
