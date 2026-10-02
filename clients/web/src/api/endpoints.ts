import {
  AcceptInvitationRequest,
  AcceptInvitationResponse,
  AddTeamMemberRequest,
  AddTeamMemberResponse,
  ApplyTeamTemplateRequest,
  ApplyTeamTemplateResponse,
  ArchiveTeamResponse,
  AssignTeamTagResponse,
  BootstrapWorkspaceRequest,
  BootstrapWorkspaceResponse,
  ChangePasswordRequest,
  ChangePasswordResponse,
  CheckBootstrapResponse,
  CreateInvitationRequest,
  CreateInvitationResponse,
  CreateOidcProviderRequest,
  CreateTeamInvitationResponse,
  CreateTeamRequest,
  CreateTeamResponse,
  CreateTeamTagRequest,
  CreateTeamTagResponse,
  DeleteOidcProviderResponse,
  DeleteTeamTagResponse,
  GetInvitationResponse,
  GetSessionResponse,
  GetTeamResponse,
  GetTeamRosterResponse,
  GetWorkspaceResponse,
  InviteTeamMemberRequest,
  ListOidcMethodsResponse,
  ListOidcProvidersResponse,
  ListSessionsResponse,
  ListTeamInvitationsResponse,
  ListTeamTagsResponse,
  ListTeamsResponse,
  ListTemplatesResponse,
  ListWorkspaceMembersResponse,
  NavChannelDirectory,
  OidcProviderResponse,
  RemoveTeamMemberResponse,
  RenameTeamRequest,
  RenameTeamResponse,
  RequestEmailVerificationResponse,
  RequestPasswordResetRequest,
  RequestPasswordResetResponse,
  ResetPasswordRequest,
  ResetPasswordResponse,
  RevokeSessionResponse,
  SetTeamMemberRoleRequest,
  SetTeamMemberRoleResponse,
  SignInWithPasswordRequest,
  SignInWithPasswordResponse,
  SignOutEverywhereResponse,
  SignOutResponse,
  TestOidcProviderResponse,
  UnarchiveTeamResponse,
  UnassignTeamTagResponse,
  UpdateAccountRequest,
  UpdateAccountResponse,
  UpdateOidcProviderRequest,
  UpdateWorkspaceMemberRequest,
  UpdateWorkspaceMemberResponse,
  UpdateWorkspaceRequest,
  UpdateWorkspaceResponse,
  VerifyEmailRequest,
  VerifyEmailResponse,
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
  type AuthenticatedSession,
} from '@manythreads/shared';
import { call } from './client';

/*
 * The one place screens get data from. Every function wraps exactly one real route descriptor and its shared
 * request and response schemas (D1: no client-side copies). Public sign-in, bootstrap and invitation calls opt out of
 * "a 401 means the session expired" so a wrong password is just an error on the form.
 */

const PUBLIC = { noSessionExpiry: true } as const;

// ---- session and sign-in -------------------------------------------------------------------------------
/** Who is signed in, or the enabled sign-in methods when nobody is (the server answers 200 either way). */
export const fetchSession = (): Promise<GetSessionResponse> =>
  call(getSessionRoute, { response: GetSessionResponse }, undefined, undefined, PUBLIC);

export const signInWithPassword = (body: SignInWithPasswordRequest) =>
  call(signInWithPasswordRoute, { request: SignInWithPasswordRequest, response: SignInWithPasswordResponse }, body, undefined, PUBLIC);

export const requestPasswordReset = (email: string) =>
  call(requestPasswordResetRoute, { request: RequestPasswordResetRequest, response: RequestPasswordResetResponse }, { email }, undefined, PUBLIC);
export const resetPassword = (token: string, password: string) =>
  call(resetPasswordRoute, { request: ResetPasswordRequest, response: ResetPasswordResponse }, { token, password }, undefined, PUBLIC);
export const verifyEmail = (token: string) =>
  call(verifyEmailRoute, { request: VerifyEmailRequest, response: VerifyEmailResponse }, { token }, undefined, PUBLIC);
export const requestEmailVerification = () => call(requestEmailVerificationRoute, { response: RequestEmailVerificationResponse });

export const signOut = () => call(signOutRoute, { response: SignOutResponse }, undefined, undefined, PUBLIC);
export const signOutEverywhere = () => call(signOutEverywhereRoute, { response: SignOutEverywhereResponse }, undefined, undefined, PUBLIC);

/** Change the signed-in person's password; every other session ends. A wrong current password is a 400, not a 401. */
export const changePassword = (body: ChangePasswordRequest) =>
  call(changePasswordRoute, { request: ChangePasswordRequest, response: ChangePasswordResponse }, body);
export const updateAccount = (body: UpdateAccountRequest) =>
  call(updateAccountRoute, { request: UpdateAccountRequest, response: UpdateAccountResponse }, body);

export const fetchSessions = () => call(listSessionsRoute, { response: ListSessionsResponse });
export const revokeSession = (id: string) => call(revokeSessionRoute, { response: RevokeSessionResponse }, undefined, { id });

// ---- OIDC (public buttons and the admin provider API) --------------------------------------------------
export const fetchOidcMethods = () => call(listOidcMethodsRoute, { response: ListOidcMethodsResponse }, undefined, undefined, PUBLIC);

/** Where the browser goes to start an OIDC sign-in (a full-page navigation, not an XHR). */
export function oidcStartUrl(startUrl: string, returnPath: string): string {
  if (returnPath === '/') return startUrl;
  return `${startUrl}${startUrl.includes('?') ? '&' : '?'}returnTo=${encodeURIComponent(returnPath)}`;
}

export const fetchOidcProviders = () => call(listOidcProvidersRoute, { response: ListOidcProvidersResponse });
export const createOidcProvider = (body: CreateOidcProviderRequest) =>
  call(createOidcProviderRoute, { request: CreateOidcProviderRequest, response: OidcProviderResponse }, body);
export const updateOidcProvider = (providerId: string, body: UpdateOidcProviderRequest) =>
  call(updateOidcProviderRoute, { request: UpdateOidcProviderRequest, response: OidcProviderResponse }, body, { providerId });
export const testOidcProvider = (providerId: string) =>
  call(testOidcProviderRoute, { response: TestOidcProviderResponse }, undefined, { providerId });
export const enableOidcProvider = (providerId: string) =>
  call(enableOidcProviderRoute, { response: OidcProviderResponse }, undefined, { providerId });
export const disableOidcProvider = (providerId: string) =>
  call(disableOidcProviderRoute, { response: OidcProviderResponse }, undefined, { providerId });
export const deleteOidcProvider = (providerId: string) =>
  call(deleteOidcProviderRoute, { response: DeleteOidcProviderResponse }, undefined, { providerId });

// ---- bootstrap and invitations -------------------------------------------------------------------------
export const checkBootstrapToken = (token: string) => call(checkBootstrapRoute, { response: CheckBootstrapResponse }, undefined, { token }, PUBLIC);
export const bootstrapWorkspace = (token: string, body: BootstrapWorkspaceRequest) =>
  call(bootstrapWorkspaceRoute, { request: BootstrapWorkspaceRequest, response: BootstrapWorkspaceResponse }, body, { token }, PUBLIC);

export const fetchInvitation = (token: string) => call(getInvitationRoute, { response: GetInvitationResponse }, undefined, { token }, PUBLIC);
export const acceptInvitation = (token: string, body: AcceptInvitationRequest) =>
  call(acceptInvitationRoute, { request: AcceptInvitationRequest, response: AcceptInvitationResponse }, body, { token }, PUBLIC);

export const createWorkspaceInvitation = (body: CreateInvitationRequest) =>
  call(createInvitationRoute, { request: CreateInvitationRequest, response: CreateInvitationResponse }, body);

// ---- workspace -----------------------------------------------------------------------------------------
export const fetchWorkspaceMembers = () => call(listWorkspaceMembersRoute, { response: ListWorkspaceMembersResponse });
export const fetchWorkspace = () => call(getWorkspaceRoute, { response: GetWorkspaceResponse });
export const updateWorkspace = (body: UpdateWorkspaceRequest) =>
  call(updateWorkspaceRoute, { request: UpdateWorkspaceRequest, response: UpdateWorkspaceResponse }, body);
export const updateWorkspaceMember = (personId: string, body: UpdateWorkspaceMemberRequest) =>
  call(updateWorkspaceMemberRoute, { request: UpdateWorkspaceMemberRequest, response: UpdateWorkspaceMemberResponse }, body, { personId });

// ---- teams ---------------------------------------------------------------------------------------------
export const fetchTemplates = () => call(listTemplatesRoute, { response: ListTemplatesResponse });
export const fetchTeams = (includeArchived = false) =>
  call(listTeamsRoute, { response: ListTeamsResponse }, includeArchived ? { includeArchived: 'true' as const } : undefined);
export const fetchTeam = (slug: string) => call(getTeamRoute, { response: GetTeamResponse }, undefined, { slug });
export const createBlankTeam = (body: CreateTeamRequest) => call(createTeamRoute, { request: CreateTeamRequest, response: CreateTeamResponse }, body);
export const applyTeamTemplate = (body: ApplyTeamTemplateRequest) =>
  call(applyTeamTemplateRoute, { request: ApplyTeamTemplateRequest, response: ApplyTeamTemplateResponse }, body);
export const renameTeam = (slug: string, name: string) =>
  call(renameTeamRoute, { request: RenameTeamRequest, response: RenameTeamResponse }, { name }, { slug });
export const archiveTeam = (slug: string) => call(archiveTeamRoute, { response: ArchiveTeamResponse }, undefined, { slug });
export const unarchiveTeam = (slug: string) => call(unarchiveTeamRoute, { response: UnarchiveTeamResponse }, undefined, { slug });

export const fetchRoster = (slug: string) => call(getTeamRosterRoute, { response: GetTeamRosterResponse }, undefined, { slug });
export const addTeamMember = (slug: string, body: AddTeamMemberRequest) =>
  call(addTeamMemberRoute, { request: AddTeamMemberRequest, response: AddTeamMemberResponse }, body, { slug });
export const removeTeamMember = (slug: string, personId: string) =>
  call(removeTeamMemberRoute, { response: RemoveTeamMemberResponse }, undefined, { slug, personId });
export const setTeamMemberRole = (slug: string, personId: string, role: SetTeamMemberRoleRequest['role']) =>
  call(setTeamMemberRoleRoute, { request: SetTeamMemberRoleRequest, response: SetTeamMemberRoleResponse }, { role }, { slug, personId });

export const fetchTeamTags = (slug: string) => call(listTeamTagsRoute, { response: ListTeamTagsResponse }, undefined, { slug });
export const createTeamTag = (slug: string, name: string) =>
  call(createTeamTagRoute, { request: CreateTeamTagRequest, response: CreateTeamTagResponse }, { name }, { slug });
export const deleteTeamTag = (slug: string, tag: string) => call(deleteTeamTagRoute, { response: DeleteTeamTagResponse }, undefined, { slug, tag });
export const assignTeamTag = (slug: string, personId: string, tag: string) =>
  call(assignTeamTagRoute, { response: AssignTeamTagResponse }, undefined, { slug, personId, tag });
export const unassignTeamTag = (slug: string, personId: string, tag: string) =>
  call(unassignTeamTagRoute, { response: UnassignTeamTagResponse }, undefined, { slug, personId, tag });

export const inviteToTeam = (slug: string, email: string, teamRole: 'lead' | 'member' = 'member') =>
  call(createTeamInvitationRoute, { request: InviteTeamMemberRequest, response: CreateTeamInvitationResponse }, { email, teamRole }, { slug });
export const fetchTeamInvitations = (slug: string) =>
  call(listTeamInvitationsRoute, { response: ListTeamInvitationsResponse }, undefined, { slug });

export type { AuthenticatedSession };

// ---- sidebar ---------------------------------------------------------------------------------------------
/** The team's channel groups as the sidebar lists them. The route exists once the channels plugin is loaded; callers feature-detect. */
export const fetchNavChannels = (slug: string) => call(navChannelDirectoryRoute, { response: NavChannelDirectory }, undefined, { slug });
