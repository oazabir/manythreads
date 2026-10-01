import { z } from 'zod';
import type { ApiRoute } from '@majlis/shared';

/*
 * PLACEHOLDER API schemas for the identity / teams / settings screens (P2-10a).
 * They live here only until the real `packages/shared/src/api/<area>/<op>.ts` schemas land; the screens
 * talk to `endpoints.ts`, so swapping is a change in that one file (plus deleting this one).
 */

export const WorkspaceRole = z.enum(['owner', 'admin', 'member', 'guest']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;
export const TeamRole = z.enum(['lead', 'member']);
export type TeamRole = z.infer<typeof TeamRole>;

export const PASSWORD_MIN = 12;

// ---- session -------------------------------------------------------------------------------------------
export const SessionInfo = z.object({
  person: z.object({ id: z.string(), name: z.string(), email: z.string() }),
  workspace: z.object({ id: z.string(), name: z.string() }),
  role: WorkspaceRole,
  teams: z.array(z.object({ slug: z.string(), name: z.string(), role: TeamRole })),
});
export type SessionInfo = z.infer<typeof SessionInfo>;
export const sessionRoute = { method: 'GET', path: '/api/session' } as const satisfies ApiRoute;

export const NoContent = z.undefined();

// ---- sign-in -------------------------------------------------------------------------------------------
export const SignInOptions = z.object({
  workspaceName: z.string().nullable(),
  google: z.boolean(),
  microsoft: z.boolean(),
  oidc: z.object({ name: z.string() }).nullable(),
  password: z.boolean(),
});
export type SignInOptions = z.infer<typeof SignInOptions>;
export const signInOptionsRoute = { method: 'GET', path: '/api/auth/options' } as const satisfies ApiRoute;

export const PasswordSignInRequest = z.object({ email: z.string().min(1), password: z.string().min(1) }).strict();
export type PasswordSignInRequest = z.infer<typeof PasswordSignInRequest>;
export const passwordSignInRoute = { method: 'POST', path: '/api/auth/password/sign-in' } as const satisfies ApiRoute;

export const ForgotPasswordRequest = z.object({ email: z.string().min(1) }).strict();
export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequest>;
export const forgotPasswordRoute = { method: 'POST', path: '/api/auth/password/forgot' } as const satisfies ApiRoute;

export const signOutRoute = { method: 'POST', path: '/api/auth/sign-out' } as const satisfies ApiRoute;
export const signOutEverywhereRoute = { method: 'POST', path: '/api/auth/sign-out-everywhere' } as const satisfies ApiRoute;

/** Where the browser goes to start an OIDC sign-in (a full-page navigation, not an XHR). */
export const oidcStartPath = (provider: 'google' | 'microsoft' | 'oidc', returnTo: string): string =>
  `/api/auth/oidc/${provider}/start?return=${encodeURIComponent(returnTo)}`;

// ---- bootstrap and invitations -------------------------------------------------------------------------
export const BootstrapInfo = z.object({ valid: z.literal(true) });
export const bootstrapInfoRoute = { method: 'GET', path: '/api/bootstrap/:token' } as const satisfies ApiRoute;

export const BootstrapRequest = z
  .object({
    workspaceName: z.string().min(1, 'Name your workspace'),
    name: z.string().min(1, 'Enter your name'),
    email: z.string().min(1, 'Enter your email'),
    password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`),
  })
  .strict();
export type BootstrapRequest = z.infer<typeof BootstrapRequest>;
export const bootstrapRoute = { method: 'POST', path: '/api/bootstrap/:token' } as const satisfies ApiRoute;

export const InvitationInfo = z.object({
  workspaceName: z.string(),
  teamName: z.string().nullable(),
  email: z.string(),
  role: WorkspaceRole,
  invitedBy: z.string(),
});
export type InvitationInfo = z.infer<typeof InvitationInfo>;
export const invitationInfoRoute = { method: 'GET', path: '/api/invitations/:token' } as const satisfies ApiRoute;

export const AcceptInvitationRequest = z
  .object({
    name: z.string().min(1, 'Enter your name'),
    password: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`),
  })
  .strict();
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;
export const acceptInvitationRoute = { method: 'POST', path: '/api/invitations/:token/accept' } as const satisfies ApiRoute;

// ---- account -------------------------------------------------------------------------------------------
export const AccountSession = z.object({
  id: z.string(),
  label: z.string(),
  current: z.boolean(),
  lastSeenAt: z.string(),
});
export type AccountSession = z.infer<typeof AccountSession>;
export const AccountSessions = z.array(AccountSession);
export const accountSessionsRoute = { method: 'GET', path: '/api/account/sessions' } as const satisfies ApiRoute;
export const revokeSessionRoute = { method: 'DELETE', path: '/api/account/sessions/:id' } as const satisfies ApiRoute;

export const LinkedMethod = z.object({
  kind: z.enum(['google', 'microsoft', 'oidc', 'password']),
  label: z.string(),
  linked: z.boolean(),
});
export type LinkedMethod = z.infer<typeof LinkedMethod>;
export const LinkedMethods = z.array(LinkedMethod);
export const linkedMethodsRoute = { method: 'GET', path: '/api/account/methods' } as const satisfies ApiRoute;

export const RenameAccountRequest = z.object({ name: z.string().min(1, 'Enter your name') }).strict();
export const renameAccountRoute = { method: 'PATCH', path: '/api/account' } as const satisfies ApiRoute;

export const ChangePasswordRequest = z
  .object({ current: z.string().min(1), next: z.string().min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`) })
  .strict();
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;
export const changePasswordRoute = { method: 'POST', path: '/api/account/password' } as const satisfies ApiRoute;

// ---- workspace settings --------------------------------------------------------------------------------
export const WorkspaceInfo = z.object({ id: z.string(), name: z.string(), memberCount: z.number(), teamCount: z.number() });
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>;
export const workspaceRoute = { method: 'GET', path: '/api/workspace' } as const satisfies ApiRoute;
export const RenameWorkspaceRequest = z.object({ name: z.string().min(1, 'Name your workspace') }).strict();
export const renameWorkspaceRoute = { method: 'PATCH', path: '/api/workspace' } as const satisfies ApiRoute;

export const ProviderKind = z.enum(['google', 'microsoft', 'oidc']);
export type ProviderKind = z.infer<typeof ProviderKind>;

/** Provider config as read back. The secret is never returned: only whether one is stored. */
export const ProviderConfig = z.object({
  kind: ProviderKind,
  enabled: z.boolean(),
  status: z.enum(['verified', 'not_configured', 'error']),
  statusDetail: z.string().nullable(),
  clientId: z.string(),
  secretSet: z.boolean(),
  domains: z.array(z.string()),
  tenantId: z.string().nullable(),
  issuer: z.string().nullable(),
});
export type ProviderConfig = z.infer<typeof ProviderConfig>;

export const PasswordPolicy = z.object({
  enabled: z.boolean(),
  minLength: z.number(),
  requireVerification: z.boolean(),
  allowSelfSignup: z.boolean(),
});
export type PasswordPolicy = z.infer<typeof PasswordPolicy>;

export const SignInSettings = z.object({ providers: z.array(ProviderConfig), password: PasswordPolicy });
export type SignInSettings = z.infer<typeof SignInSettings>;
export const signInSettingsRoute = { method: 'GET', path: '/api/workspace/sign-in' } as const satisfies ApiRoute;

export const SaveProviderRequest = z
  .object({
    enabled: z.boolean(),
    clientId: z.string(),
    clientSecret: z.string().optional(),
    domains: z.array(z.string()),
    tenantId: z.string().nullable(),
    issuer: z.string().nullable(),
  })
  .strict();
export type SaveProviderRequest = z.infer<typeof SaveProviderRequest>;
export const saveProviderRoute = { method: 'PUT', path: '/api/workspace/sign-in/:provider' } as const satisfies ApiRoute;

export const ProviderTestResult = z.object({ ok: z.boolean(), detail: z.string() });
export type ProviderTestResult = z.infer<typeof ProviderTestResult>;
export const testProviderRoute = { method: 'POST', path: '/api/workspace/sign-in/:provider/test' } as const satisfies ApiRoute;

export const SavePasswordPolicyRequest = PasswordPolicy.pick({
  enabled: true,
  requireVerification: true,
  allowSelfSignup: true,
}).strict();
export type SavePasswordPolicyRequest = z.infer<typeof SavePasswordPolicyRequest>;
export const savePasswordPolicyRoute = { method: 'PUT', path: '/api/workspace/sign-in/password' } as const satisfies ApiRoute;

export const Member = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: WorkspaceRole,
  tags: z.array(z.string()),
});
export type Member = z.infer<typeof Member>;
export const Members = z.array(Member);
export const membersRoute = { method: 'GET', path: '/api/workspace/members' } as const satisfies ApiRoute;

export const RoleTag = z.object({ tag: z.string(), description: z.string(), teamSlug: z.string(), members: z.array(z.string()) });
export type RoleTag = z.infer<typeof RoleTag>;
export const RoleTags = z.array(RoleTag);
export const rolesRoute = { method: 'GET', path: '/api/workspace/roles' } as const satisfies ApiRoute;

// ---- teams ---------------------------------------------------------------------------------------------
export const TemplateInfo = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  channels: z.array(z.string()),
  board: z.string().nullable(),
  bots: z.array(z.object({ name: z.string(), role: z.string(), automation: z.boolean() })),
  needs: z.array(z.string()),
});
export type TemplateInfo = z.infer<typeof TemplateInfo>;
export const TemplateInfos = z.array(TemplateInfo);
export const templatesRoute = { method: 'GET', path: '/api/team-templates' } as const satisfies ApiRoute;

export const TeamSummary = z.object({
  slug: z.string(),
  name: z.string(),
  templateId: z.string().nullable(),
  memberCount: z.number(),
  myRole: TeamRole.nullable(),
});
export type TeamSummary = z.infer<typeof TeamSummary>;
export const TeamSummaries = z.array(TeamSummary);
export const teamsRoute = { method: 'GET', path: '/api/teams' } as const satisfies ApiRoute;

export const CreateTeamRequest = z
  .object({
    templateId: z.string().nullable(),
    name: z.string().min(1, 'Name the team'),
    invite: z.array(z.string()),
  })
  .strict();
export type CreateTeamRequest = z.infer<typeof CreateTeamRequest>;
export const createTeamRoute = { method: 'POST', path: '/api/teams' } as const satisfies ApiRoute;

export const TeamMember = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: TeamRole,
  tags: z.array(z.string()),
  presence: z.enum(['online', 'away', 'offline']),
});
export type TeamMember = z.infer<typeof TeamMember>;

export const TeamDetail = z.object({
  slug: z.string(),
  name: z.string(),
  templateId: z.string().nullable(),
  templateVersion: z.number().nullable(),
  appliedAt: z.string().nullable(),
  members: z.array(TeamMember),
  template: TemplateInfo.nullable(),
});
export type TeamDetail = z.infer<typeof TeamDetail>;
export const teamRoute = { method: 'GET', path: '/api/teams/:slug' } as const satisfies ApiRoute;

export const InviteToTeamRequest = z.object({ email: z.string().min(1, 'Enter an email address') }).strict();
export const inviteToTeamRoute = { method: 'POST', path: '/api/teams/:slug/invitations' } as const satisfies ApiRoute;
