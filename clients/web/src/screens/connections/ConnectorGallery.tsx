import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  CONNECTOR_CATEGORIES,
  availableTools,
  categoryCounts,
  connectionKindInfo,
  connectorCategoryLabel,
  searchConnectors,
  type ConnectionKindInfo,
  type ConnectorCategory,
  type ConnectorEntry,
} from '@manythreads/shared';
import { isAdmin, useSession } from '../../app/session';
import { authLine, toolsLine } from './galleryWords';

/*
 * The gallery inside "Add a connection" (PLAN P16-01): every connector of the catalog (packages/shared/src/connectors/catalog.ts), a search box and the nine shelves
 * (Mail, Calendar, Files, Tickets, CRM, Code, Chat, Finance, Design). A connector that works today and is a team's (a mailbox, SSH, Kubernetes) opens its form; one
 * that each person signs in to themselves (Google, Microsoft, Notion) sends the person to their connected accounts; one that is not built yet is shown greyed with the
 * reason, and does nothing. Nothing here holds a credential.
 */

type Props = { onPick: (kind: ConnectionKindInfo) => void; onNavigate: () => void };

export function ConnectorGallery({ onPick, onNavigate }: Props) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const counts = useMemo(() => categoryCounts(), []);
  const shown = useMemo(() => searchConnectors({ query, category }), [query, category]);

  return (
    <div className="cg" data-testid="connector-gallery">
      <p className="dlg-text">
        A connection links an outside service to manythreads. Bots can then be given tools that work through it. Search, or pick a shelf. Some are not built yet; they are
        listed so you can see what is coming.
      </p>
      <div className="fld cg-search">
        <label htmlFor="connector-search">Search</label>
        <input
          id="connector-search"
          type="search"
          value={query}
          maxLength={80}
          placeholder="calendar, invoice, ticket…"
          autoComplete="off"
          data-autofocus=""
          data-testid="connector-search"
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="cg-shelves" role="group" aria-label="Shelves">
        <button type="button" className={`cg-chip ${category === null ? 'on' : ''}`} aria-pressed={category === null} data-testid="connector-category-all" onClick={() => setCategory(null)}>
          All
        </button>
        {CONNECTOR_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`cg-chip ${category === c.id ? 'on' : ''}`}
            aria-pressed={category === c.id}
            data-testid={`connector-category-${c.id}`}
            onClick={() => setCategory(category === c.id ? null : c.id)}
          >
            {c.label} <span className="cg-count">{counts[c.id]}</span>
          </button>
        ))}
      </div>
      <p className="cg-found faint" role="status" aria-live="polite" data-testid="connector-count">
        {shown.length === 1 ? '1 connector' : `${String(shown.length)} connectors`}
      </p>
      {shown.length === 0 ? (
        <p className="cg-empty" data-testid="connector-empty">
          Nothing matches “{query.trim().slice(0, 40)}”. Try a shorter word, or clear the shelf.
        </p>
      ) : (
        <ul className="cg-list">
          {shown.map((e) => (
            <Card key={e.id} entry={e} onPick={onPick} onNavigate={onNavigate} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Card({ entry: e, onPick, onNavigate }: { entry: ConnectorEntry; onPick: Props['onPick']; onNavigate: Props['onNavigate'] }) {
  const planned = e.status !== 'available';
  const kind = e.kind !== null ? connectionKindInfo(e.kind) : undefined;
  const teamForm = !planned && kind !== undefined && e.heldBy.includes('team') && kind.available;
  const personal = !planned && !teamForm && e.heldBy.includes('person');
  // a chat app (Telegram, WhatsApp, Slack, Teams) has no form here: an admin sets it up on the Chat apps page, anyone else links their own account on theirs
  const chat = !planned && !teamForm && !personal && e.categories.includes('chat');
  const admin = isAdmin(useSession());
  const note = `cg-note-${e.id}`;
  return (
    <li className={`cg-card ${planned ? 'off' : ''}`} data-connector={e.id} data-status={e.status} data-testid={`connector-card-${e.id}`}>
      <div className="cg-head">
        <strong className="cg-name">{e.label}</strong>
        <span className="cg-shelf faint">{e.categories.map(connectorCategoryLabel).join(' · ')}</span>
      </div>
      <p className="cg-text" id={note}>
        {e.description}
        {planned ? <span className="cg-reason"> {e.reason}</span> : null}
      </p>
      <p className="cg-meta faint">
        {authLine(e)}
        {!planned ? ` · ${toolsLine(availableTools(e).length)}` : ''}
      </p>
      <div className="cg-actions">
        {teamForm && kind ? (
          <button type="button" className="btn primary" aria-describedby={note} data-kind={kind.kind} data-testid={`connection-kind-${kind.kind}`} onClick={() => onPick(kind)}>
            Add {e.label}
          </button>
        ) : null}
        {personal ? (
          <Link className="btn" to="/settings/connections" aria-describedby={note} data-testid={`connector-personal-${e.id}`} onClick={onNavigate}>
            Connect your own account
          </Link>
        ) : null}
        {chat ? (
          <Link className="btn" to={admin ? '/settings/workspace/chat-apps' : '/account/chat-apps'} aria-describedby={note} data-testid={`connector-chat-${e.id}`} onClick={onNavigate}>
            {admin ? 'Set up in Chat apps' : 'Link your own account'}
          </Link>
        ) : null}
        {planned ? (
          <span className="cg-soon" data-testid={`connector-soon-${e.id}`}>
            Not available yet
          </span>
        ) : null}
      </div>
    </li>
  );
}
