import {
  ListLinksRequest,
  ListLinksResponse,
  listLinksRoute,
  GetNotificationPrefsResponse,
  GetNotificationSummaryResponse,
  ListDmsQuery,
  ListDmsResponse,
  ListNotificationsQuery,
  ListNotificationsResponse,
  MarkNotificationsReadRequest,
  MarkNotificationsReadResponse,
  OpenDmRequest,
  OpenDmResponse,
  SearchQuery,
  SearchResponse,
  UpdateNotificationPrefsRequest,
  UpdateNotificationPrefsResponse,
  getNotificationPrefsRoute,
  getNotificationSummaryRoute,
  listDmsRoute,
  listNotificationsRoute,
  markNotificationsReadRoute,
  openDmRoute,
  searchRoute,
  updateNotificationPrefsRoute,
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
  DeleteMessageResponse,
  FollowThreadResponse,
  GetThreadQuery,
  GetThreadResponse,
  ListThreadsQuery,
  ListThreadsResponse,
  TypingRequest,
  TypingResponse,
  ListChannelFilesQuery,
  ListChannelFilesResponse,
  UploadFileResponse,
  followThreadRoute,
  listChannelFilesRoute,
  getThreadRoute,
  listThreadsRoute,
  typingRoute,
  unfollowThreadRoute,
  uploadFileRoute,
  EditMessageRequest,
  EditMessageResponse,
  GetChannelResponse,
  GetMessageResponse,
  GetReadStateRequest,
  GetReadStateResponse,
  GetUnreadSummaryResponse,
  JoinChannelResponse,
  ListMessagesQuery,
  ListMessagesResponse,
  MarkReadRequest,
  MarkReadResponse,
  PostMessageRequest,
  PostMessageResponse,
  ReactRequest,
  ReactResponse,
  UnreactResponse,
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
  deleteMessageRoute,
  editMessageRoute,
  getChannelRoute,
  getMessageRoute,
  getReadStateRoute,
  getUnreadSummaryRoute,
  joinChannelRoute,
  listMessagesRoute,
  markReadRoute,
  postMessageRoute,
  reactRoute,
  unreactRoute,
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
import { CSRF_COOKIE, CSRF_HEADER, ApiError, buildPath, call, readCookie } from './client';

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

// ---- channels, messages, read state ------------------------------------------------------------------------
export const fetchChannel = (channelId: string) => call(getChannelRoute, { response: GetChannelResponse }, undefined, { channelId });
export const joinChannel = (channelId: string) => call(joinChannelRoute, { response: JoinChannelResponse }, undefined, { channelId });

/** Newest first; `before` is the id of the oldest message held (the previous page's `nextCursor`). */
export const fetchMessages = (channelId: string, query: { before?: string; limit?: number; threadRootId?: string } = {}) =>
  call(listMessagesRoute, { request: ListMessagesQuery, response: ListMessagesResponse }, { limit: 50, ...query } as ListMessagesQuery, { channelId });
export const fetchMessage = (channelId: string, messageId: string) =>
  call(getMessageRoute, { response: GetMessageResponse }, undefined, { channelId, messageId });
export const postMessage = (channelId: string, body: string, threadRootId: string | null = null, attachments: readonly string[] = []) =>
  call(
    postMessageRoute,
    { request: PostMessageRequest, response: PostMessageResponse },
    { channelId, body, threadRootId, ...(attachments.length > 0 ? { attachments } : {}) } as PostMessageRequest,
    { channelId },
  );
export const editMessage = (channelId: string, messageId: string, body: string) =>
  call(editMessageRoute, { request: EditMessageRequest, response: EditMessageResponse }, { body }, { channelId, messageId });
export const deleteMessage = (channelId: string, messageId: string) =>
  call(deleteMessageRoute, { response: DeleteMessageResponse }, undefined, { channelId, messageId });
export const addReaction = (channelId: string, messageId: string, emoji: string) =>
  call(reactRoute, { request: ReactRequest, response: ReactResponse }, { emoji }, { channelId, messageId });
export const removeReaction = (channelId: string, messageId: string, emoji: string) =>
  call(unreactRoute, { response: UnreactResponse }, undefined, { channelId, messageId, emoji });

/** `targets` is `channel:<id>,thread:<id>` (1 to 100). */
export const fetchReadStates = (targets: string) => call(getReadStateRoute, { request: GetReadStateRequest, response: GetReadStateResponse }, { targets });
export const fetchUnreadSummary = () => call(getUnreadSummaryRoute, { response: GetUnreadSummaryResponse });
export const markRead = (targetType: 'channel' | 'thread', targetId: string, upTo: string) =>
  call(markReadRoute, { request: MarkReadRequest, response: MarkReadResponse }, { targetType, targetId, upTo } as MarkReadRequest);

// ---- entity links ----------------------------------------------------------------------------------------
/** What an entity is linked to, resolved and filtered for the caller (kernel entity-link service). */
export const fetchLinks = (type: ListLinksRequest['type'], id: string) =>
  call(listLinksRoute, { request: ListLinksRequest, response: ListLinksResponse }, { type, id, direction: 'both', limit: 20 } as ListLinksRequest);

// ---- threads ---------------------------------------------------------------------------------------------
/** A thread: its root, the caller's state and a page of replies (newest first). The route belongs to the threads plugin; callers feature-detect. */
export const fetchThread = (rootId: string, query: { before?: string; limit?: number } = {}) =>
  call(getThreadRoute, { request: GetThreadQuery, response: GetThreadResponse }, { limit: 50, ...query } as GetThreadQuery, { rootId });
export const followThread = (rootId: string) => call(followThreadRoute, { response: FollowThreadResponse }, undefined, { rootId });
export const unfollowThread = (rootId: string) => call(unfollowThreadRoute, { response: FollowThreadResponse }, undefined, { rootId });
export const fetchThreadInbox = (slug: string, tab: 'followed' | 'unread' | 'mine', cursor?: string) =>
  call(listThreadsRoute, { request: ListThreadsQuery, response: ListThreadsResponse }, { tab, limit: 30, ...(cursor ? { cursor } : {}) } as ListThreadsQuery, { slug });

/** "I am typing here": best effort, repeated every few seconds while the person types. */
export const sendTyping = (channelId: string, threadRootId: string | null) =>
  call(typingRoute, { request: TypingRequest, response: TypingResponse }, { threadRootId } as TypingRequest, { channelId });

// ---- files -----------------------------------------------------------------------------------------------
/** Does this server store attachments? The files plugin answers its list route; a server without it answers 404 (the clip button then stays hidden). */
export const probeFiles = (channelId: string) =>
  call(listChannelFilesRoute, { request: ListChannelFilesQuery, response: ListChannelFilesResponse }, { limit: 1 } as ListChannelFilesQuery, { channelId });

export const fileContentUrl = (fileId: string): string => `/api/files/${encodeURIComponent(fileId)}/content`;

/**
 * Upload one file to a channel as a raw byte stream, with progress (`fetch` cannot report upload progress, so this is an XHR).
 * The result is parsed with the shared `UploadFileResponse`; a refusal comes back as the same `ApiError` as every other call.
 */
export function uploadChannelFile(
  channelId: string,
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadFileResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(uploadFileRoute.method, buildPath(uploadFileRoute.path, { channelId }));
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    const csrf = readCookie(CSRF_COOKIE, document.cookie);
    if (csrf) xhr.setRequestHeader(CSRF_HEADER, csrf);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError({ code: 'network', status: 0, message: 'Network error' }));
    xhr.onabort = () => reject(new ApiError({ code: 'network', status: 0, message: 'Cancelled' }));
    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = UploadFileResponse.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = typeof (body as { error?: { message?: unknown } } | undefined)?.error?.message === 'string' ? (body as { error: { message: string } }).error.message : `Upload failed (${xhr.status})`;
      reject(new ApiError({ code: xhr.status === 413 ? 'validation_failed' : 'internal', status: xhr.status, message }));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

// ---- search, notifications, direct messages ---------------------------------------------------------------
/** Messages, threads and files the caller can read (the server filters by what they can see; a guest only inside a grant). */
export const searchEverything = (q: string, opts: { scope?: SearchQuery['scope']; teamId?: string; limit?: number } = {}) =>
  call(searchRoute, { request: SearchQuery, response: SearchResponse }, { q, scope: opts.scope ?? 'all', limit: opts.limit ?? 20, ...(opts.teamId ? { teamId: opts.teamId } : {}) } as SearchQuery);

export const fetchNotifications = (query: { cursor?: string; limit?: number; unread?: boolean } = {}) =>
  call(
    listNotificationsRoute,
    { request: ListNotificationsQuery, response: ListNotificationsResponse },
    { limit: query.limit ?? 30, unread: query.unread ? 'true' : 'false', ...(query.cursor ? { cursor: query.cursor } : {}) } as ListNotificationsQuery,
  );
export const fetchNotificationSummary = () => call(getNotificationSummaryRoute, { response: GetNotificationSummaryResponse });
export const markNotificationsRead = (body: MarkNotificationsReadRequest) =>
  call(markNotificationsReadRoute, { request: MarkNotificationsReadRequest, response: MarkNotificationsReadResponse }, body);
export const fetchNotificationPrefs = () => call(getNotificationPrefsRoute, { response: GetNotificationPrefsResponse });
export const saveNotificationPrefs = (body: UpdateNotificationPrefsRequest) =>
  call(updateNotificationPrefsRoute, { request: UpdateNotificationPrefsRequest, response: UpdateNotificationPrefsResponse }, body);

export const fetchDms = () => call(listDmsRoute, { request: ListDmsQuery, response: ListDmsResponse }, { limit: 200 } as ListDmsQuery);
/** Open (or create) the conversation with these people; opening the same set twice gives the same channel. */
export const openDm = (personIds: readonly string[]) =>
  call(openDmRoute, { request: OpenDmRequest, response: OpenDmResponse }, { personIds } as OpenDmRequest);
