import { useId, useState } from 'react';
import type { MemorySharingSetting } from '@manythreads/shared';
import { isApiError } from '../../../api/client';
import { useQuery } from '../../../app/useQuery';
import { QueryView } from '../../../components/states';
import { Alert, Notice, Time, Toggle } from '../../../components/ui';
import { fetchMemorySharing, setMemorySharing } from '../../memory/shareApi';
import { switchWords } from './words';

/*
 * Workspace → Memory sharing (SPEC §12.3, PLAN P8-26): the one switch that lets teams pass memory to each other. It is on until an owner or admin turns it off. Off,
 * no team builds or sends a digest, none is delivered and none is filed; what was already received stays where it is. Everyone in the workspace can read the setting
 * (a team should know why nothing arrives); the page sits in the Workspace settings, which only an owner or admin opens.
 */
export function MemorySharing() {
  const q = useQuery('memory-sharing-setting', fetchMemorySharing);
  return (
    <>
      <h1 className="pane-title">Memory sharing</h1>
      <p className="lede">Whether teams in this workspace may pass what they know to each other. Each team still chooses what leaves it and whether it wants to receive anything.</p>
      <QueryView q={q}>{(setting) => <Switch initial={setting} />}</QueryView>
    </>
  );
}

function Switch({ initial }: { initial: MemorySharingSetting }) {
  const labelId = useId();
  const descId = useId();
  const [setting, setSetting] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const words = switchWords(setting.enabled);

  const change = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await setMemorySharing(enabled);
      setSetting(next);
      setNote(switchWords(next.enabled).done);
    } catch (e) {
      setError(isApiError(e) ? e.message : 'The switch could not be changed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="block" aria-labelledby={labelId} data-testid="memory-sharing">
      <h2 className="bh" id={labelId}>Teams may share memory</h2>
      {error ? <Alert>{error}</Alert> : null}
      {note ? <Notice>{note}</Notice> : null}
      <ul className="rows">
        <li className="srow">
          <div>
            <div>Memory sharing is <strong data-testid="memory-sharing-state">{words.state}</strong></div>
            <div className="d" id={descId} data-testid="memory-sharing-help">{words.help}</div>
            {setting.changedAt ? <div className="d">Last changed <Time iso={setting.changedAt} /></div> : null}
            {!setting.canChange ? <div className="d" data-testid="memory-sharing-locked">Only a workspace owner or admin can change this.</div> : null}
          </div>
          <Toggle label="Let teams share memory" checked={setting.enabled} busy={busy} locked={!setting.canChange} describedBy={descId} onChange={(v) => void change(v)} />
        </li>
      </ul>
    </section>
  );
}
