import { call, isApiError } from './client';
import * as s from './schemas';

/*
 * The one place screens get data from. Each function wraps one typed route; when the shared API schemas
 * land, swap the imports in this file and nothing else changes.
 */

/** Current session, or null when nobody is signed in (a 401 here is not "session expired"). */
export async function fetchSession(): Promise<s.SessionInfo | null> {
  try {
    return await call(s.sessionRoute, { response: s.SessionInfo }, undefined, undefined, { noSessionExpiry: true });
  } catch (e) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

export const fetchSignInOptions = () => call(s.signInOptionsRoute, { response: s.SignInOptions }, undefined, undefined, { noSessionExpiry: true });

export const signInWithPassword = (body: s.PasswordSignInRequest) =>
  call(s.passwordSignInRoute, { request: s.PasswordSignInRequest, response: s.SessionInfo }, body, undefined, { noSessionExpiry: true });

export const requestPasswordReset = (email: string) =>
  call(s.forgotPasswordRoute, { request: s.ForgotPasswordRequest, response: s.NoContent }, { email }, undefined, { noSessionExpiry: true });

export const signOut = () => call(s.signOutRoute, { response: s.NoContent }, undefined, undefined, { noSessionExpiry: true });
export const signOutEverywhere = () => call(s.signOutEverywhereRoute, { response: s.NoContent }, undefined, undefined, { noSessionExpiry: true });

export const checkBootstrapToken = (token: string) =>
  call(s.bootstrapInfoRoute, { response: s.BootstrapInfo }, undefined, { token }, { noSessionExpiry: true });
export const bootstrapWorkspace = (token: string, body: s.BootstrapRequest) =>
  call(s.bootstrapRoute, { request: s.BootstrapRequest, response: s.SessionInfo }, body, { token }, { noSessionExpiry: true });

export const fetchInvitation = (token: string) =>
  call(s.invitationInfoRoute, { response: s.InvitationInfo }, undefined, { token }, { noSessionExpiry: true });
export const acceptInvitation = (token: string, body: s.AcceptInvitationRequest) =>
  call(s.acceptInvitationRoute, { request: s.AcceptInvitationRequest, response: s.SessionInfo }, body, { token }, { noSessionExpiry: true });

export const fetchAccountSessions = () => call(s.accountSessionsRoute, { response: s.AccountSessions });
export const revokeAccountSession = (id: string) => call(s.revokeSessionRoute, { response: s.NoContent }, undefined, { id });
export const fetchLinkedMethods = () => call(s.linkedMethodsRoute, { response: s.LinkedMethods });
export const renameAccount = (name: string) =>
  call(s.renameAccountRoute, { request: s.RenameAccountRequest, response: s.SessionInfo }, { name });
export const changePassword = (body: s.ChangePasswordRequest) =>
  call(s.changePasswordRoute, { request: s.ChangePasswordRequest, response: s.NoContent }, body);

export const fetchWorkspace = () => call(s.workspaceRoute, { response: s.WorkspaceInfo });
export const renameWorkspace = (name: string) =>
  call(s.renameWorkspaceRoute, { request: s.RenameWorkspaceRequest, response: s.WorkspaceInfo }, { name });
export const fetchSignInSettings = () => call(s.signInSettingsRoute, { response: s.SignInSettings });
export const saveProvider = (provider: s.ProviderKind, body: s.SaveProviderRequest) =>
  call(s.saveProviderRoute, { request: s.SaveProviderRequest, response: s.ProviderConfig }, body, { provider });
export const testProvider = (provider: s.ProviderKind) =>
  call(s.testProviderRoute, { response: s.ProviderTestResult }, undefined, { provider });
export const savePasswordPolicy = (body: s.SavePasswordPolicyRequest) =>
  call(s.savePasswordPolicyRoute, { request: s.SavePasswordPolicyRequest, response: s.PasswordPolicy }, body);
export const fetchMembers = () => call(s.membersRoute, { response: s.Members });
export const fetchRoles = () => call(s.rolesRoute, { response: s.RoleTags });

export const fetchTemplates = () => call(s.templatesRoute, { response: s.TemplateInfos });
export const fetchTeams = () => call(s.teamsRoute, { response: s.TeamSummaries });
export const createTeam = (body: s.CreateTeamRequest) =>
  call(s.createTeamRoute, { request: s.CreateTeamRequest, response: s.TeamSummary }, body);
export const fetchTeam = (slug: string) => call(s.teamRoute, { response: s.TeamDetail }, undefined, { slug });
export const inviteToTeam = (slug: string, email: string) =>
  call(s.inviteToTeamRoute, { request: s.InviteToTeamRequest, response: s.NoContent }, { email }, { slug });
