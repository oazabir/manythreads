import { OpenRoute } from './notifications/OpenLink';
import { Suspense, lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router';
import { RequireSession, SessionProvider } from './app/session';
import { ErrorBoundary } from './components/ErrorBoundary';
import { SettingsFrame } from './components/frames';
import { ExpiredLinkPage, ForbiddenPage, NotFoundPage } from './components/states';
import { DevTokens } from './pages/DevTokens';
import { Account } from './screens/Account';
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
import { Guardrails } from './screens/guardrails/Guardrails';
import { LlmSettings } from './screens/admin/llm/LlmSettings';
import { DirectMessageView, HomeView, RequireTeam, TeamHome } from './shell/views';
import { BotPage } from './screens/bots/BotPage';
import { ApprovalsScreen } from './screens/approvals/ApprovalsScreen';
import { AgentsScreen } from './screens/agents/AgentsScreen';
import { ProjectsScreen } from './screens/projects/ProjectsScreen';
import { BotRoster } from './screens/bots/BotRoster';
import { ProposalPage, ProposalsList } from './screens/proposals/ProposalsScreen';
import { BoardsScreen } from './screens/boards/BoardsScreen';
import { OrgScreen } from './screens/boards/OrgScreen';
import { RhythmsScreen } from './screens/boards/RhythmsScreen';
import { ConversationRedirect, ConversationView } from './screens/conversations/ConversationView';
import { ChannelView } from './screens/ChannelView';
import { ThreadsInbox } from './screens/ThreadsInbox';
import { Teams } from './screens/Teams';
import { Onboarding } from './screens/onboarding/Onboarding';
import { Members, Roles, WorkspaceGeneral } from './screens/WorkspaceSettings';

// developer page: its viewers load on demand, not with the app
// the Files screen carries the viewers' host: it loads when Files is opened
const FilesScreen = lazy(() => import('./screens/files/FilesScreen').then((m) => ({ default: m.FilesScreen })));
const MemoryScreen = lazy(() => import('./screens/memory/MemoryScreen').then((m) => ({ default: m.MemoryScreen })));
const DevViewers = lazy(() => import('./pages/DevViewers').then((m) => ({ default: m.DevViewers })));

function ExpiredRoute() {
  const [params] = useSearchParams();
  const kind = params.get('kind');
  return <ExpiredLinkPage kind={kind === 'bootstrap' ? 'bootstrap' : kind === 'reset' ? 'reset' : 'invitation'} />;
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
        <Route path="/dev/viewers" element={<Suspense fallback={null}><DevViewers /></Suspense>} />

        <Route element={<RequireSession />}>
          <Route element={<Shell />}>
            <Route path="/" element={<HomeView />} />
            <Route path="/open" element={<OpenRoute />} />
            <Route path="/t/:team" element={<TeamHome />} />
            <Route path="/t/:team/threads" element={<RequireTeam><ThreadsInbox /></RequireTeam>} />
            <Route path="/t/:team/files" element={<RequireTeam><Suspense fallback={<div className="view-empty" aria-busy="true" />}><FilesScreen /></Suspense></RequireTeam>} />
            <Route path="/t/:team/memory" element={<RequireTeam><Suspense fallback={<div className="view-empty" aria-busy="true" />}><MemoryScreen /></Suspense></RequireTeam>} />
            <Route path="/t/:team/boards" element={<RequireTeam><BoardsScreen /></RequireTeam>} />
            <Route path="/t/:team/org" element={<RequireTeam><OrgScreen /></RequireTeam>} />
            <Route path="/t/:team/rhythms" element={<RequireTeam><RhythmsScreen /></RequireTeam>} />
            <Route path="/t/:team/approvals" element={<RequireTeam><ApprovalsScreen /></RequireTeam>} />
            <Route path="/t/:team/bots" element={<RequireTeam><BotRoster /></RequireTeam>} />
            <Route path="/t/:team/agents" element={<RequireTeam><AgentsScreen /></RequireTeam>} />
            <Route path="/t/:team/projects" element={<RequireTeam><ProjectsScreen /></RequireTeam>} />
            <Route path="/t/:team/bots/:botSlug" element={<RequireTeam><BotPage /></RequireTeam>} />
            <Route path="/t/:team/proposals" element={<RequireTeam><ProposalsList /></RequireTeam>} />
            <Route path="/t/:team/proposals/:proposalId" element={<RequireTeam><ProposalPage /></RequireTeam>} />
            <Route path="/t/:team/bots/:botSlug/chat" element={<RequireTeam><ConversationView /></RequireTeam>} />
            <Route path="/t/:team/chat/:channelId" element={<RequireTeam><ConversationRedirect /></RequireTeam>} />
            <Route path="/t/:team/c/:channel" element={<RequireTeam><ChannelView /></RequireTeam>} />
            <Route path="/t/:team/dm/:id" element={<RequireTeam><DirectMessageView /></RequireTeam>} />
          </Route>
          <Route path="/account" element={<Account />} />
          <Route element={<SettingsFrame />}>
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
              <Route path="https" element={<WorkspaceHttps />} />
              <Route path="health" element={<SystemHealth />} />
              <Route path="guardrails" element={<Guardrails />} />
              <Route path="audit" element={<Audit />} />
            </Route>
            <Route path="/settings/team/:slug">
              <Route index element={<Navigate to="roster" replace />} />
              <Route path="roster" element={<Roster />} />
              <Route path="template" element={<TeamTemplate />} />
              <Route path="channels" element={<TeamChannels />} />
            </Route>
          </Route>
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <AppRoutes />
      </SessionProvider>
    </BrowserRouter>
  );
}
