import { AppFrame } from './pages/AppFrame';
import { DevTokens } from './pages/DevTokens';

export function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/dev/tokens') return <DevTokens />;
  return <AppFrame />;
}
