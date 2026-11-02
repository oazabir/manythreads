import type { ReactNode } from 'react';
import type { Connection } from '@manythreads/shared';
import { Time, Toggle } from '../../components/ui';
import { credentialLine, environmentLabel, kindLabel, stateLook } from './words';

/** One word for where a connection stands, with a shape as well as a colour. */
export function StateBadge({ connection }: { connection: Connection }) {
  const look = stateLook(connection);
  return (
    <span className={`cn-state ${look.tone}`} data-state={look.label} data-testid="connection-state">
      <span aria-hidden="true">{look.glyph}</span> {look.label}
    </span>
  );
}

/** A connection as a row: its name, what it is, where it stands and what is stored. The actions are the page's. */
export function ConnectionRow({
  connection: c,
  busy,
  canSwitch,
  onSwitch,
  children,
}: {
  connection: Connection;
  busy: boolean;
  /** Shown only to someone who may change it. */
  canSwitch: boolean;
  onSwitch: (on: boolean) => void;
  children?: ReactNode;
}) {
  const stuckOff = !c.hasCredentials;
  const hintId = `cn-stuck-${c.id}`;
  return (
    <li className="cn-row" data-connection={c.slug} data-testid="connection-row" aria-busy={busy || undefined}>
      <div className="cn-main">
        <div className="cn-title">
          <strong className="cn-name">{c.name}</strong>
          <span className="mono faint">{c.slug}</span>
        </div>
        <div className="cn-meta">
          <span>{kindLabel(c.kind)}</span>
          <StateBadge connection={c} />
          <span data-testid="connection-environment-tag">{environmentLabel(c.environment)}</span>
          {c.expiresAt ? (
            <span className={c.expired ? 'cn-warn' : undefined}>
              {c.expired ? 'Expired ' : 'Stops working '}
              <Time iso={c.expiresAt} />
            </span>
          ) : null}
        </div>
        <div className="cn-detail" data-testid="connection-credential-line">{credentialLine(c)}</div>
        {canSwitch && stuckOff ? <div className="cn-detail faint" id={hintId}>It cannot be switched on until a credential is stored. Use Change to add one.</div> : null}
      </div>
      <div className="cn-actions">
        {canSwitch ? (
          <span className="cn-switch">
            <Toggle label={`Use ${c.name}`} checked={c.status === 'enabled'} busy={busy} locked={stuckOff && c.status !== 'enabled'} {...(stuckOff ? { describedBy: hintId } : {})} onChange={onSwitch} />
            <span aria-hidden="true">{c.status === 'enabled' ? 'On' : 'Off'}</span>
          </span>
        ) : null}
        {children}
      </div>
    </li>
  );
}
