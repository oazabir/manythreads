import { OpenRoute } from './notifications/OpenLink';
import { Suspense, lazy } from 'react';
import { createBrowserRouter, Navigate, Route, RouterProvider, Routes, useLocation, useParams, useSearchParams } from 'react-router';
import { RequireSession, SessionProvider } from './app/session';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsFrame } from './components/frames';
import { ExpiredLinkPage, ForbiddenPage, NotFoundPage } from './components/states';
import { DevTokens } from './pages/DevTokens';
import { AccountIndex } from './screens/account/AccountIndex';
import { Appearance as AccountAppearance } from './screens/account/Appearance';
import { BotConsents as AccountBotConsents } from './screens/account/BotConsents';
import { ActionItemsView as AccountActionItems } from './screens/files/actionItems/ActionItemsView';
import { RoutinesTab as AccountRoutines } from './screens/files/routines/RoutinesTab';
import { Notifications as AccountNotifications } from './screens/account/Notifications';
import { Profile as AccountProfile } from './screens/account/Profile';
import { Security as AccountSecurity } from './screens/account/Security';
import { AccountConnections } from './screens/connections/AccountConnections';
import { OAuthApps } from './screens/connections/OAuthApps';
import { PersonConnections } from './screens/connections/PersonConnections';
import { TeamConnections } from './screens/connections/TeamConnections';
import { AdminOnly } from './screens/AdminOnly';
import { Bootstrap } from './screens/Bootstrap';
import { Invite } from './screens/Invite';
import { ResetPassword, VerifyEmail } from './screens/ResetPassword';
import { Roster, TeamChannels, TeamRedirect, TeamTemplate } from './screens/Roster';
import { SignIn } from './screens/SignIn';
import { SignInMethods } from './screens/SignInMethods';
import { Shell } from './shell/Shell';
import { WorkspaceHttps } from './screens/https/WorkspaceHttps';
import { SystemHealth } from './screens/health/SystemHealth';
import { Audit } from './screens/audit/Audit';
import { BotUsage, TeamUsage, WorkspaceUsage } from './screens/usage/UsageScreens';
import { ImportScreen } from './screens/import/ImportScreen';
import { Guardrails } from './screens/guardrails/Guardrails';
import { LlmSettings } from './screens/admin/llm/LlmSettings';
import { MemorySharing } from './screens/admin/memory/MemorySharing';
import { RunnersScreen } from './screens/admin/runners/RunnersScreen';
import { BrainSettings } from './screens/admin/brain/BrainSettings';
import { DirectMessageView, HomeView, RequireTeam, TeamHome } from './shell/views';
import { BotPage } from './screens/bots/BotPage';
import { ApprovalsScreen } from './screens/approvals/ApprovalsScreen';
import { AgentsScreen } from './screens/agents/AgentsScreen';
import { ProjectsScreen } from './screens/projects/ProjectsScreen';
import { BotRoster } from './screens/bots/BotRoster';
import { SetupScreen } from './screens/setup/SetupScreen';
import { ProposalPage, ProposalsList } from './screens/proposals/ProposalsScreen';
import { RecipesScreen } from './screens/recipes/RecipesScreen';
import { BoardsScreen } from './screens/boards/BoardsScreen';
import { OrgScreen } from './screens/boards/OrgScreen';
import { ScheduledJobsScreen } from './screens/boards/ScheduledJobsScreen';
import { ChatScreen } from './screens/chat/ChatScreen';
import { ConversationRedirect, ConversationView } from './screens/conversations/ConversationView';
import { ChannelView } from './screens/ChannelView';
import { ThreadsInbox } from './screens/ThreadsInbox';
import { ActivityScreen } from './screens/phone/ActivityScreen';
import { MessagesScreen } from './screens/phone/MessagesScreen';
import { SearchScreen } from './screens/search/SearchScreen';
import { Teams } from './screens/Teams';
import { Onboarding } from './screens/onboarding/Onboarding';
import { Members, Roles, WorkspaceGeneral } from './screens/WorkspaceSettings';
import { ConnectionsAdmin } from './screens/admin/connections/ConnectionsAdmin';
import { AccountChatApps } from './screens/bridges/AccountChatApps';
import { AdminChatApps } from './screens/bridges/AdminChatApps';

// developer page: its viewers load on demand, not with the app
// the Files screen carries the viewers' host: it loads when Files is opened
const FilesScreen = lazy(() => import('./screens/files/FilesScreen').then((m) => ({ default: m.FilesScreen })));
const KnowledgeScreen = lazy(() => import('./screens/knowledge/KnowledgeScreen').then((m) => ({ default: m.KnowledgeScreen })));
const MemoryScreen = lazy(() => import('./screens/memory/MemoryScreen').then((m) => ({ default: m.MemoryScreen })));
const JoinScheduled = lazy(() => import('./screens/meetings/JoinScheduled').then((m) => ({ default: m.JoinScheduled })));
const MeetingView = lazy(() => import('./screens/meetings/MeetingView').then((m) => ({ default: m.MeetingView })));
const DevSpeech = lazy(() => import('./pages/DevSpeech').then((m) => ({ default: m.DevSpeech })));
const DevViewers = lazy(() => import('./pages/DevViewers').then((m) => ({ default: m.DevViewers })));

function ExpiredRoute() {
  const [params] = useSearchParams();
  const kind = params.get('kind');
  return <ExpiredLinkPage kind={kind === 'bootstrap' ? 'bootstrap' : kind === 'reset' ? 'reset' : 'invitation'} />;
}

/** The Jobs page used to live at `/t/<team>/rhythms`; bookmarks and old links still arrive there. */
function OldJobsAddress() {
  const { team = '' } = useParams();
  return <Navigate to={`/t/${team}/jobs`} replace />;
}

/**
 * `/t/<team>/bots/<bot>/chat`: Brain's conversations live in Chat now, so an old link to Brain's chat lands there with its thread. Any other bot (and the
 * Workshop tab of Brain) keeps the conversation view of the bot's own page.
 */
function BotChatRoute() {
  const { team = '', botSlug = '' } = useParams();
  const [params] = useSearchParams();
  if (botSlug === 'brain' && params.get('view') === null && params.get('tab') === null) {
    const thread = params.get('thread');
    return <Navigate to={`/t/${team}/chat?bot=brain${thread ? `&c=${encodeURIComponent(thread)}` : ''}`} replace />;
  }
  return <ConversationView />;
}

function AppRoutes() {
  const loc = useLocation();
  return (
    <ErrorBoundary resetKey={loc.pathname}>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/bootstrap/:token" element={<Bootstrap />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/reset-password/:token" element={<ResetPassword />} />
        <Route path="/verify-email/:token" element={<VerifyEmail />} />
        <Route path="/expired" element={<ExpiredRoute />} />
        <Route path="/403" element={<ForbiddenPage />} />
        <Route path="/dev/tokens" element={<DevTokens />} />
        <Route path="/dev/speech" element={<Suspense fallback={null}><DevSpeech /></Suspense>} />
        <Route path="/dev/viewers" element={<Suspense fallback={null}><DevViewers /></Suspense>} />

        <Route element={<RequireSession />}>
          <Route element={<Shell />}>
            <Route path="/" element={<HomeView />} />
            <Route path="/open" element={<OpenRoute />} />
            <Route path="/t/:team" element={<TeamHome />} />
            <Route path="/t/:team/search" element={<RequireTeam><SearchScreen /></RequireTeam>} />
            <Route path="/t/:team/threads" element={<RequireTeam><ThreadsInbox /></RequireTeam>} />
            <Route path="/t/:team/dms" element={<RequireTeam><MessagesScreen /></RequireTeam>} />
            <Route path="/t/:team/activity" element={<RequireTeam><ActivityScreen /></RequireTeam>} />
            <Route path="/files" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><FilesScreen /></Suspense>} />
            <Route element={<AdminOnly />}>
              <Route path="/files/person/:personId" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><FilesScreen /></Suspense>} />
            </Route>
            <Route path="/t/:team/files" element={<RequireTeam><Suspense fallback={<div className="view-empty" aria-busy="true" />}><FilesScreen /></Suspense></RequireTeam>} />
            <Route path="/meetings/:meetingId" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><MeetingView /></Suspense>} />
            <Route path="/t/:team/meetings/:meetingId" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><MeetingView /></Suspense>} />
            <Route path="/join/:scheduledId" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><JoinScheduled /></Suspense>} />
            <Route path="/memory" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><MemoryScreen /></Suspense>} />
            <Route path="/knowledge" element={<Suspense fallback={<div className="view-empty" aria-busy="true" />}><KnowledgeScreen /></Suspense>} />
            <Route path="/t/:team/knowledge" element={<RequireTeam><Suspense fallback={<div className="view-empty" aria-busy="true" />}><KnowledgeScreen /></Suspense></RequireTeam>} />
            <Route path="/t/:team/memory" element={<RequireTeam><Suspense fallback={<div className="view-empty" aria-busy="true" />}><MemoryScreen /></Suspense></RequireTeam>} />
            <Route path="/t/:team/boards" element={<RequireTeam><BoardsScreen /></RequireTeam>} />
            <Route path="/t/:team/org" element={<RequireTeam><OrgScreen /></RequireTeam>} />
            <Route path="/t/:team/jobs" element={<RequireTeam><ScheduledJobsScreen /></RequireTeam>} />
            <Route path="/t/:team/rhythms" element={<OldJobsAddress />} />
            <Route path="/t/:team/approvals" element={<RequireTeam><ApprovalsScreen /></RequireTeam>} />
            <Route path="/t/:team/bots" element={<RequireTeam><BotRoster /></RequireTeam>} />
            <Route path="/t/:team/agents" element={<RequireTeam><AgentsScreen /></RequireTeam>} />
            <Route path="/t/:team/projects" element={<RequireTeam><ProjectsScreen /></RequireTeam>} />
            <Route path="/t/:team/projects/:projectId" element={<RequireTeam><ProjectsScreen /></RequireTeam>} />
            <Route path="/t/:team/bots/new" element={<RequireTeam><SetupScreen /></RequireTeam>} />
            <Route path="/t/:team/bots/:botSlug" element={<RequireTeam><BotPage /></RequireTeam>} />
            <Route path="/t/:team/recipes" element={<RequireTeam><RecipesScreen /></RequireTeam>} />
            <Route path="/t/:team/proposals" element={<RequireTeam><ProposalsList /></RequireTeam>} />
            <Route path="/t/:team/proposals/:proposalId" element={<RequireTeam><ProposalPage /></RequireTeam>} />
            <Route path="/t/:team/bots/:botSlug/usage" element={<RequireTeam><BotUsage /></RequireTeam>} />
            <Route path="/t/:team/bots/:botSlug/chat" element={<RequireTeam><BotChatRoute /></RequireTeam>} />
            <Route path="/t/:team/chat" element={<RequireTeam><ChatScreen /></RequireTeam>} />
            <Route path="/t/:team/chat/:channelId" element={<RequireTeam><ConversationRedirect /></RequireTeam>} />
            <Route path="/t/:team/c/:channel" element={<RequireTeam><ChannelView /></RequireTeam>} />
            <Route path="/t/:team/dm/:id" element={<RequireTeam><DirectMessageView /></RequireTeam>} />
          </Route>
          <Route path="/settings/connections" element={<PersonConnections />} />
          <Route element={<AdminOnly />}>
            <Route path="/settings/connections/apps" element={<OAuthApps />} />
          </Route>
          <Route element={<SettingsFrame />}>
            <Route path="/account" element={<AccountIndex />} />
            <Route path="/account/profile" element={<AccountProfile />} />
            <Route path="/account/appearance" element={<AccountAppearance />} />
            <Route path="/account/notifications" element={<AccountNotifications />} />
            <Route path="/account/connections" element={<AccountConnections />} />
            <Route path="/account/chat-apps" element={<AccountChatApps />} />
            <Route path="/account/security" element={<AccountSecurity />} />
            <Route path="/account/bots" element={<AccountBotConsents />} />
            <Route path="/account/routines" element={<AccountRoutines />} />
            <Route path="/account/action-items" element={<AccountActionItems />} />
            <Route element={<AdminOnly />}>
              <Route path="/onboarding" element={<Onboarding />} />
            </Route>
            <Route path="/teams" element={<Teams />} />
            <Route path="/teams/:slug" element={<TeamRedirect />} />
            <Route path="/settings" element={<Navigate to="/settings/workspace/general" replace />} />
            <Route path="/settings/workspace" element={<AdminOnly />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<WorkspaceGeneral />} />
              <Route path="sign-in" element={<SignInMethods />} />
              <Route path="members" element={<Members />} />
              <Route path="roles" element={<Roles />} />
              <Route path="llm" element={<LlmSettings />} />
              <Route path="runners" element={<RunnersScreen />} />
              <Route path="brain" element={<BrainSettings />} />
              <Route path="memory-sharing" element={<MemorySharing />} />
              <Route path="https" element={<WorkspaceHttps />} />
              <Route path="health" element={<SystemHealth />} />
              <Route path="guardrails" element={<Guardrails />} />
              <Route path="audit" element={<Audit />} />
              <Route path="usage" element={<WorkspaceUsage />} />
              <Route path="import" element={<ImportScreen />} />
              <Route path="connections" element={<ConnectionsAdmin />} />
              <Route path="chat-apps" element={<AdminChatApps />} />
            </Route>
            <Route path="/settings/team/:slug">
              <Route index element={<Navigate to="roster" replace />} />
              <Route path="roster" element={<Roster />} />
              <Route path="template" element={<TeamTemplate />} />
              <Route path="channels" element={<TeamChannels />} />
              <Route path="connections" element={<TeamConnections />} />
              <Route path="usage" element={<TeamUsage />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ErrorBoundary>
  );
}

/*
 * A data router (one splat route around the whole app) rather than `BrowserRouter`: only a data router can hold a screen back with `useBlocker`
 * (the bot page asks "Leave without saving?", P21-17). The routes themselves stay in `AppRoutes`.
 *
 * `useTransitions={false}`: React Router 8 applies every navigation inside `React.startTransition`, and the Chat screen's navigation (the new chat's `?c=`) never
 * committed there: the address changed, the screen stayed on "New chat" with the sent text still in the box, because the screen keeps re-rendering on urgent updates
 * (the history rail, the live answer) and the low-priority render of the new location was never finished. A navigation is applied at once instead.
 */
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    ),
  },
]);

export function App() {
  return <RouterProvider router={router} useTransitions={false} />;
}
