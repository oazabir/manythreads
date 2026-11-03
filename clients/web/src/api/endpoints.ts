import {
  BotUsageResponse,
  TeamUsageResponse,
  UsageQuery,
  WorkspaceUsageResponse,
  botUsageRoute,
  teamUsageRoute,
  workspaceUsageRoute,
} from '@manythreads/shared';
import {
  AddCustomEmojiRequest,
  AddCustomEmojiResponse,
  BroadcastReach,
  DeleteCustomEmojiResponse,
  DeleteDraftResponse,
  ListCustomEmojiResponse,
  ListDraftsResponse,
  SaveDraftRequest,
  SaveDraftResponse,
  addCustomEmojiRoute,
  broadcastReachRoute,
  deleteCustomEmojiRoute,
  deleteDraftRoute,
  listCustomEmojiRoute,
  listDraftsRoute,
  saveDraftRoute,
  ListMentionGroupsResponse,
  listMentionGroupsRoute,
  ListLinkPreviewsResponse,
  RemoveLinkPreviewResponse,
  listLinkPreviewsRoute,
  removeLinkPreviewRoute,
  ClosePollResponse,
  CreatePollRequest,
  CreatePollResponse,
  PollResultsResponse,
  VotePollRequest,
  VotePollResponse,
  closePollRoute,
  createPollRoute,
  pollResultsRoute,
  votePollRoute,
  withdrawVoteRoute,
  LaterItem,
  ListLaterQuery,
  ListLaterResponse,
  RemoveLaterResponse,
  SaveLaterRequest,
  UpdateLaterRequest,
  listLaterRoute,
  removeLaterRoute,
  saveLaterRoute,
  updateLaterRoute,
  ListRunnersResponse,
  listRunnersRoute,
  LaunchOnboardingRequest,
  ListLlmAliasTestsResponse,
  OnboardingStateResponse,
  SetOnboardingMarkRequest,
  TestLlmAliasResponse,
  clearOnboardingMarkRoute,
  dismissOnboardingRoute,
  getOnboardingRoute,
  launchOnboardingRoute,
  listLlmAliasTestsRoute,
  setOnboardingMarkRoute,
  testLlmAliasRoute,
  AuditSigningKey,
  CreateDlpRuleRequest,
  DeleteDlpRuleResponse,
  DlpPolicy,
  DlpRuleResponse,
  ListTeamEgressResponse,
  SetDlpDetectorRequest,
  SetTeamEgressRequest,
  SetTeamEgressResponse,
  TestDlpRequest,
  TestDlpResponse,
  UpdateDlpRuleRequest,
  createDlpRuleRoute,
  deleteDlpRuleRoute,
  getDlpPolicyRoute,
  listTeamEgressRoute,
  setDlpDetectorRoute,
  setTeamEgressRoute,
  testDlpRoute,
  updateDlpRuleRoute,
  ErrorEnvelope,
  ExportAuditRequest,
  ListAuditQuery,
  ListAuditResponse,
  AUDIT_KEY_ID_HEADER,
  AUDIT_SIGNATURE_HEADER,
  exportAuditRoute,
  getAuditSigningKeyRoute,
  listAuditRoute,
  DeleteSavedSearchResponse,
  ListSavedSearchesResponse,
  SaveSearchRequest,
  SaveSearchResponse,
  deleteSavedSearchRoute,
  listSavedSearchesRoute,
  saveSearchRoute,
  HeartbeatRequest,
  HeartbeatResponse,
  ListPresenceCardsResponse,
  MyPresence,
  UpdateDndRequest,
  UpdateMyPresenceRequest,
  getMyPresenceRoute,
  heartbeatRoute,
  listPresenceCardsRoute,
  updateDndRoute,
  updateMyPresenceRoute,
  ListLinksRequest,
  ListLinksResponse,
  listLinksRoute,
  GetDigestSettingsResponse,
  GetNotificationKeywordsResponse,
  GetNotificationLevelsResponse,
  GetNotificationPrefsResponse,
  GetPushStateResponse,
  PutDigestSettingsRequest,
  PutDigestSettingsResponse,
  getDigestSettingsRoute,
  putDigestSettingsRoute,
  PutChannelLevelRequest,
  PutChannelLevelResponse,
  PutNotificationKeywordsRequest,
  PutNotificationKeywordsResponse,
  PutWorkspaceLevelRequest,
  PutWorkspaceLevelResponse,
  SubscribePushRequest,
  SubscribePushResponse,
  UnsubscribePushRequest,
  UnsubscribePushResponse,
  getNotificationKeywordsRoute,
  getNotificationLevelsRoute,
  getPushStateRoute,
  putChannelLevelRoute,
  putNotificationKeywordsRoute,
  putWorkspaceLevelRoute,
  subscribePushRoute,
  unsubscribePushRoute,
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
  DeleteFileResponse,
  GetFileResponse,
  deleteFileRoute,
  getFileRoute,
  followThreadRoute,
  listChannelFilesRoute,
  getThreadRoute,
  listThreadsRoute,
  typingRoute,
  unfollowThreadRoute,
  uploadFileRoute,
  AddBookmarkRequest,
  AddBookmarkResponse,
  CancelScheduledResponse,
  ClearMessageVersionsResponse,
  EditScheduledRequest,
  EditScheduledResponse,
  ListScheduledResponse,
  ScheduleMessageRequest,
  ScheduleMessageResponse,
  cancelScheduledRoute,
  editScheduledRoute,
  listAllScheduledRoute,
  listScheduledRoute,
  scheduleMessageRoute,
  ListBookmarksResponse,
  MarkMessageUnreadResponse,
  RemoveBookmarkResponse,
  addBookmarkRoute,
  listBookmarksRoute,
  markMessageUnreadRoute,
  removeBookmarkRoute,
  EditMessageRequest,
  ForwardMessageRequest,
  ForwardMessageResponse,
  ListMessageVersionsResponse,
  EditMessageResponse,
  GetChannelResponse,
  GetMessageResponse,
  GetReadStateRequest,
  GetReadStateResponse,
  GetUnreadSummaryResponse,
  JoinChannelResponse,
  CreateChannelRequest,
  CreateChannelResponse,
  createChannelRoute,
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
  GetWorkspaceHttpsResponse,
  OpsHealthResponse,
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
  clearMessageVersionsRoute,
  deleteMessageRoute,
  editMessageRoute,
  forwardMessageRoute,
  listMessageVersionsRoute,
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
  getFilesTreeRoute,
  GetFilesTreeQuery,
  GetFilesTreeResponse,
  getOpsHealthRoute,
  getWorkspaceHttpsRoute,
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
  GetSidebarPrefsResponse,
  PutSidebarPrefsRequest,
  PutSidebarPrefsResponse,
  getSidebarPrefsRoute,
  putSidebarPrefsRoute,
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
  CreateLlmProviderRequest,
  DeleteLlmAliasResponse,
  DeleteLlmLimitResponse,
  DeleteLlmProviderResponse,
  ListLlmAliasesResponse,
  ListLlmLimitsResponse,
  ListLlmProvidersResponse,
  LlmAliasPathParams,
  LlmAliasResponse,
  LlmLimitPathParams,
  LlmLimitResponse,
  LlmProviderPathParams,
  LlmProviderResponse,
  LlmSettingsResponse,
  LlmSpendQuery,
  LlmSpendResponse,
  SetLlmAliasRequest,
  SetLlmLimitRequest,
  SetLlmSettingsRequest,
  UpdateLlmProviderRequest,
  createLlmProviderRoute,
  deleteLlmAliasRoute,
  deleteLlmLimitRoute,
  deleteLlmProviderRoute,
  getLlmSettingsRoute,
  listLlmAliasesRoute,
  listLlmLimitsRoute,
  listLlmProvidersRoute,
  listLlmSpendRoute,
  setLlmAliasRoute,
  setLlmLimitRoute,
  setLlmSettingsRoute,
  updateLlmProviderRoute,
  type AuthenticatedSession,
} from '@manythreads/shared';
import {
  ClearSigningResponse,
  CreateWebhookRequest,
  ListWebhooksResponse,
  RevokeWebhookResponse,
  SigningSecretResponse,
  ApiTokenWithSecret,
  ListApiTokensResponse,
  RevokeApiTokenResponse,
  TestApiTokenResponse,
  CreateApiTokenRequest,
  createApiTokenRoute,
  listApiTokensRoute,
  revokeApiTokenRoute,
  rotateApiTokenRoute,
  testApiTokenRoute,
  ListOutgoingHooksResponse,
  CreateOutgoingHookRequest,
  UpdateOutgoingHookRequest,
  OutgoingHook,
  RevokeOutgoingHookResponse,
  OutgoingSigningResponse,
  ClearOutgoingSigningResponse,
  TestOutgoingHookResponse,
  listOutgoingHooksRoute,
  createOutgoingHookRoute,
  updateOutgoingHookRoute,
  revokeOutgoingHookRoute,
  setOutgoingSigningRoute,
  clearOutgoingSigningRoute,
  testOutgoingHookRoute,
  TestWebhookResponse,
  WebhookWithUrl,
  clearWebhookSigningRoute,
  createWebhookRoute,
  listWebhooksRoute,
  revokeWebhookRoute,
  rotateWebhookRoute,
  setWebhookSigningRoute,
  testWebhookRoute,
} from '@manythreads/shared';
import {
  AddChannelMemberRequest,
  AddChannelMemberResponse,
  CancelReminderResponse,
  CreateReminderRequest,
  LeaveChannelResponse,
  ListRemindersQuery,
  ListRemindersResponse,
  Reminder,
  UpdateChannelRequest,
  UpdateChannelResponse,
  addChannelMemberRoute,
  cancelReminderRoute,
  createReminderRoute,
  leaveChannelRoute,
  listRemindersRoute,
  updateChannelRoute,
  ImportRun,
  ListImportsResponse,
  cancelImportRoute,
  deleteImportRoute,
  dryRunImportRoute,
  getImportRoute,
  listImportsRoute,
  startImportRoute,
  uploadImportRoute,
  DeleteImportResponse,
  type ImportSource,
} from '@manythreads/shared';
import {
  GetSurfaceResponse,
  PostSurfaceDataRequest,
  PostSurfaceEventRequest,
  PostSurfaceEventResponse,
  SurfaceDataResponse,
  getSurfaceRoute,
  postSurfaceDataRoute,
  postSurfaceEventRoute,
} from '@manythreads/shared';
import { CSRF_HEADER, ApiError, buildPath, call, readCsrfCookie } from './client';

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
export const fetchWorkspaceHttps = () => call(getWorkspaceHttpsRoute, { response: GetWorkspaceHttpsResponse });
export const fetchOpsHealth = () => call(getOpsHealthRoute, { response: OpsHealthResponse });

// ---- audit console (workspace admins) ---------------------------------------------------------------------
export const fetchAudit = (query: Partial<ListAuditQuery>) => call(listAuditRoute, { request: ListAuditQuery, response: ListAuditResponse }, ListAuditQuery.parse(query));
export const fetchAuditSigningKey = () => call(getAuditSigningKeyRoute, { response: AuditSigningKey });

/** A downloaded audit export: the file's text, the signature that goes with it (base64) and the key that signed it. */
export interface AuditExportFile {
  text: string;
  signature: string;
  keyId: string;
}

/**
 * The signed export. The answer is a file, not JSON, so this is the one audit call that does not go through `call`: it sends the same request
 * (cookie, CSRF header), reads the body as text and takes the signature from the response headers.
 */
export async function exportAudit(body: ExportAuditRequest): Promise<AuditExportFile> {
  const parsed = ExportAuditRequest.parse(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/x-ndjson' };
  const csrf = readCsrfCookie(document.cookie);
  if (csrf) headers[CSRF_HEADER] = csrf;
  let res: Response;
  try {
    res = await fetch(exportAuditRoute.path, { method: exportAuditRoute.method, headers, credentials: 'include', body: JSON.stringify(parsed) });
  } catch (e) {
    throw new ApiError({ code: 'network', status: 0, message: e instanceof Error ? e.message : 'Network error' });
  }
  const text = await res.text();
  if (!res.ok) {
    let env: ReturnType<typeof ErrorEnvelope.safeParse> | null = null;
    try {
      env = ErrorEnvelope.safeParse(JSON.parse(text));
    } catch {
      env = null;
    }
    throw new ApiError(
      env?.success ? { code: env.data.error.code, message: env.data.error.message, status: res.status } : { code: 'internal', message: `Request failed (${res.status})`, status: res.status },
    );
  }
  return { text, signature: res.headers.get(AUDIT_SIGNATURE_HEADER) ?? '', keyId: res.headers.get(AUDIT_KEY_ID_HEADER) ?? '' };
}
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

/** The files directly under a team's `pages/` folder (the quick switcher's page list); a team without pages answers an empty list. */
export const fetchPageEntries = (slug: string) =>
  call(getFilesTreeRoute, { request: GetFilesTreeQuery, response: GetFilesTreeResponse }, GetFilesTreeQuery.parse({ path: 'pages' }), { slug });
export const fetchRoster = (slug: string) => call(getTeamRosterRoute, { response: GetTeamRosterResponse }, undefined, { slug });
export const addTeamMember = (slug: string, body: AddTeamMemberRequest) =>
  call(addTeamMemberRoute, { request: AddTeamMemberRequest, response: AddTeamMemberResponse }, body, { slug });
export const removeTeamMember = (slug: string, personId: string) =>
  call(removeTeamMemberRoute, { response: RemoveTeamMemberResponse }, undefined, { slug, personId });
export const setTeamMemberRole = (slug: string, personId: string, role: SetTeamMemberRoleRequest['role']) =>
  call(setTeamMemberRoleRoute, { request: SetTeamMemberRoleRequest, response: SetTeamMemberRoleResponse }, { role }, { slug, personId });

/** The role groups the `@` picker offers in a conversation, each with how many people a mention reaches there (P14-03). */
export const fetchMentionGroups = (channelId: string) => call(listMentionGroupsRoute, { response: ListMentionGroupsResponse }, undefined, { channelId });
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
/** The person's own sidebar view for a team (stars, sort, hide idle, group order); a server without it answers 404. */
export const fetchSidebarPrefs = (slug: string) => call(getSidebarPrefsRoute, { response: GetSidebarPrefsResponse }, undefined, { slug });
/** Changes some of the fields of that view; the ones left out stay. The answer is the saved view. */
export const saveSidebarPrefs = (slug: string, body: PutSidebarPrefsRequest) =>
  call(putSidebarPrefsRoute, { request: PutSidebarPrefsRequest, response: PutSidebarPrefsResponse }, body, { slug });

// ---- channels, messages, read state ------------------------------------------------------------------------
export const fetchChannel = (channelId: string) => call(getChannelRoute, { response: GetChannelResponse }, undefined, { channelId });
/** Creates a channel in a team (team lead or workspace admin). The name may carry a leading `#`; `purpose` is the topic line. */
export const createChannel = (slug: string, body: CreateChannelRequest) =>
  call(createChannelRoute, { request: CreateChannelRequest, response: CreateChannelResponse }, body, { slug });
export const joinChannel = (channelId: string) => call(joinChannelRoute, { response: JoinChannelResponse }, undefined, { channelId });
export const leaveChannel = (channelId: string) => call(leaveChannelRoute, { response: LeaveChannelResponse }, undefined, { channelId });
/** Adds a person to a channel (a team lead or a workspace admin; the person must be on the channel's team). */
export const addChannelMember = (channelId: string, personId: string) =>
  call(addChannelMemberRoute, { request: AddChannelMemberRequest, response: AddChannelMemberResponse }, { personId }, { channelId });
/** Changes a channel's topic (its purpose line); an empty string clears it. */
export const saveChannelTopic = (channelId: string, purpose: string) =>
  call(updateChannelRoute, { request: UpdateChannelRequest, response: UpdateChannelResponse }, { purpose }, { channelId });

// ---- /remind (P14-04): the reminders a person asked for with the command ------------------------------------
export const fetchReminders = (state: 'pending' | 'history') => call(listRemindersRoute, { request: ListRemindersQuery, response: ListRemindersResponse }, { state });
export const createReminder = (body: CreateReminderRequest) => call(createReminderRoute, { request: CreateReminderRequest, response: Reminder }, body);
export const cancelReminder = (reminderId: string) => call(cancelReminderRoute, { response: CancelReminderResponse }, undefined, { reminderId });

/** Newest first; `before` is the id of the oldest message held (the previous page's `nextCursor`). */
export const fetchMessages = (channelId: string, query: { before?: string; limit?: number; threadRootId?: string } = {}) =>
  call(listMessagesRoute, { request: ListMessagesQuery, response: ListMessagesResponse }, { limit: 50, ...query } as ListMessagesQuery, { channelId });
export const fetchMessage = (channelId: string, messageId: string) =>
  call(getMessageRoute, { response: GetMessageResponse }, undefined, { channelId, messageId });
export const postMessage = (
  channelId: string,
  body: string,
  threadRootId: string | null = null,
  attachments: readonly string[] = [],
  alsoToChannel = false,
  confirmBroadcast = false,
) =>
  call(
    postMessageRoute,
    { request: PostMessageRequest, response: PostMessageResponse },
    {
      channelId,
      body,
      threadRootId,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(alsoToChannel && threadRootId ? { alsoToChannel: true } : {}),
      ...(confirmBroadcast ? { confirmBroadcast: true } : {}),
    } as PostMessageRequest,
    { channelId },
  );
export const editMessage = (channelId: string, messageId: string, body: string, confirmBroadcast = false) =>
  call(editMessageRoute, { request: EditMessageRequest, response: EditMessageResponse }, { body, ...(confirmBroadcast ? { confirmBroadcast: true } : {}) }, { channelId, messageId });
/** How many people `@channel` and `@here` would notify in this channel for the caller, and the size above which the writer confirms (P14-02). */
export const fetchBroadcastReach = (channelId: string) => call(broadcastReachRoute, { response: BroadcastReach }, undefined, { channelId });
// ---- custom emoji (P14-02) -------------------------------------------------------------------------------------
export const fetchCustomEmoji = () => call(listCustomEmojiRoute, { response: ListCustomEmojiResponse });
export const addCustomEmoji = (body: AddCustomEmojiRequest) => call(addCustomEmojiRoute, { request: AddCustomEmojiRequest, response: AddCustomEmojiResponse }, body);
export const deleteCustomEmoji = (emojiId: string) => call(deleteCustomEmojiRoute, { response: DeleteCustomEmojiResponse }, undefined, { emojiId });
/** Where the picture of a custom emoji is served (the browser sends its sign-in cookie with the image request). */
export const customEmojiImageUrl = (emojiId: string): string => `/api/custom-emoji/${encodeURIComponent(emojiId)}/image`;
// ---- drafts kept on the server (P14-02) --------------------------------------------------------------------
export const fetchDrafts = (channelId: string) => call(listDraftsRoute, { response: ListDraftsResponse }, undefined, { channelId });
export const saveDraft = (channelId: string, body: SaveDraftRequest) => call(saveDraftRoute, { request: SaveDraftRequest, response: SaveDraftResponse }, body, { channelId });
// a DELETE carries no body, so the box's thread goes in the address
export const deleteDraft = (channelId: string, threadRootId: string | null) =>
  call({ ...deleteDraftRoute, path: threadRootId ? `${deleteDraftRoute.path}?threadRootId=${encodeURIComponent(threadRootId)}` : deleteDraftRoute.path }, { response: DeleteDraftResponse }, undefined, { channelId });
/** The earlier texts of an edited message, oldest first (the current text is not among them). */
export const fetchMessageVersions = (channelId: string, messageId: string) =>
  call(listMessageVersionsRoute, { response: ListMessageVersionsResponse }, undefined, { channelId, messageId });
/** The author removes the earlier texts of their own message. */
export const clearMessageVersions = (channelId: string, messageId: string) =>
  call(clearMessageVersionsRoute, { response: ClearMessageVersionsResponse }, undefined, { channelId, messageId });
/** Post a message of your own into another channel or direct message, holding a card that points at this one. */
export const forwardMessage = (channelId: string, messageId: string, targetChannelId: string, note: string) =>
  call(
    forwardMessageRoute,
    { request: ForwardMessageRequest, response: ForwardMessageResponse },
    { targetChannelId, ...(note.trim() === '' ? {} : { note }) } as ForwardMessageRequest,
    { channelId, messageId },
  );
/** Polls (P14-07): ask one as a message, vote or change the vote, withdraw it, close it early, read the results. */
export const createPoll = (channelId: string, body: CreatePollRequest) =>
  call(createPollRoute, { request: CreatePollRequest, response: CreatePollResponse }, body, { channelId });
export const votePoll = (channelId: string, pollId: string, options: number[]) =>
  call(votePollRoute, { request: VotePollRequest, response: VotePollResponse }, { options }, { channelId, pollId });
export const withdrawVote = (channelId: string, pollId: string) =>
  call(withdrawVoteRoute, { response: VotePollResponse }, undefined, { channelId, pollId });
export const closePoll = (channelId: string, pollId: string) =>
  call(closePollRoute, { response: ClosePollResponse }, undefined, { channelId, pollId });
export const fetchPollResults = (channelId: string, pollId: string) =>
  call(pollResultsRoute, { response: PollResultsResponse }, undefined, { channelId, pollId });
/** "Mark unread from here": the caller's read position goes back to just before this message. */
export const markMessageUnread = (channelId: string, messageId: string) =>
  call(markMessageUnreadRoute, { response: MarkMessageUnreadResponse }, undefined, { channelId, messageId });
/** The bookmarks bar of a channel. */
export const fetchBookmarks = (channelId: string) => call(listBookmarksRoute, { response: ListBookmarksResponse }, undefined, { channelId });
export const addBookmark = (channelId: string, body: AddBookmarkRequest) =>
  call(addBookmarkRoute, { request: AddBookmarkRequest, response: AddBookmarkResponse }, body, { channelId });
export const removeBookmark = (channelId: string, bookmarkId: string) =>
  call(removeBookmarkRoute, { response: RemoveBookmarkResponse }, undefined, { channelId, bookmarkId });
/** Scheduled send (P14-05): the caller's own scheduled and refused messages in a channel, and the writes on them. */
export const fetchScheduled = (channelId: string) => call(listScheduledRoute, { response: ListScheduledResponse }, undefined, { channelId });
/** Every scheduled and refused message of the caller, in any channel: the "Not sent" list, which needs no open channel. */
export const fetchAllScheduled = () => call(listAllScheduledRoute, { response: ListScheduledResponse });
export const scheduleMessage = (channelId: string, body: ScheduleMessageRequest) =>
  call(scheduleMessageRoute, { request: ScheduleMessageRequest, response: ScheduleMessageResponse }, body, { channelId });
export const editScheduled = (channelId: string, scheduledId: string, body: EditScheduledRequest) =>
  call(editScheduledRoute, { request: EditScheduledRequest, response: EditScheduledResponse }, body, { channelId, scheduledId });
export const cancelScheduled = (channelId: string, scheduledId: string) =>
  call(cancelScheduledRoute, { response: CancelScheduledResponse }, undefined, { channelId, scheduledId });
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

// ---- later and reminders (P14-04) ----------------------------------------------------------------------
export const fetchLater = (state: 'open' | 'done') => call(listLaterRoute, { request: ListLaterQuery, response: ListLaterResponse }, { state });
/** Save a message for later; `remindAt` (an ISO time) sets a reminder, `null` clears one, leaving it out keeps what is there. */
export const saveLater = (messageId: string, remindAt?: string | null) =>
  call(saveLaterRoute, { request: SaveLaterRequest, response: LaterItem }, remindAt === undefined ? {} : { remindAt }, { messageId });
export const setLaterState = (itemId: string, state: 'open' | 'done') =>
  call(updateLaterRoute, { request: UpdateLaterRequest, response: LaterItem }, { state }, { itemId });
export const removeLater = (itemId: string) => call(removeLaterRoute, { response: RemoveLaterResponse }, undefined, { itemId });

/** "I am typing here": best effort, repeated every few seconds while the person types. */
export const sendTyping = (channelId: string, threadRootId: string | null) =>
  call(typingRoute, { request: TypingRequest, response: TypingResponse }, { threadRootId } as TypingRequest, { channelId });

// ---- files -----------------------------------------------------------------------------------------------
/** Does this server store attachments? The files plugin answers its list route; a server without it answers 404 (the clip button then stays hidden). */
export const probeFiles = (channelId: string) =>
  call(listChannelFilesRoute, { request: ListChannelFilesQuery, response: ListChannelFilesResponse }, { limit: 1 } as ListChannelFilesQuery, { channelId });

/** The newest files of a channel (the bookmarks bar offers them to pin). */
export const fetchChannelFiles = (channelId: string) =>
  call(listChannelFilesRoute, { request: ListChannelFilesQuery, response: ListChannelFilesResponse }, { limit: 100 } as ListChannelFilesQuery, { channelId });

/** The uploader, or a lead of the channel's team, removes an attachment (the row and its bytes). */
export const deleteAttachment = (fileId: string) => call(deleteFileRoute, { response: DeleteFileResponse }, undefined, { fileId });

export const fetchFileMeta = (fileId: string) => call(getFileRoute, { response: GetFileResponse }, undefined, { fileId });

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
    const csrf = readCsrfCookie(document.cookie);
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
/** Messages, threads, files and pages the caller can read (the server filters by what they can see; a guest only inside a grant). `q` may hold filter words (`from:` `in:` `has:` `is:` `before:` `after:`). */
export const searchEverything = (q: string, opts: { scope?: SearchQuery['scope']; teamId?: string; limit?: number } = {}) =>
  call(searchRoute, { request: SearchQuery, response: SearchResponse }, { q, scope: opts.scope ?? 'all', limit: opts.limit ?? 20, ...(opts.teamId ? { teamId: opts.teamId } : {}) } as SearchQuery);

/** The person's own saved searches (a name and the text of the search box). */
export const fetchSavedSearches = () => call(listSavedSearchesRoute, { response: ListSavedSearchesResponse });
export const saveSearch = (body: SaveSearchRequest) => call(saveSearchRoute, { request: SaveSearchRequest, response: SaveSearchResponse }, body);
export const deleteSavedSearch = (savedSearchId: string) => call(deleteSavedSearchRoute, { response: DeleteSavedSearchResponse }, undefined, { savedSearchId });

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

type SetOnboardingStep = 'signin' | 'code' | 'infrastructure' | 'servers';

// ---- Workspace → LLM (PLAN P5-06 and P5-07, SPEC §10.1) ---------------------------------------------------
/*
 * The admin page's data. Every route is admin-only, so a member who reaches this code gets 404 (the workspace-settings
 * convention) rather than a 403 — the AdminOnly route guard means they never do. A provider's key goes in once and is
 * never read back: `hasSecret` is all the page can show.
 */

export const fetchLlmProviders = () => call(listLlmProvidersRoute, { response: ListLlmProvidersResponse });
export const createLlmProvider = (body: CreateLlmProviderRequest) =>
  call(createLlmProviderRoute, { request: CreateLlmProviderRequest, response: LlmProviderResponse }, body);
export const updateLlmProvider = (providerId: string, body: UpdateLlmProviderRequest) =>
  call(updateLlmProviderRoute, { request: UpdateLlmProviderRequest, response: LlmProviderResponse }, body, { providerId });
export const deleteLlmProvider = (providerId: string) =>
  call(deleteLlmProviderRoute, { response: DeleteLlmProviderResponse }, undefined, { providerId });

export const fetchLlmAliases = () => call(listLlmAliasesRoute, { response: ListLlmAliasesResponse });
/** Bind an alias to a model; a second call for the same alias changes the binding rather than adding one. */
export const setLlmAlias = (alias: string, body: SetLlmAliasRequest) =>
  call(setLlmAliasRoute, { request: SetLlmAliasRequest, response: LlmAliasResponse }, body, { alias });
export const deleteLlmAlias = (alias: string) => call(deleteLlmAliasRoute, { response: DeleteLlmAliasResponse }, undefined, { alias });

/** The newest test call of each alias, with whether it still counts (the alias or its provider changed since = not current). */
export const fetchLlmAliasTests = () => call(listLlmAliasTestsRoute, { response: ListLlmAliasTestsResponse });
/** Send one small real question through an alias and get the plain-language result back (a failed test is a 200 with a cause). */
export const testLlmAlias = (alias: string) => call(testLlmAliasRoute, { response: TestLlmAliasResponse }, undefined, { alias });

// ---- Workspace → Setup (PLAN P10-01) ---------------------------------------------------------------------
/** The first admin's checklist state: what was set aside, whether the first goal was sent, whether it was put away. Admins only. */
export const fetchOnboarding = () => call(getOnboardingRoute, { response: OnboardingStateResponse });
export const setOnboardingMark = (step: SetOnboardingStep, kind: SetOnboardingMarkRequest['kind']) =>
  call(setOnboardingMarkRoute, { request: SetOnboardingMarkRequest, response: OnboardingStateResponse }, { kind }, { step });
export const clearOnboardingMark = (step: SetOnboardingStep) => call(clearOnboardingMarkRoute, { response: OnboardingStateResponse }, undefined, { step });
export const launchOnboarding = (body: LaunchOnboardingRequest) =>
  call(launchOnboardingRoute, { request: LaunchOnboardingRequest, response: OnboardingStateResponse }, body);
/** The runners (programs on the team's own servers) registered for a team: the setup checklist only needs to know whether there is one. */
export const fetchRunners = (slug: string) => call(listRunnersRoute, { response: ListRunnersResponse }, undefined, { slug });
export const dismissOnboarding = () => call(dismissOnboardingRoute, { response: OnboardingStateResponse });

export const fetchLlmLimits = () => call(listLlmLimitsRoute, { response: ListLlmLimitsResponse });
/** Set the limit of one target: the row is upserted on (scope, target), so this changes an existing limit rather than adding one. */
export const setLlmLimit = (body: SetLlmLimitRequest) =>
  call(setLlmLimitRoute, { request: SetLlmLimitRequest, response: LlmLimitResponse }, body);
export const deleteLlmLimit = (limitId: string) => call(deleteLlmLimitRoute, { response: DeleteLlmLimitResponse }, undefined, { limitId });

export const fetchLlmSettings = () => call(getLlmSettingsRoute, { response: LlmSettingsResponse });
export const saveLlmSettings = (body: SetLlmSettingsRequest) =>
  call(setLlmSettingsRoute, { request: SetLlmSettingsRequest, response: LlmSettingsResponse }, body);

/** What the workspace spent, rolled up; the default range is the current month (the window a monthly budget uses). */
export const fetchLlmSpend = (query: LlmSpendQuery = {}) =>
  call(listLlmSpendRoute, { request: LlmSpendQuery, response: LlmSpendResponse }, query as LlmSpendQuery);

export type { LlmSpendQuery, LlmProviderPathParams, LlmAliasPathParams, LlmLimitPathParams };

// ---- presence and status (PLAN P14-01) --------------------------------------------------------------------
/** "I am here" (`online`) or "I am here but idle" (`away`); sent every 30 seconds while the app is open. */
export const sendHeartbeat = (status: 'online' | 'away') => call(heartbeatRoute, { request: HeartbeatRequest, response: HeartbeatResponse }, { status });
/** Who is online or away, and the status, time zone, hours and out-of-office note of everyone the caller may see. */
export const fetchPresenceCards = () => call(listPresenceCardsRoute, { response: ListPresenceCardsResponse });
export const fetchMyPresence = () => call(getMyPresenceRoute, { response: MyPresence });
export const saveMyPresence = (body: UpdateMyPresenceRequest) => call(updateMyPresenceRoute, { request: UpdateMyPresenceRequest, response: MyPresence }, body);
export const saveDnd = (body: UpdateDndRequest) => call(updateDndRoute, { request: UpdateDndRequest, response: MyPresence }, body);

// ---- notification levels, keywords and browser push (PLAN P14-09) ---------------------------------------------
/** The caller's email digest settings (on or off, how long away, whether this server can send mail at all). */
export const fetchDigestSettings = () => call(getDigestSettingsRoute, { response: GetDigestSettingsResponse });

/** Saves the digest on or off and the delay; answers the settings as they are now. */
export const saveDigestSettings = (body: PutDigestSettingsRequest) =>
  call(putDigestSettingsRoute, { request: PutDigestSettingsRequest, response: PutDigestSettingsResponse }, body);

/** The person's own level per channel and the workspace default. */
export const fetchNotificationLevels = () => call(getNotificationLevelsRoute, { response: GetNotificationLevelsResponse });
/** Sets this channel's level for the caller; `null` takes the choice away so the channel follows the default again. */
export const saveChannelLevel = (channelId: string, level: PutChannelLevelRequest['level']) =>
  call(putChannelLevelRoute, { request: PutChannelLevelRequest, response: PutChannelLevelResponse }, { level }, { channelId });
/** A workspace admin sets the level team channels start with. */
export const saveWorkspaceLevel = (body: PutWorkspaceLevelRequest) =>
  call(putWorkspaceLevelRoute, { request: PutWorkspaceLevelRequest, response: PutWorkspaceLevelResponse }, body);
export const fetchNotificationKeywords = () => call(getNotificationKeywordsRoute, { response: GetNotificationKeywordsResponse });
export const saveNotificationKeywords = (keywords: string[]) =>
  call(putNotificationKeywordsRoute, { request: PutNotificationKeywordsRequest, response: PutNotificationKeywordsResponse }, { keywords });
export const fetchPushState = () => call(getPushStateRoute, { response: GetPushStateResponse });
export const subscribePush = (body: SubscribePushRequest) => call(subscribePushRoute, { request: SubscribePushRequest, response: SubscribePushResponse }, body);
export const unsubscribePush = (endpoint: string) =>
  call(unsubscribePushRoute, { request: UnsubscribePushRequest, response: UnsubscribePushResponse }, { endpoint });

// ---- incoming webhooks of a channel (PLAN P14-14) --------------------------------------------------------------
export const fetchWebhooks = (channelId: string) => call(listWebhooksRoute, { response: ListWebhooksResponse }, undefined, { channelId });
/** Makes a webhook; the answer carries its secret address, which is shown once and never again. */
export const createWebhook = (channelId: string, body: CreateWebhookRequest) =>
  call(createWebhookRoute, { request: CreateWebhookRequest, response: WebhookWithUrl }, body, { channelId });
export const rotateWebhook = (webhookId: string) => call(rotateWebhookRoute, { response: WebhookWithUrl }, undefined, { webhookId });
export const revokeWebhook = (webhookId: string) => call(revokeWebhookRoute, { response: RevokeWebhookResponse }, undefined, { webhookId });
export const setWebhookSigningSecret = (webhookId: string) => call(setWebhookSigningRoute, { response: SigningSecretResponse }, undefined, { webhookId });
export const clearWebhookSigningSecret = (webhookId: string) => call(clearWebhookSigningRoute, { response: ClearSigningResponse }, undefined, { webhookId });
export const sendWebhookTest = (webhookId: string) => call(testWebhookRoute, { response: TestWebhookResponse }, undefined, { webhookId });

// ---- API tokens and outgoing webhooks of a channel (PLAN P14-14) -------------------------------------------------
export const fetchApiTokens = (channelId: string) => call(listApiTokensRoute, { response: ListApiTokensResponse }, undefined, { channelId });
/** Makes a token; the answer carries its secret, which is shown once and never again. */
export const createApiToken = (channelId: string, body: CreateApiTokenRequest) =>
  call(createApiTokenRoute, { request: CreateApiTokenRequest, response: ApiTokenWithSecret }, body, { channelId });
export const rotateApiToken = (tokenId: string) => call(rotateApiTokenRoute, { response: ApiTokenWithSecret }, undefined, { tokenId });
export const revokeApiToken = (tokenId: string) => call(revokeApiTokenRoute, { response: RevokeApiTokenResponse }, undefined, { tokenId });
export const sendApiTokenTest = (tokenId: string) => call(testApiTokenRoute, { response: TestApiTokenResponse }, undefined, { tokenId });
export const fetchOutgoingHooks = (channelId: string) => call(listOutgoingHooksRoute, { response: ListOutgoingHooksResponse }, undefined, { channelId });
export const createOutgoingHook = (channelId: string, body: CreateOutgoingHookRequest) =>
  call(createOutgoingHookRoute, { request: CreateOutgoingHookRequest, response: OutgoingHook }, body, { channelId });
export const updateOutgoingHook = (hookId: string, body: UpdateOutgoingHookRequest) =>
  call(updateOutgoingHookRoute, { request: UpdateOutgoingHookRequest, response: OutgoingHook }, body, { hookId });
export const revokeOutgoingHook = (hookId: string) => call(revokeOutgoingHookRoute, { response: RevokeOutgoingHookResponse }, undefined, { hookId });
export const setOutgoingSigningSecret = (hookId: string) => call(setOutgoingSigningRoute, { response: OutgoingSigningResponse }, undefined, { hookId });
export const clearOutgoingSigningSecret = (hookId: string) => call(clearOutgoingSigningRoute, { response: ClearOutgoingSigningResponse }, undefined, { hookId });
export const sendOutgoingHookTest = (hookId: string) => call(testOutgoingHookRoute, { response: TestOutgoingHookResponse }, undefined, { hookId });

// ---- data protection: the data-loss policy and each team's reachable hosts (workspace admins) -----------------
export const fetchDlpPolicy = () => call(getDlpPolicyRoute, { response: DlpPolicy });
export const saveDlpDetector = (name: string, body: SetDlpDetectorRequest) => call(setDlpDetectorRoute, { request: SetDlpDetectorRequest, response: DlpPolicy }, body, { name });
export const addDlpRule = (body: CreateDlpRuleRequest) => call(createDlpRuleRoute, { request: CreateDlpRuleRequest, response: DlpRuleResponse }, body);
export const changeDlpRule = (ruleId: string, body: UpdateDlpRuleRequest) => call(updateDlpRuleRoute, { request: UpdateDlpRuleRequest, response: DlpRuleResponse }, body, { ruleId });
export const removeDlpRule = (ruleId: string) => call(deleteDlpRuleRoute, { response: DeleteDlpRuleResponse }, undefined, { ruleId });
export const testDlp = (body: TestDlpRequest) => call(testDlpRoute, { request: TestDlpRequest, response: TestDlpResponse }, body);
export const fetchTeamEgress = () => call(listTeamEgressRoute, { response: ListTeamEgressResponse });
export const saveTeamEgress = (teamId: string, body: SetTeamEgressRequest) => call(setTeamEgressRoute, { request: SetTeamEgressRequest, response: SetTeamEgressResponse }, body, { teamId });

// ---- link previews (P14-08) ----------------------------------------------------------------------------
/** The cards of up to 100 messages of one channel. The ids go as one comma list (the shared query schema reads it). */
export const fetchLinkPreviews = (channelId: string, messageIds: readonly string[]) =>
  call(listLinkPreviewsRoute, { response: ListLinkPreviewsResponse }, { messageIds: messageIds.join(',') }, { channelId });
/** The author takes a card off their message. */
export const removeLinkPreview = (channelId: string, messageId: string, previewId: string) =>
  call(removeLinkPreviewRoute, { response: RemoveLinkPreviewResponse }, undefined, { channelId, messageId, previewId });

// ---- screens a bot drew (P9-04) -----------------------------------------------------------------------
/** One surface of a channel the person reads. */
export const fetchSurface = (channelId: string, surfaceId: string) => call(getSurfaceRoute, { response: GetSurfaceResponse }, undefined, { channelId, surfaceId });
/** A press or a form sent back to the bot: data about a part of the screen, never a command. */
export const sendSurfaceEvent = (channelId: string, surfaceId: string, body: PostSurfaceEventRequest) =>
  call(postSurfaceEventRoute, { request: PostSurfaceEventRequest, response: PostSurfaceEventResponse }, body, { channelId, surfaceId });

/** A bound part reads its data (P9-06). Only the screen's version goes up: the tool and its arguments are the ones written on the screen, and the call runs as this person. */
export const fetchSurfaceData = (channelId: string, surfaceId: string, nodeId: string, body: PostSurfaceDataRequest) =>
  call(postSurfaceDataRoute, { request: PostSurfaceDataRequest, response: SurfaceDataResponse }, body, { channelId, surfaceId, nodeId });

// ---- import from Slack and Mattermost (workspace admins) -----------------------------------------------------
export const fetchImports = () => call(listImportsRoute, { response: ListImportsResponse });
export const fetchImport = (runId: string) => call(getImportRoute, { response: ImportRun }, undefined, { runId });
export const dryRunImport = (runId: string) => call(dryRunImportRoute, { response: ImportRun }, undefined, { runId });
export const startImport = (runId: string) => call(startImportRoute, { response: ImportRun }, undefined, { runId });
export const cancelImport = (runId: string) => call(cancelImportRoute, { response: ImportRun }, undefined, { runId });
export const deleteImport = (runId: string) => call(deleteImportRoute, { response: DeleteImportResponse }, undefined, { runId });

/**
 * Upload an export archive as a raw byte stream, with progress (an XHR, because `fetch` cannot report upload progress). The choices ride in the address:
 * the server reads the first bytes to check the file is what was said, and refuses anything else at once.
 */
export function uploadImportArchive(
  input: { source: ImportSource; team: string; file: File },
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<ImportRun> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({ source: input.source, team: input.team, name: input.file.name.slice(0, 200) || 'export' });
    xhr.open(uploadImportRoute.method, `${uploadImportRoute.path}?${query.toString()}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    const csrf = readCsrfCookie(document.cookie);
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
        const parsed = ImportRun.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError({ code: 'bad_response', status: xhr.status, message: 'The server sent a response this app does not understand.' }));
        return;
      }
      const message = typeof (body as { error?: { message?: unknown } } | undefined)?.error?.message === 'string' ? (body as { error: { message: string } }).error.message : `Upload failed (${xhr.status})`;
      reject(new ApiError({ code: xhr.status === 413 ? 'validation_failed' : 'internal', status: xhr.status, message }));
    };
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(input.file);
  });
}

// ---- usage pages (PLAN P8-11): counts and amounts of what the workspace, a team and a bot did; never what was said ----
export const fetchWorkspaceUsage = (days: number) => call(workspaceUsageRoute, { request: UsageQuery, response: WorkspaceUsageResponse }, UsageQuery.parse({ days }));
export const fetchTeamUsage = (slug: string, days: number) => call(teamUsageRoute, { request: UsageQuery, response: TeamUsageResponse }, UsageQuery.parse({ days }), { slug });
export const fetchBotUsage = (slug: string, botSlug: string, days: number) =>
  call(botUsageRoute, { request: UsageQuery, response: BotUsageResponse }, UsageQuery.parse({ days }), { slug, botSlug });
