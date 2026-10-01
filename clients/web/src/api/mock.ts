import type { ErrorCode } from '@manythreads/shared';
import type { Transport } from './client';
import * as s from './schemas';

/*
 * Mock transport (P2-10a). Enabled with `?mock=1` (remembered for the tab) or VITE_MANYTHREADS_MOCK=1.
 * Serves fixtures for workspace "Kahf Software" and its seven personas so every screen renders without a
 * server; it is also the screenshot path until the real API exists.
 *
 *   ?mock=1                     signed in as Omar
 *   ?mock=1&as=nadia            signed in as another persona (omar nadia rafi sameera tariq priya lena)
 *   ?mock=1&anon=1              signed out (sign-in screen)
 *   ?mock=1&providers=google,microsoft   which provider buttons the sign-in screen shows
 *   ?mock=1&teams=none          no teams yet (empty state)
 * Password for every persona: MOCK_PASSWORD.
 */

export const MOCK_PASSWORD = 'correct-horse-battery';
const LATENCY_MS = 40;

type Person = { id: string; name: string; email: string; role: s.WorkspaceRole; tags: string[] };

const PEOPLE: Person[] = [
  { id: 'p-omar', name: 'Omar Al Zabir', email: 'omar@kahf.co', role: 'owner', tags: [] },
  { id: 'p-nadia', name: 'Nadia R.', email: 'nadia@kahf.co', role: 'member', tags: ['role:release-owner'] },
  { id: 'p-rafi', name: 'Rafi K.', email: 'rafi@kahf.co', role: 'member', tags: ['role:on-call'] },
  { id: 'p-sameera', name: 'Sameera A.', email: 'sameera@kahf.co', role: 'member', tags: ['role:support-agent'] },
  { id: 'p-tariq', name: 'Tariq H.', email: 'tariq@kahf.co', role: 'member', tags: ['role:content-lead'] },
  { id: 'p-priya', name: 'Priya S.', email: 'priya@kahf.co', role: 'member', tags: [] },
  { id: 'p-lena', name: 'Lena M.', email: 'lena@partner.example', role: 'guest', tags: [] },
];

const bot = (name: string, role: string, automation = false) => ({ name, role, automation });
const BRAIN = bot('Brain', 'Answers from what the team knows. Read-only. Part of every team.');

const TEMPLATES: s.TemplateInfo[] = [
  {
    id: 'engineering',
    name: 'Engineering',
    description: 'Ship software: dev, releases, incidents and alerts.',
    channels: ['#general', '#dev', '#releases', '#incidents', '#alerts', '#standup'],
    board: 'Engineering board',
    bots: [
      BRAIN,
      bot('Orchestrator', "Splits work across the team's agents, holds the task board"),
      bot('Coder', 'Writes and reviews code on a runner'),
      bot('Reviewer', 'Reviews pull requests against the team checklist'),
      bot('Tester', 'Runs the test suite and reports failures'),
      bot('Deploy', 'Watches builds, opens incidents, runs release checks'),
      bot('Standup relay', 'Collects "done:" messages and posts a summary at 17:00', true),
      bot('Alert triage', 'Sorts #alerts into incidents and noise'),
    ],
    needs: [],
  },
  {
    id: 'customer-support',
    name: 'Customer support',
    description: 'Answer customers from the manuals and escalate what needs a person.',
    channels: ['#support', '#escalations', '#enquiries', '#kb-updates'],
    board: 'Support queue',
    bots: [
      BRAIN,
      bot('Support responder', 'Drafts replies from the manuals knowledge base'),
      bot('Enquiry bot', 'Handles the sales@ inbox'),
      bot('Escalation router', 'Routes sev1 tickets to the on-call person', true),
      bot('KB gardener', 'Keeps the knowledge base fresh'),
    ],
    needs: ['support inbox', 'manuals'],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    description: 'Campaigns, content, social and analytics.',
    channels: ['#campaigns', '#content', '#social', '#analytics', '#brand'],
    board: 'Content calendar',
    bots: [
      BRAIN,
      bot('Content drafter', 'Drafts pages and posts for review'),
      bot('Social scheduler', 'Queues approved posts', true),
      bot('Analytics digest', 'Posts the weekly numbers'),
      bot('Brand reviewer', 'Checks drafts against the brand guide'),
    ],
    needs: ['social accounts', 'analytics'],
  },
  {
    id: 'product-design',
    name: 'Product design',
    description: 'Design, feedback, specs and critique.',
    channels: ['#design', '#feedback', '#specs', '#critique'],
    board: 'Design board',
    bots: [BRAIN, bot('Spec writer', 'Turns notes into specs'), bot('Feedback synthesiser', 'Clusters feedback'), bot('Design critique', 'Gives a first-pass critique'), bot('Figma watcher', 'Posts design changes', true)],
    needs: [],
  },
  {
    id: 'research',
    name: 'Research',
    description: 'Papers, experiments, notes and a reading group.',
    channels: ['#papers', '#experiments', '#notes', '#reading-group'],
    board: 'Experiments',
    bots: [BRAIN, bot('Literature scout', 'Finds new papers'), bot('Summariser', 'Summarises a paper'), bot('Experiment tracker', 'Tracks runs'), bot('Citation checker', 'Checks references')],
    needs: [],
  },
];

type TeamState = { slug: string; name: string; templateId: string | null; members: Array<{ id: string; role: s.TeamRole }> };

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

export function createMockTransport(options: MockOptions = {}): Transport {
  const people = PEOPLE.map((p) => ({ ...p }));
  const teams: TeamState[] = [
    { slug: 'engineering', name: 'Engineering', templateId: 'engineering', members: [{ id: 'p-omar', role: 'lead' }, { id: 'p-nadia', role: 'member' }, { id: 'p-rafi', role: 'member' }, { id: 'p-priya', role: 'member' }] },
    { slug: 'customer-support', name: 'Customer support', templateId: 'customer-support', members: [{ id: 'p-sameera', role: 'member' }] },
    { slug: 'marketing', name: 'Marketing', templateId: 'marketing', members: [{ id: 'p-tariq', role: 'lead' }, { id: 'p-priya', role: 'member' }] },
  ];
  if (options.noTeams) teams.length = 0;
  let workspaceName = 'Kahf Software';
  let currentId: string | null = options.anon ? null : (people.find((p) => p.id === `p-${options.as ?? 'omar'}`)?.id ?? 'p-omar');
  let sessions: s.AccountSession[] = [
    { id: 'sess-1', label: 'This browser', current: true, lastSeenAt: '2026-10-01T14:02:00.000Z' },
    { id: 'sess-2', label: 'Chrome · London', current: false, lastSeenAt: '2026-09-30T18:40:00.000Z' },
    { id: 'sess-3', label: 'Safari · Dubai', current: false, lastSeenAt: '2026-09-27T07:15:00.000Z' },
  ];
  const providerFlags = new Set(options.providers ?? ['google']);
  const providers: s.ProviderConfig[] = [
    { kind: 'google', enabled: providerFlags.has('google'), status: 'verified', statusDetail: 'Discovery and a test token exchange passed.', clientId: '847213-9kd…apps.googleusercontent.com', secretSet: true, domains: ['kahf.co'], tenantId: null, issuer: null },
    { kind: 'microsoft', enabled: providerFlags.has('microsoft'), status: providerFlags.has('microsoft') ? 'verified' : 'not_configured', statusDetail: null, clientId: '', secretSet: false, domains: [], tenantId: null, issuer: null },
    { kind: 'oidc', enabled: false, status: 'not_configured', statusDetail: null, clientId: '', secretSet: false, domains: [], tenantId: null, issuer: null },
  ];
  let password: s.PasswordPolicy = { enabled: true, minLength: 12, requireVerification: true, allowSelfSignup: false };

  const me = (): Person => {
    const p = people.find((x) => x.id === currentId);
    if (!p) throw new MockHttpError(401, 'unauthenticated', 'Sign in to continue.');
    return p;
  };
  const isAdmin = (p: Person) => p.role === 'owner' || p.role === 'admin';
  const requireAdmin = () => {
    if (!isAdmin(me())) throw new MockHttpError(404, 'not_found', 'Not found.');
  };
  const sessionInfo = (): s.SessionInfo => {
    const p = me();
    return {
      person: { id: p.id, name: p.name, email: p.email },
      workspace: { id: 'w-kahf', name: workspaceName },
      role: p.role,
      teams: teams.flatMap((t) => {
        const m = t.members.find((x) => x.id === p.id);
        return m ? [{ slug: t.slug, name: t.name, role: m.role }] : [];
      }),
    };
  };
  const summary = (t: TeamState): s.TeamSummary => ({
    slug: t.slug,
    name: t.name,
    templateId: t.templateId,
    memberCount: t.members.length,
    myRole: t.members.find((m) => m.id === currentId)?.role ?? null,
  });
  const template = (id: string | null) => TEMPLATES.find((t) => t.id === id) ?? null;
  const visibleTeams = () => {
    const p = me();
    return teams.filter((t) => isAdmin(p) || t.members.some((m) => m.id === p.id));
  };

  type Ctx = { params: Record<string, string>; query: URLSearchParams; body: Record<string, unknown> };
  type Handler = (c: Ctx) => unknown;
  const table: Array<{ method: string; re: RegExp; keys: string[]; handler: Handler }> = [];
  const on = (route: { method: string; path: string }, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(`^${route.path.replace(/:([A-Za-z_]+)/g, (_m, k: string) => (keys.push(k), '([^/]+)'))}$`);
    table.push({ method: route.method, re, keys, handler });
  };

  on(s.sessionRoute, () => sessionInfo());
  on(s.signInOptionsRoute, () => ({
    workspaceName,
    google: providers[0]!.enabled,
    microsoft: providers[1]!.enabled,
    oidc: providers[2]!.enabled ? { name: 'Company SSO' } : null,
    password: password.enabled,
  }));
  on(s.passwordSignInRoute, ({ body }) => {
    const email = String(body.email).trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const person = people.find((p) => p.email === email);
    if (!person && domain && domain !== 'kahf.co') throw new MockHttpError(403, 'forbidden', 'That domain is not allowed.');
    if (!person || body.password !== MOCK_PASSWORD) throw new MockHttpError(401, 'unauthenticated', 'Email or password is incorrect.');
    currentId = person.id;
    return sessionInfo();
  });
  on(s.forgotPasswordRoute, () => undefined);
  on(s.signOutRoute, () => {
    currentId = null;
    return undefined;
  });
  on(s.signOutEverywhereRoute, () => {
    currentId = null;
    return undefined;
  });

  on(s.bootstrapInfoRoute, ({ params }) => {
    if (params.token === 'used' || params.token === 'expired') throw new MockHttpError(410, 'not_found', 'This link has already been used.');
    return { valid: true };
  });
  on(s.bootstrapRoute, ({ params, body }) => {
    if (params.token === 'used' || params.token === 'expired') throw new MockHttpError(410, 'not_found', 'This link has already been used.');
    const person: Person = { id: 'p-new', name: String(body.name), email: String(body.email), role: 'owner', tags: [] };
    people.push(person);
    workspaceName = String(body.workspaceName);
    currentId = person.id;
    return sessionInfo();
  });
  on(s.invitationInfoRoute, ({ params }) => {
    if (params.token === 'expired' || params.token === 'used') throw new MockHttpError(410, 'not_found', 'This invitation has expired.');
    return { workspaceName, teamName: 'Engineering', email: 'new.person@kahf.co', role: 'member', invitedBy: 'Omar Al Zabir' };
  });
  on(s.acceptInvitationRoute, ({ params, body }) => {
    if (params.token === 'expired' || params.token === 'used') throw new MockHttpError(410, 'not_found', 'This invitation has expired.');
    const person: Person = { id: 'p-new', name: String(body.name), email: 'new.person@kahf.co', role: 'member', tags: [] };
    people.push(person);
    teams[0]!.members.push({ id: person.id, role: 'member' });
    currentId = person.id;
    return sessionInfo();
  });

  on(s.accountSessionsRoute, () => (me(), sessions));
  on(s.revokeSessionRoute, ({ params }) => {
    me();
    sessions = sessions.filter((x) => x.id !== params.id);
    return undefined;
  });
  on(s.linkedMethodsRoute, () => {
    me();
    return [
      { kind: 'google', label: 'Google', linked: true },
      { kind: 'microsoft', label: 'Microsoft', linked: false },
      { kind: 'password', label: 'Password', linked: true },
    ];
  });
  on(s.renameAccountRoute, ({ body }) => {
    me().name = String(body.name);
    return sessionInfo();
  });
  on(s.changePasswordRoute, ({ body }) => {
    me();
    if (body.current !== MOCK_PASSWORD) throw new MockHttpError(403, 'forbidden', 'Your current password is incorrect.', ['current']);
    return undefined;
  });

  on(s.workspaceRoute, () => {
    requireAdmin();
    return { id: 'w-kahf', name: workspaceName, memberCount: people.length, teamCount: teams.length };
  });
  on(s.renameWorkspaceRoute, ({ body }) => {
    requireAdmin();
    workspaceName = String(body.name);
    return { id: 'w-kahf', name: workspaceName, memberCount: people.length, teamCount: teams.length };
  });
  on(s.signInSettingsRoute, () => {
    requireAdmin();
    return { providers, password };
  });
  on(s.saveProviderRoute, ({ params, body }) => {
    requireAdmin();
    const p = providers.find((x) => x.kind === params.provider);
    if (!p) throw new MockHttpError(404, 'not_found', 'Unknown provider.');
    p.enabled = body.enabled === true;
    p.clientId = String(body.clientId ?? '');
    if (typeof body.clientSecret === 'string' && body.clientSecret !== '') p.secretSet = true;
    p.domains = (body.domains as string[]) ?? [];
    p.tenantId = (body.tenantId as string | null) ?? null;
    p.issuer = (body.issuer as string | null) ?? null;
    const missing = p.kind === 'oidc' ? !p.issuer : !p.clientId || !p.secretSet || (p.kind === 'microsoft' && !p.tenantId);
    p.status = missing ? 'not_configured' : p.status === 'error' ? 'error' : 'verified';
    p.statusDetail = null;
    return p;
  });
  on(s.testProviderRoute, ({ params }) => {
    requireAdmin();
    const p = providers.find((x) => x.kind === params.provider);
    if (!p) throw new MockHttpError(404, 'not_found', 'Unknown provider.');
    if (p.kind === 'oidc' && p.issuer && !p.issuer.startsWith('https://')) {
      p.status = 'error';
      p.enabled = false;
      p.statusDetail = `Discovery failed: ${p.issuer} is not an https URL. The provider stays disabled.`;
      return { ok: false, detail: p.statusDetail };
    }
    if (!p.clientId || !p.secretSet) return { ok: false, detail: 'Client ID and client secret are required.' };
    if (p.kind === 'microsoft' && !p.tenantId) return { ok: false, detail: 'Tenant ID is required.' };
    p.status = 'verified';
    p.statusDetail = 'Discovery and a test token exchange passed.';
    return { ok: true, detail: p.statusDetail };
  });
  on(s.savePasswordPolicyRoute, ({ body }) => {
    requireAdmin();
    password = { ...password, enabled: body.enabled === true, requireVerification: body.requireVerification === true, allowSelfSignup: body.allowSelfSignup === true };
    return password;
  });
  on(s.membersRoute, () => {
    requireAdmin();
    return people.map((p) => ({ id: p.id, name: p.name, email: p.email, role: p.role, tags: p.tags }));
  });
  on(s.rolesRoute, () => {
    requireAdmin();
    const tagTeam: Record<string, string> = { 'role:release-owner': 'engineering', 'role:on-call': 'engineering', 'role:support-agent': 'customer-support', 'role:content-lead': 'marketing' };
    const desc: Record<string, string> = {
      'role:release-owner': 'Requests and signs off a release.',
      'role:on-call': 'Approves production changes and follows incidents.',
      'role:support-agent': 'Works the support queue and approves replies.',
      'role:content-lead': 'Owns content pages and pinned reports.',
    };
    return Object.keys(tagTeam).map((tag) => ({ tag, description: desc[tag] ?? '', teamSlug: tagTeam[tag]!, members: people.filter((p) => p.tags.includes(tag)).map((p) => p.name) }));
  });

  on(s.templatesRoute, () => (me(), TEMPLATES));
  on(s.teamsRoute, () => visibleTeams().map(summary));
  on(s.createTeamRoute, ({ body }) => {
    const p = me();
    if (!isAdmin(p)) throw new MockHttpError(403, 'forbidden', 'Only admins can create teams.');
    const name = String(body.name);
    const slug = slugify(name);
    if (teams.some((t) => t.slug === slug)) {
      // applying twice duplicates nothing: same name returns the existing team
      return summary(teams.find((t) => t.slug === slug)!);
    }
    const t: TeamState = { slug, name, templateId: (body.templateId as string | null) ?? null, members: [{ id: p.id, role: 'lead' }] };
    teams.push(t);
    return summary(t);
  });
  on(s.teamRoute, ({ params }) => {
    const p = me();
    const t = teams.find((x) => x.slug === params.slug);
    if (!t) throw new MockHttpError(404, 'not_found', 'Team not found.');
    if (!isAdmin(p) && !t.members.some((m) => m.id === p.id)) throw new MockHttpError(403, 'forbidden', 'You are not a member of this team.');
    return {
      slug: t.slug,
      name: t.name,
      templateId: t.templateId,
      templateVersion: t.templateId ? 1 : null,
      appliedAt: '2026-09-24T09:30:00.000Z',
      members: t.members.map((m) => {
        const person = people.find((x) => x.id === m.id)!;
        return { id: person.id, name: person.name, email: person.email, role: m.role, tags: person.tags, presence: person.id === 'p-tariq' ? 'away' : person.id === 'p-priya' ? 'offline' : 'online' };
      }),
      template: template(t.templateId),
    };
  });
  on(s.inviteToTeamRoute, () => {
    me();
    return undefined;
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
      return { status: 200, body: hit.handler({ params, query: new URLSearchParams(qs), body }) };
    } catch (e) {
      if (e instanceof MockHttpError) {
        return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.path ? { path: e.path } : {}) } } };
      }
      throw e;
    }
  };
}
