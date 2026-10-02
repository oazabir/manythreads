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
import { ChannelView, DirectMessageView, HomeView, RequireTeam, SectionView, TeamHome, ThreadsView } from './shell/views';
import { Teams } from './screens/Teams';
import { Members, Roles, WorkspaceGeneral } from './screens/WorkspaceSettings';

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

        <Route element={<RequireSession />}>
          <Route element={<Shell />}>
            <Route path="/" element={<HomeView />} />
            <Route path="/t/:team" element={<TeamHome />} />
            <Route path="/t/:team/threads" element={<RequireTeam><ThreadsView /></RequireTeam>} />
            <Route path="/t/:team/files" element={<RequireTeam><SectionView section="files" /></RequireTeam>} />
            <Route path="/t/:team/boards" element={<RequireTeam><SectionView section="boards" /></RequireTeam>} />
            <Route path="/t/:team/approvals" element={<RequireTeam><SectionView section="approvals" /></RequireTeam>} />
            <Route path="/t/:team/c/:channel" element={<RequireTeam><ChannelView /></RequireTeam>} />
            <Route path="/t/:team/dm/:id" element={<RequireTeam><DirectMessageView /></RequireTeam>} />
          </Route>
          <Route path="/account" element={<Account />} />
          <Route element={<SettingsFrame />}>
            <Route path="/teams" element={<Teams />} />
            <Route path="/teams/:slug" element={<TeamRedirect />} />
            <Route path="/settings" element={<Navigate to="/settings/workspace/general" replace />} />
            <Route path="/settings/workspace" element={<AdminOnly />}>
              <Route index element={<Navigate to="general" replace />} />
              <Route path="general" element={<WorkspaceGeneral />} />
              <Route path="sign-in" element={<SignInMethods />} />
              <Route path="members" element={<Members />} />
              <Route path="roles" element={<Roles />} />
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
