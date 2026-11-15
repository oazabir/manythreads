import { useState } from 'react';
import { RunnersScreen } from './RunnersScreen';
import { ServersSection } from './ServersSection';

/**
 * Workspace → Runners: the runners, then the servers the installer put a bridge on (P26-13). A change made in the servers part (a server's agent signed in, a server added or removed)
 * changes the runner list above it, so the list is read again: it is shown anew under a new key.
 */
export function RunnersPage() {
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <RunnersScreen key={generation} />
      <ServersSection onRunnersChanged={() => setGeneration((n) => n + 1)} />
    </>
  );
}
