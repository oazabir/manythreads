import {
  AcceptInvitationResponse,
  AuthenticatedSession,
  CreateInvitationResponse,
  ChangePasswordRequest,
  CreateOidcProviderRequest,
  GetInvitationResponse,
  GetSessionResponse,
  ListSessionsResponse,
  ListTemplatesResponse,
  NavChannelDirectory,
  OidcProvider,
  TeamTemplate,
  acceptInvitationRoute,
  addTeamMemberRoute,
  applyTeamTemplateRoute,
  archiveTeamRoute,
  assignTeamTagRoute,
  bootstrapWorkspaceRoute,
  changePasswordRoute,
  checkBootstrapRoute,
  createInvitationRoute,
  createOidcProviderRoute,
  createTeamInvitationRoute,
  createTeamRoute,
  createTeamTagRoute,
  deleteOidcProviderRoute,
  deleteTeamTagRoute,
  disableOidcProviderRoute,
  enableOidcProviderRoute,
  getInvitationRoute,
  getSessionRoute,
  getTeamRoute,
  getTeamRosterRoute,
  getWorkspaceRoute,
  listOidcMethodsRoute,
  listOidcProvidersRoute,
  listSessionsRoute,
  listTeamInvitationsRoute,
  listTeamTagsRoute,
  listTeamsRoute,
  listTemplatesRoute,
  listWorkspaceMembersRoute,
  navChannelDirectoryRoute,
  removeTeamMemberRoute,
  renameTeamRoute,
  requestEmailVerificationRoute,
  requestPasswordResetRoute,
  resetPasswordRoute,
  revokeSessionRoute,
  setTeamMemberRoleRoute,
  signInWithPasswordRoute,
  signOutEverywhereRoute,
  signOutRoute,
  testOidcProviderRoute,
  unarchiveTeamRoute,
  unassignTeamTagRoute,
  updateAccountRoute,
  updateOidcProviderRoute,
  updateWorkspaceMemberRoute,
  updateWorkspaceRoute,
  verifyEmailRoute,
  type ErrorCode,
  type OidcProviderKind,
  type TeamRole,
  type WorkspaceRole,
} from '@manythreads/shared';
import type { Transport } from './client';

/*
 * Mock transport (P2-10a, kept on the real shared schemas in P2-10b). Enabled with `?mock=1` (remembered for the tab)
 * or VITE_MANYTHREADS_MOCK=1. It answers the same routes the server does, with the same response shapes, so every
 * screen renders without a server; it is the offline screenshot path. The real server is the reference: when a route
 * changes, change it here too (mock.test.ts parses every fixture with the shared schemas).
 *
 *   ?mock=1                     signed in as Omar
 *   ?mock=1&as=nadia            signed in as another persona (omar nadia rafi sameera tariq priya lena)
 *   ?mock=1&anon=1              signed out (sign-in screen)
 *   ?mock=1&providers=google,microsoft   which OIDC providers exist and are enabled
 *   ?mock=1&teams=none          no teams yet (empty state)
 * Password for every persona: MOCK_PASSWORD. Bootstrap and invitation tokens `used` and `expired` answer 410.
 */

export const MOCK_PASSWORD = 'correct-horse-battery';
const LATENCY_MS = 40;

const WORKSPACE_ID = '00000000-0000-7000-8000-00000000a001';
const uuid = (kind: string, n: number): string => `00000000-0000-7000-8000-0000000${kind}${String(n).padStart(4, '0')}`;
const NOW = '2026-10-01T14:02:00.000Z';

type Person = { id: string; name: string; email: string; role: WorkspaceRole; joinedAt: string };
const person = (n: number, name: string, email: string, role: WorkspaceRole): Person => ({ id: uuid('c', n), name, email, role, joinedAt: '2026-09-20T09:00:00.000Z' });

const PEOPLE: Person[] = [
  person(1, 'Omar Al Zabir', 'omar@kahf.co', 'owner'),
  person(2, 'Nadia R.', 'nadia@kahf.co', 'member'),
  person(3, 'Rafi K.', 'rafi@kahf.co', 'member'),
  person(4, 'Sameera A.', 'sameera@kahf.co', 'member'),
  person(5, 'Tariq H.', 'tariq@kahf.co', 'member'),
  person(6, 'Priya S.', 'priya@kahf.co', 'member'),
  person(7, 'Lena M.', 'lena@partner.example', 'guest'),
];

type BotSpec = { slug: string; name: string; role: string; automation?: boolean };
const BRAIN: BotSpec = { slug: 'brain', name: 'Brain', role: 'Team memory. Answers from what the team did and wrote.' };
const slugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const bot = (name: string, role: string, automation = false): BotSpec => ({ slug: slugOf(name), name, role, ...(automation ? { automation } : {}) });

type TemplateSpec = { id: string; name: string; description: string; channels: string[]; board: string; columns: string[]; bots: BotSpec[]; roleTags: string[] };
const SPECS: TemplateSpec[] = [
  {
    id: 'engineering', name: 'Engineering', description: 'Ship and run software. Dev chat, releases, incidents, alerts and a daily standup.',
    channels: ['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup'], board: 'Engineering board', columns: ['Open', 'In progress', 'Verify', 'Waiting on a person', 'Done'],
    bots: [BRAIN, bot('Orchestrator', 'Breaks a goal into tasks and hands them to the right bot.'), bot('Coder', "Owns a task's branch and writes the change."), bot('Reviewer', 'Reviews pull requests and flags risk.'), bot('Tester', 'Writes and runs tests.'), bot('Deploy', 'Ships releases; production deploys wait for a person.'), bot('Standup relay', 'Collects updates and posts the daily standup.', true), bot('Alert triage', 'Groups and classifies alerts.')],
    roleTags: ['role:on-call', 'role:release-manager', 'role:reviewer'],
  },
  {
    id: 'customer-support', name: 'Customer support', description: 'Answer customers from the manuals and escalate what needs a person.',
    channels: ['#support', '#escalations', '#enquiries', '#kb-updates'], board: 'Support queue', columns: ['New', 'Waiting on customer', 'Escalated', 'Resolved'],
    bots: [BRAIN, bot('Support responder', 'Drafts replies from the manuals knowledge base.'), bot('Enquiry bot', 'Handles the sales inbox.'), bot('Escalation router', 'Routes sev1 tickets to the on-call person.', true), bot('KB gardener', 'Keeps the knowledge base fresh.')],
    roleTags: ['role:support-agent'],
  },
  {
    id: 'marketing', name: 'Marketing', description: 'Campaigns, content, social and analytics.',
    channels: ['#campaigns', '#content', '#social', '#analytics', '#brand'], board: 'Content calendar', columns: ['Idea', 'Draft', 'Review', 'Scheduled', 'Published'],
    bots: [BRAIN, bot('Content drafter', 'Drafts pages and posts for review.'), bot('Social scheduler', 'Queues approved posts.', true), bot('Analytics digest', 'Posts the weekly numbers.'), bot('Brand reviewer', 'Checks drafts against the brand guide.')],
    roleTags: ['role:content-lead'],
  },
  {
    id: 'product-design', name: 'Product design', description: 'Design, feedback, specs and critique.',
    channels: ['#design', '#feedback', '#specs', '#critique'], board: 'Design board', columns: ['Backlog', 'Exploring', 'Review', 'Shipped'],
    bots: [BRAIN, bot('Spec writer', 'Turns notes into specs.'), bot('Feedback synthesiser', 'Clusters feedback.'), bot('Design critique', 'Gives a first-pass critique.'), bot('Figma watcher', 'Posts design changes.', true)],
    roleTags: [],
  },
  {
    id: 'research', name: 'Research', description: 'Papers, experiments, notes and a reading group.',
    channels: ['#papers', '#experiments', '#notes', '#reading-group'], board: 'Experiments', columns: ['Idea', 'Running', 'Analysing', 'Written up'],
    bots: [BRAIN, bot('Literature scout', 'Finds new papers.'), bot('Summariser', 'Summarises a paper.'), bot('Experiment tracker', 'Tracks runs.'), bot('Citation checker', 'Checks references.')],
    roleTags: [],
  },
];

const definitionOf = (spec: TemplateSpec): TeamTemplate =>
  TeamTemplate.parse({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: 1,
    channels: spec.channels.map((name) => ({ name, purpose: `${spec.name} · ${name.slice(1)}` })),
    board: { name: spec.board, columns: spec.columns },
    bots: spec.bots,
    roleTags: spec.roleTags,
    teamMd: `# ${spec.name}\n`,
  });

type TeamState = {
  id: string;
  slug: string;
  name: string;
  template: string | null;
  archivedAt: string | null;
  members: Array<{ personId: string; role: TeamRole }>;
  /** tag name -> person ids holding it */
  tags: Map<string, Set<string>>;
};
type InvitationState = { id: string; token: string; teamSlug: string | null; teamRole: TeamRole; email: string; role: 'admin' | 'member' | 'guest'; invitedBy: string; expiresAt: string; acceptedAt: string | null };

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'team';

class MockHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly path?: string[],
  ) {
    super(message);
  }
}

export type MockOptions = { as?: string; anon?: boolean; providers?: string[]; noTeams?: boolean; latencyMs?: number };

type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
type Reply = { status: number; body: unknown };
const created = (body: unknown): Reply => ({ status: 201, body });

export function createMockTransport(options: MockOptions = {}): Transport {
  const people = PEOPLE.map((p) => ({ ...p }));
  let counter = 0;
  const nextId = (kind: string): string => uuid(kind, ++counter);

  const teams: TeamState[] = [];
  const addTeam = (slug: string, name: string, template: string | null, members: Array<[string, TeamRole]>, tags: Record<string, string[]>): TeamState => {
    const t: TeamState = {
      id: uuid('b', teams.length + 1), slug, name, template, archivedAt: null,
      members: members.map(([key, role]) => ({ personId: people.find((p) => p.email.startsWith(`${key}@`))!.id, role })),
      tags: new Map(Object.entries(tags).map(([tag, keys]) => [tag, new Set(keys.map((k) => people.find((p) => p.email.startsWith(`${k}@`))!.id))])),
    };
    teams.push(t);
    return t;
  };
  if (!options.noTeams) {
    addTeam('engineering', 'Engineering', 'engineering', [['omar', 'lead'], ['nadia', 'member'], ['rafi', 'member'], ['priya', 'member']], { 'role:release-manager': ['nadia'], 'role:on-call': ['rafi'], 'role:reviewer': [] });
    addTeam('customer-support', 'Customer support', 'customer-support', [['sameera', 'member']], { 'role:support-agent': ['sameera'] });
    addTeam('marketing', 'Marketing', 'marketing', [['tariq', 'lead'], ['priya', 'member']], { 'role:content-lead': ['tariq'] });
  }
  const invitations: InvitationState[] = [];

  let workspaceName = 'Kahf Software';
  let selfSignup = false;
  let passwordForMembers = true;
  /** Per-person passwords changed in this tab; everyone else still has MOCK_PASSWORD. */
  const passwords = new Map<string, string>();
  const passwordOf = (p: Person): string => passwords.get(p.id) ?? MOCK_PASSWORD;
  let currentId: string | null = options.anon ? null : (people.find((p) => p.id === uuid('c', ['omar', 'nadia', 'rafi', 'sameera', 'tariq', 'priya', 'lena'].indexOf(options.as ?? 'omar') + 1))?.id ?? people[0]!.id);
  let sessions = [
    { id: uuid('f', 1), label: 'Chrome on macOS', current: true, createdAt: '2026-10-01T08:00:00.000Z', lastSeenAt: NOW, expiresAt: '2026-10-31T08:00:00.000Z' },
    { id: uuid('f', 2), label: 'Safari on iPhone', current: false, createdAt: '2026-09-28T18:40:00.000Z', lastSeenAt: '2026-09-30T18:40:00.000Z', expiresAt: '2026-10-28T18:40:00.000Z' },
    { id: uuid('f', 3), label: 'Firefox on Linux', current: false, createdAt: '2026-09-20T07:15:00.000Z', lastSeenAt: '2026-09-27T07:15:00.000Z', expiresAt: '2026-10-20T07:15:00.000Z' },
  ];
  const failures = new Map<string, number>();

  // OIDC providers
  const providers: OidcProvider[] = [];
  const makeProvider = (kind: OidcProviderKind, input: { clientId: string; allowedDomains: string[]; tenantId?: string; issuer?: string; enabled: boolean }): OidcProvider => {
    const issuer = kind === 'google' ? 'https://accounts.google.com' : kind === 'microsoft' ? `https://login.microsoftonline.com/${input.tenantId ?? ''}/v2.0` : (input.issuer ?? '');
    const broken = issuer.includes('broken');
    const id = nextId('e');
    return OidcProvider.parse({
      id, kind,
      label: kind === 'google' ? 'Google' : kind === 'microsoft' ? 'Microsoft' : 'Company SSO',
      clientId: input.clientId, issuer, tenantId: kind === 'microsoft' ? (input.tenantId ?? null) : null,
      allowedDomains: input.allowedDomains,
      enabled: input.enabled && !broken,
      disabledReason: broken ? `Could not read the discovery document at ${issuer}/.well-known/openid-configuration: connection refused. The provider stays disabled.` : null,
      hasSecret: true,
      callbackUrl: 'https://manythreads.example/api/auth/oidc/callback',
      lastTest: broken
        ? { ok: false, message: `Could not read the discovery document at ${issuer}: connection refused.`, checkedAt: NOW }
        : { ok: true, message: 'Discovery passed.', checkedAt: NOW },
      createdAt: NOW, updatedAt: NOW,
    });
  };
  for (const kind of (options.providers ?? ['google']) as OidcProviderKind[]) {
    providers.push(makeProvider(kind, { clientId: kind === 'google' ? '847213-9kd.apps.googleusercontent.com' : 'app-registration', allowedDomains: ['kahf.co'], tenantId: '2f6a1c1e-5d3b-4e8a-9c41-7b0d2a9e3f10', issuer: 'https://sso.kahf.co', enabled: true }));
  }

  const me = (): Person => {
    const p = people.find((x) => x.id === currentId);
    if (!p) throw new MockHttpError(401, 'unauthenticated', 'Sign in required');
    return p;
  };
  const isAdmin = (p: Person) => p.role === 'owner' || p.role === 'admin';
  const methods = () => [
    { kind: 'password' as const, label: 'Password' },
    ...providers.filter((p) => p.enabled).map((p) => ({ kind: p.kind, label: p.label })),
  ];
  const sessionBody = () => {
    const p = me();
    return AuthenticatedSession.parse({
      authenticated: true,
      person: { id: p.id, name: p.name, email: p.email },
      workspace: { id: WORKSPACE_ID, name: workspaceName },
      role: p.role,
      teams: teams.flatMap((t) => {
        const m = t.members.find((x) => x.personId === p.id);
        return m ? [{ slug: t.slug, name: t.name, role: m.role }] : [];
      }),
      methods: methods(),
      expiresAt: '2026-10-31T08:00:00.000Z',
    });
  };
  const teamOf = (slug: string | undefined): TeamState => {
    const t = teams.find((x) => x.slug === slug);
    const p = me();
    if (!t) {
      if (isAdmin(p)) throw new MockHttpError(404, 'not_found', 'No such team.');
      throw new MockHttpError(403, 'forbidden', 'You do not have access to this team.');
    }
    if (!isAdmin(p) && !t.members.some((m) => m.personId === p.id)) throw new MockHttpError(403, 'forbidden', 'You do not have access to this team.');
    return t;
  };
  const manage = (t: TeamState): void => {
    const p = me();
    if (!isAdmin(p) && t.members.find((m) => m.personId === p.id)?.role !== 'lead') throw new MockHttpError(403, 'forbidden', 'Only a team lead or a workspace admin can do that.');
    if (t.archivedAt) throw new MockHttpError(409, 'conflict', 'This team is archived. Restore it first.');
  };
  const requireAdmin = (): void => {
    if (!isAdmin(me())) throw new MockHttpError(404, 'not_found', 'Not found.');
  };
  const definition = (t: TeamState) => (t.template ? definitionOf(SPECS.find((s) => s.id === t.template)!) : null);
  const teamDetail = (t: TeamState) => ({
    id: t.id, workspaceId: WORKSPACE_ID, slug: t.slug, name: t.name, template: t.template, templateDefinition: definition(t), archivedAt: t.archivedAt,
    createdAt: '2026-09-24T09:30:00.000Z', updatedAt: '2026-09-24T09:30:00.000Z',
    myRole: t.members.find((m) => m.personId === currentId)?.role ?? null, memberCount: t.members.length,
  });
  const teamSummary = (t: TeamState) => {
    const { templateDefinition: _d, ...rest } = teamDetail(t);
    void _d;
    return rest;
  };
  const rosterMember = (t: TeamState, personId: string) => {
    const p = people.find((x) => x.id === personId)!;
    const m = t.members.find((x) => x.personId === personId)!;
    return {
      personId: p.id, actorId: uuid('d', Number(p.id.slice(-4))), displayName: p.name, email: p.email, workspaceRole: p.role, role: m.role,
      tags: [...t.tags].filter(([, holders]) => holders.has(personId)).map(([tag]) => tag), joinedAt: p.joinedAt,
    };
  };
  const tagBody = (t: TeamState, name: string) => ({ name, roleId: uuid('e', 100 + [...t.tags.keys()].indexOf(name)), holders: [...(t.tags.get(name) ?? [])] });
  const invitationBody = (i: InvitationState) => ({
    id: uuid('9', Number(i.id.slice(-4))), workspaceId: WORKSPACE_ID, teamId: i.teamSlug ? (teams.find((t) => t.slug === i.teamSlug)?.id ?? null) : null,
    email: i.email, role: i.role, grant: i.teamSlug ? { teamRole: i.teamRole } : {}, invitedBy: me().id, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt, createdAt: NOW,
  });
  const newInvitation = (teamSlug: string | null, email: string, role: InvitationState['role'], teamRole: TeamRole): InvitationState => {
    const n = invitations.length + 1;
    const inv: InvitationState = { id: uuid('9', n), token: `mock-invite-token-${n}-abcdefghij`, teamSlug, teamRole, email, role, invitedBy: me().name, expiresAt: '2026-10-08T14:02:00.000Z', acceptedAt: null };
    invitations.push(inv);
    return inv;
  };

  type Handler = (c: Ctx) => unknown;
  const table: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];
  const on = (route: { method: string; path: string }, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(`^${route.path.replace(/:([A-Za-z_]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    table.push({ method: route.method, re, keys, handler });
  };
  const gone = (what: string): never => {
    throw new MockHttpError(410, 'gone', what);
  };
  const providerOf = (id: string | undefined): OidcProvider => {
    const p = providers.find((x) => x.id === id);
    if (!p) throw new MockHttpError(404, 'not_found', 'No such provider.');
    return p;
  };
  const replaceProvider = (next: OidcProvider): OidcProvider => {
    providers[providers.findIndex((x) => x.id === next.id)] = next;
    return next;
  };

  // ---- session and sign-in
  on(getSessionRoute, () => {
    if (currentId) return GetSessionResponse.parse(sessionBody());
    return { authenticated: false, methods: methods() };
  });
  on(signInWithPasswordRoute, ({ body }) => {
    const email = String(body.email).trim().toLowerCase();
    if ((failures.get(email) ?? 0) >= 5) throw new MockHttpError(429, 'rate_limited', 'Too many failed attempts. Try again in 15 minutes.');
    const found = people.find((p) => p.email === email);
    if (!found || body.password !== passwordOf(found)) {
      failures.set(email, (failures.get(email) ?? 0) + 1);
      throw new MockHttpError(401, 'unauthenticated', 'Incorrect email or password.');
    }
    failures.delete(email);
    currentId = found.id;
    return sessionBody();
  });
  on(requestPasswordResetRoute, () => ({ status: 202, body: { accepted: true } }));
  on(resetPasswordRoute, ({ body }) => {
    if (String(body.token).startsWith('expired')) gone('This link has expired or was already used.');
    return { ok: true };
  });
  on(changePasswordRoute, ({ body }) => {
    const p = me();
    const b = ChangePasswordRequest.parse(body);
    if (b.currentPassword !== passwordOf(p)) throw new MockHttpError(400, 'validation_failed', 'Your current password is incorrect.');
    if (b.newPassword === b.currentPassword) throw new MockHttpError(400, 'validation_failed', 'Choose a password you have not used just now.');
    passwords.set(p.id, b.newPassword);
    const others = sessions.filter((x) => !x.current).length;
    sessions = sessions.filter((x) => x.current);
    return { ok: true, revokedSessions: others };
  });
  on(updateAccountRoute, ({ body }) => {
    const p = me();
    const name = String(body.displayName ?? '').trim();
    if (!name) throw new MockHttpError(400, 'validation_failed', 'Enter your name.', ['displayName']);
    p.name = name;
    return { person: { id: p.id, name: p.name, email: p.email } };
  });
  on(requestEmailVerificationRoute, () => ({ status: 202, body: { accepted: true } }));
  on(verifyEmailRoute, ({ body }) => {
    if (String(body.token).startsWith('expired')) gone('This link has expired or was already used.');
    return { ok: true, email: 'omar@kahf.co' };
  });
  on(signOutRoute, () => {
    me();
    currentId = null;
    return { ok: true };
  });
  on(signOutEverywhereRoute, () => {
    me();
    currentId = null;
    return { ok: true, revoked: sessions.length };
  });
  on(listSessionsRoute, () => (me(), ListSessionsResponse.parse({ sessions })));
  on(revokeSessionRoute, ({ params }) => {
    me();
    if (!sessions.some((x) => x.id === params.id)) throw new MockHttpError(404, 'not_found', 'No such session.');
    sessions = sessions.filter((x) => x.id !== params.id);
    return { ok: true };
  });

  // ---- OIDC
  on(listOidcMethodsRoute, () => ({
    methods: providers.filter((p) => p.enabled).map((p) => ({ id: p.id, kind: p.kind, label: p.label, startUrl: `/api/auth/oidc/${p.id}/start` })),
  }));
  on(listOidcProvidersRoute, () => (requireAdmin(), { providers }));
  on(createOidcProviderRoute, ({ body }) => {
    requireAdmin();
    const b = CreateOidcProviderRequest.parse(body);
    const p = makeProvider(b.kind, { clientId: b.clientId, allowedDomains: b.allowedDomains, enabled: b.enabled, ...(b.kind === 'microsoft' ? { tenantId: b.tenantId } : {}), ...(b.kind === 'oidc' ? { issuer: b.issuer } : {}) });
    providers.push(p);
    return created({ provider: p });
  });
  on(updateOidcProviderRoute, ({ params, body }) => {
    requireAdmin();
    const cur = providerOf(params.providerId);
    const next = makeProvider(cur.kind, {
      clientId: typeof body.clientId === 'string' ? body.clientId : cur.clientId,
      allowedDomains: Array.isArray(body.allowedDomains) ? (body.allowedDomains as string[]) : cur.allowedDomains,
      tenantId: typeof body.tenantId === 'string' ? body.tenantId : (cur.tenantId ?? undefined),
      issuer: typeof body.issuer === 'string' ? body.issuer : cur.issuer,
      enabled: cur.enabled || cur.disabledReason !== null,
    });
    return { provider: replaceProvider({ ...next, id: cur.id, createdAt: cur.createdAt }) };
  });
  on(testOidcProviderRoute, ({ params }) => {
    requireAdmin();
    const cur = providerOf(params.providerId);
    const next = makeProvider(cur.kind, { clientId: cur.clientId, allowedDomains: cur.allowedDomains, tenantId: cur.tenantId ?? undefined, issuer: cur.issuer, enabled: cur.enabled });
    const provider = replaceProvider({ ...next, id: cur.id, createdAt: cur.createdAt, enabled: next.lastTest?.ok ? cur.enabled : false });
    return { result: provider.lastTest ?? { ok: true, message: 'Discovery passed.', checkedAt: NOW }, provider };
  });
  on(enableOidcProviderRoute, ({ params }) => {
    requireAdmin();
    const cur = providerOf(params.providerId);
    const next = makeProvider(cur.kind, { clientId: cur.clientId, allowedDomains: cur.allowedDomains, tenantId: cur.tenantId ?? undefined, issuer: cur.issuer, enabled: true });
    return { provider: replaceProvider({ ...next, id: cur.id, createdAt: cur.createdAt }) };
  });
  on(disableOidcProviderRoute, ({ params }) => {
    requireAdmin();
    const cur = providerOf(params.providerId);
    return { provider: replaceProvider({ ...cur, enabled: false, disabledReason: null }) };
  });
  on(deleteOidcProviderRoute, ({ params }) => {
    requireAdmin();
    const cur = providerOf(params.providerId);
    providers.splice(providers.indexOf(cur), 1);
    return { ok: true };
  });

  // ---- bootstrap and invitations
  on(checkBootstrapRoute, ({ params }) => {
    if (params.token === 'used' || params.token === 'expired') gone('This setup link has already been used or has expired.');
    return { valid: true };
  });
  on(bootstrapWorkspaceRoute, ({ params, body }) => {
    if (params.token === 'used' || params.token === 'expired') gone('This setup link has already been used or has expired.');
    const p: Person = { id: nextId('c'), name: String(body.name), email: String(body.email).toLowerCase(), role: 'owner', joinedAt: NOW };
    people.push(p);
    workspaceName = String(body.workspaceName);
    currentId = p.id;
    return sessionBody();
  });
  on(getInvitationRoute, ({ params }) => {
    if (params.token === 'expired' || params.token === 'used') gone('This invitation has expired or was already used.');
    const inv = invitations.find((i) => i.token === params.token);
    if (params.token !== 'new-person-invite-token' && !inv) throw new MockHttpError(404, 'not_found', 'No such invitation.');
    return GetInvitationResponse.parse({
      workspaceName, teamName: inv ? (teams.find((t) => t.slug === inv.teamSlug)?.name ?? null) : 'Engineering', email: inv?.email ?? 'new.person@kahf.co',
      role: inv?.role ?? 'member', invitedBy: inv?.invitedBy ?? 'Omar Al Zabir', expiresAt: inv?.expiresAt ?? '2026-10-08T14:02:00.000Z',
    });
  });
  on(acceptInvitationRoute, ({ params, body }) => {
    if (params.token === 'expired' || params.token === 'used') gone('This invitation has expired or was already used.');
    const inv = invitations.find((i) => i.token === params.token);
    const email = inv?.email ?? 'new.person@kahf.co';
    let p = people.find((x) => x.email === email);
    const createdPerson = !p;
    if (!p) {
      p = { id: nextId('c'), name: typeof body.name === 'string' ? body.name : email, email, role: 'member', joinedAt: NOW };
      people.push(p);
    }
    const team = teams.find((t) => t.slug === inv?.teamSlug) ?? teams[0];
    if (team && !team.members.some((m) => m.personId === p!.id)) team.members.push({ personId: p.id, role: inv?.teamRole ?? 'member' });
    if (inv) inv.acceptedAt = NOW;
    return AcceptInvitationResponse.parse({ workspaceId: WORKSPACE_ID, personId: p.id, email, workspaceRole: p.role, teamId: team?.id ?? null, teamRole: inv?.teamRole ?? 'member', createdPerson });
  });
  on(createInvitationRoute, ({ body }) => {
    requireAdmin();
    const inv = newInvitation(null, String(body.email), body.role as InvitationState['role'], 'member');
    return created(CreateInvitationResponse.parse({ invitation: invitationBody(inv), token: inv.token }));
  });

  // ---- workspace
  on(listWorkspaceMembersRoute, () => {
    requireAdmin();
    return {
      members: people.map((p) => ({
        personId: p.id, displayName: p.name, email: p.email, status: 'active', role: p.role, joinedAt: p.joinedAt,
        tags: [...new Set(teams.flatMap((t) => [...t.tags].filter(([, h]) => h.has(p.id)).map(([tag]) => tag)))],
      })),
    };
  });

  const workspaceBody = () => ({ workspace: { id: WORKSPACE_ID, name: workspaceName, selfSignup, passwordForMembers } });
  on(getWorkspaceRoute, () => (requireAdmin(), workspaceBody()));
  on(updateWorkspaceRoute, ({ body }) => {
    requireAdmin();
    if (typeof body.name === 'string') workspaceName = body.name.trim();
    if (typeof body.selfSignup === 'boolean') selfSignup = body.selfSignup;
    if (typeof body.passwordForMembers === 'boolean') passwordForMembers = body.passwordForMembers;
    return workspaceBody();
  });
  on(updateWorkspaceMemberRoute, ({ params, body }) => {
    const caller = me();
    requireAdmin();
    const target = people.find((x) => x.id === params.personId);
    if (!target) throw new MockHttpError(404, 'not_found', 'No such member');
    const role = body.role as WorkspaceRole;
    if ((target.role === 'owner' || role === 'owner') && caller.role !== 'owner') throw new MockHttpError(403, 'forbidden', 'Only an owner can change an owner');
    if (target.role === 'owner' && role !== 'owner' && people.filter((x) => x.role === 'owner').length === 1) {
      throw new MockHttpError(409, 'conflict', 'a workspace must keep at least one owner; make someone else an owner first');
    }
    target.role = role;
    return { personId: target.id, role };
  });

  // ---- teams
  on(listTemplatesRoute, () => {
    me();
    return ListTemplatesResponse.parse({
      templates: SPECS.map((s) => ({ id: s.id, name: s.name, description: s.description, version: 1, channels: s.channels, board: s.board, bots: s.bots.map((b) => ({ slug: b.slug, name: b.name, role: b.role, automation: b.automation ?? false })), roleTags: s.roleTags })),
    });
  });
  on(listTeamsRoute, ({ query }) => {
    const p = me();
    const all = query.get('includeArchived') === 'true';
    return { teams: teams.filter((t) => (all || !t.archivedAt) && (isAdmin(p) || t.members.some((m) => m.personId === p.id))).map(teamSummary) };
  });
  on(getTeamRoute, ({ params }) => ({ team: teamDetail(teamOf(params.slug)) }));
  const makeTeam = (name: string, slug: string, template: string | null): TeamState => {
    const p = me();
    if (!isAdmin(p)) throw new MockHttpError(403, 'forbidden', 'Only a workspace admin can create teams.');
    const t = addTeam(slug, name, template, [], {});
    t.members.push({ personId: p.id, role: 'lead' });
    if (template) for (const tag of SPECS.find((s) => s.id === template)?.roleTags ?? []) t.tags.set(tag, new Set());
    return t;
  };
  on(createTeamRoute, ({ body }) => {
    const slug = typeof body.slug === 'string' ? body.slug : slugify(String(body.name));
    if (teams.some((t) => t.slug === slug)) throw new MockHttpError(409, 'conflict', 'A team with that slug already exists.');
    return created({ team: teamDetail(makeTeam(String(body.name), slug, null)) });
  });
  on(applyTeamTemplateRoute, ({ body }) => {
    const spec = SPECS.find((s) => s.id === body.templateId);
    if (!spec) throw new MockHttpError(404, 'not_found', 'No such template.');
    const name = typeof body.name === 'string' ? body.name : spec.name;
    const slug = typeof body.slug === 'string' ? body.slug : slugify(name);
    const existing = teams.find((t) => t.slug === slug);
    if (existing) {
      if (existing.template !== spec.id) throw new MockHttpError(409, 'conflict', 'A team with that slug already exists.');
      return { team: teamDetail(existing), created: false };
    }
    return created({ team: teamDetail(makeTeam(name, slug, spec.id)), created: true });
  });
  on(renameTeamRoute, ({ params, body }) => {
    const t = teamOf(params.slug);
    manage(t);
    t.name = String(body.name);
    return { team: teamDetail(t) };
  });
  on(archiveTeamRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    t.archivedAt = NOW;
    return { team: teamDetail(t), changed: true };
  });
  on(unarchiveTeamRoute, ({ params }) => {
    const t = teamOf(params.slug);
    t.archivedAt = null;
    return { team: teamDetail(t), changed: true };
  });
  on(getTeamRosterRoute, ({ params }) => {
    const t = teamOf(params.slug);
    return { members: t.members.map((m) => rosterMember(t, m.personId)) };
  });
  on(addTeamMemberRoute, ({ params, body }) => {
    const t = teamOf(params.slug);
    manage(t);
    const target = people.find((p) => p.id === body.personId);
    if (!target) throw new MockHttpError(404, 'not_found', 'No such person.');
    if (target.role === 'guest') throw new MockHttpError(409, 'conflict', 'A guest cannot be a team member.');
    const had = t.members.some((m) => m.personId === target.id);
    if (!had) t.members.push({ personId: target.id, role: (body.role as TeamRole | undefined) ?? 'member' });
    return created({ member: rosterMember(t, target.id), added: !had });
  });
  on(setTeamMemberRoleRoute, ({ params, body }) => {
    const t = teamOf(params.slug);
    manage(t);
    const m = t.members.find((x) => x.personId === params.personId);
    if (!m) throw new MockHttpError(404, 'not_found', 'Not a member of this team.');
    const next = body.role as TeamRole;
    if (m.role === 'lead' && next !== 'lead' && t.members.filter((x) => x.role === 'lead').length === 1) throw new MockHttpError(409, 'conflict', 'A team needs at least one lead.');
    const changed = m.role !== next;
    m.role = next;
    return { member: rosterMember(t, m.personId), changed };
  });
  on(removeTeamMemberRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    const m = t.members.find((x) => x.personId === params.personId);
    if (m?.role === 'lead' && t.members.filter((x) => x.role === 'lead').length === 1) throw new MockHttpError(409, 'conflict', 'A team needs at least one lead.');
    const tags = [...t.tags].filter(([, h]) => h.has(params.personId!)).map(([tag]) => tag);
    t.members = t.members.filter((x) => x.personId !== params.personId);
    for (const h of t.tags.values()) h.delete(params.personId!);
    return { removed: Boolean(m), tags };
  });
  on(listTeamTagsRoute, ({ params }) => {
    const t = teamOf(params.slug);
    return { tags: [...t.tags.keys()].map((n) => tagBody(t, n)) };
  });
  on(createTeamTagRoute, ({ params, body }) => {
    const t = teamOf(params.slug);
    manage(t);
    const name = String(body.name);
    const had = t.tags.has(name);
    if (!had) t.tags.set(name, new Set());
    return created({ tag: tagBody(t, name), created: !had });
  });
  on(deleteTeamTagRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    const holders = [...(t.tags.get(params.tag!) ?? [])];
    return { deleted: t.tags.delete(params.tag!), removedFrom: holders };
  });
  on(assignTeamTagRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    if (!t.members.some((m) => m.personId === params.personId)) throw new MockHttpError(404, 'not_found', 'Not a member of this team.');
    const name = params.tag!;
    if (!/^role:[a-z][a-z0-9-]*$/.test(name)) throw new MockHttpError(400, 'validation_failed', "role tag like 'role:on-call'");
    const holders = t.tags.get(name) ?? new Set<string>();
    t.tags.set(name, holders);
    const assigned = !holders.has(params.personId!);
    holders.add(params.personId!);
    return { tag: tagBody(t, name), assigned };
  });
  on(unassignTeamTagRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    return { removed: t.tags.get(params.tag!)?.delete(params.personId!) ?? false };
  });
  // The sidebar's channel groups. A guest gets only the channel granted to them (Lena: #releases), whatever the team.
  on(navChannelDirectoryRoute, ({ params }) => {
    const p = me();
    const spec = SPECS.find((s) => s.id === (teams.find((t) => t.slug === params.slug)?.template ?? params.slug));
    const names = p.role === 'guest' ? ['#releases'] : (teamOf(params.slug) && spec ? spec.channels : []);
    return NavChannelDirectory.parse({
      groups: names.length === 0 ? [] : [{
        id: uuid('7', 1), name: 'Channels',
        channels: names.map((name, i) => ({ id: uuid('7', 10 + i), name, isPrivate: false, unread: p.role !== 'guest' && name === '#dev' ? 4 : 0 })),
      }],
    });
  });
  on(createTeamInvitationRoute, ({ params, body }) => {
    const t = teamOf(params.slug);
    manage(t);
    const inv = newInvitation(t.slug, String(body.email), 'member', (body.teamRole as TeamRole | undefined) ?? 'member');
    return created({ invitation: invitationBody(inv), token: inv.token });
  });
  on(listTeamInvitationsRoute, ({ params }) => {
    const t = teamOf(params.slug);
    manage(t);
    return { invitations: invitations.filter((i) => i.teamSlug === t.slug).map(invitationBody) };
  });

  return async (req) => {
    await new Promise((r) => setTimeout(r, options.latencyMs ?? LATENCY_MS));
    const [path = '', qs = ''] = req.url.split('?');
    const hit = table.find((t) => t.method === req.method && t.re.test(path));
    try {
      if (!hit) throw new MockHttpError(404, 'not_found', `No mock for ${req.method} ${path}`);
      const m = hit.re.exec(path)!;
      const params = Object.fromEntries(hit.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      const out = hit.handler({ params, query: new URLSearchParams(qs), body });
      if (out && typeof out === 'object' && 'status' in out && 'body' in out) return out as Reply;
      return { status: 200, body: out };
    } catch (e) {
      if (e instanceof MockHttpError) {
        return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) } } };
      }
      throw e;
    }
  };
}
