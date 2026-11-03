import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { fetchTeams } from '../../api/endpoints';
import { useQuery } from '../../app/useQuery';
import { isAdmin as isWorkspaceAdmin, useSession } from '../../app/session';
import { IncomingCard } from './IncomingCard';
import { fetchConcepts, fetchInboxItems } from './inboxApi';
import { fetchIncomingShares, fetchMemorySharing, fetchShares } from './shareApi';
import { ShareCard } from './ShareCard';
import { ShareDialog } from './ShareDialog';
import { conceptsFromTeam, digestsFrom, receivedLinks, requestedLinks, runIsMoving } from './shareWords';

/** How often the list is read again while a digest is being built or sent, and after a new share is saved (the server loads its file a moment later). */
const POLL_MS = 3_000;
const POLL_AFTER_CREATE_MS = 20_000;

/**
 * The Memory screen's Sharing tab (PLAN P8-26, SPEC §12.3): the shares this team sends to other teams (what, to whom, how often, who approves, the answer of
 * each team, a live count, the last digest and Run now), the requests other teams make to send here, and what has been received from each. Everyone on the
 * team reads it; a lead or a workspace admin creates shares, runs them and answers the requests.
 */
export function SharingTab({ slug }: { slug: string }) {
  const session = useSession();
  const shares = useQuery(`shares:${slug}`, () => fetchShares(slug));
  const incoming = useQuery(`shares-incoming:${slug}`, () => fetchIncomingShares(slug));
  const setting = useQuery('memory-sharing', fetchMemorySharing);
  const inbox = useQuery(`shares-inbox:${slug}`, () => fetchInboxItems(slug).catch(() => null));
  const concepts = useQuery(`shares-concepts:${slug}`, () => fetchConcepts(slug).catch(() => null));
  const teams = useQuery('shares-teams', () => fetchTeams());
  const [creating, setCreating] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const [watchUntil, setWatchUntil] = useState(0);

  const sharingOn = setting.status === 'ok' ? setting.data.enabled : true;
  const canManageOut = shares.status === 'ok' ? shares.data.canManage : false;
  const canManageIn = incoming.status === 'ok' ? incoming.data.canManage : false;
  const list = useMemo(() => (shares.status === 'ok' ? shares.data.shares : []), [shares]);
  const links = useMemo(() => (incoming.status === 'ok' ? incoming.data.incoming : []), [incoming]);
  const requests = requestedLinks(links);
  const received = receivedLinks(links);
  const thisTeam = teams.status === 'ok' ? teams.data.teams.find((t) => t.slug === slug) : undefined;
  const others = useMemo(() => (teams.status === 'ok' ? teams.data.teams.filter((t) => t.slug !== slug && !t.archivedAt).map((t) => ({ slug: t.slug, name: t.name })) : []), [teams, slug]);
  const taken = useMemo(() => new Set(list.map((s) => s.slug)), [list]);
  const items = inbox.status === 'ok' && inbox.data ? inbox.data.items : [];
  const conceptList = concepts.status === 'ok' && concepts.data ? concepts.data.items : [];
  const isAdmin = isWorkspaceAdmin(session);

  const { reload: reloadShares } = shares;
  const { reload: reloadIncoming } = incoming;
  const { reload: reloadInbox } = inbox;
  const moving = list.some((s) => runIsMoving(s.lastRun?.state));
  // read again while a digest is being built or handed over, and for a short while after a new share is saved
  useEffect(() => {
    if (!moving && Date.now() >= watchUntil) return;
    const t = window.setInterval(() => {
      reloadShares();
      reloadIncoming();
      reloadInbox();
    }, POLL_MS);
    const stop = watchUntil > Date.now() ? window.setTimeout(() => window.clearInterval(t), watchUntil - Date.now()) : undefined;
    return () => {
      window.clearInterval(t);
      if (stop !== undefined) window.clearTimeout(stop);
    };
  }, [moving, watchUntil, reloadShares, reloadIncoming, reloadInbox]);

  const changed = (line: string): void => {
    setSaid(line);
    reloadShares();
    reloadIncoming();
    reloadInbox();
  };

  return (
    <div className="ms" data-testid="sharing-tab">
      <p className="mi-help ms-intro">
        Teams can pass what they know to each other on purpose. {thisTeam?.name ?? 'This team'} decides what leaves and who approves it; every other team decides whether it wants to receive it. What a team receives is kept apart from its own memory and starts out unchecked.
      </p>
      {setting.status === 'ok' && !setting.data.enabled ? (
        <p className="ms-off" role="status" data-testid="sharing-off">
          <strong>Memory sharing is switched off for this workspace.</strong> Nothing is sent or received until a workspace admin switches it on.
          {isAdmin ? <> <Link to="/settings/workspace/memory-sharing" data-testid="sharing-off-link">Open the switch</Link></> : null}
        </p>
      ) : null}
      <div className="mi-status" role="status" aria-live="polite" data-testid="sharing-status">{said}</div>

      <section className="ms-section" aria-labelledby="ms-out">
        <header className="ms-section-head">
          <h2 id="ms-out" className="ms-h">Sent from {thisTeam?.name ?? 'this team'}</h2>
          {canManageOut ? <button type="button" className="btn s primary" onClick={() => setCreating(true)} data-testid="share-new">New share</button> : null}
        </header>
        {shares.status === 'loading' ? <div className="view-empty" aria-busy="true" /> : null}
        {shares.status === 'error' ? <p className="mi-error" role="alert" data-testid="shares-load-error">The shares could not be loaded: {shares.error.message}</p> : null}
        {shares.status === 'ok' && list.length === 0 ? (
          <p className="mi-empty faint" data-testid="shares-empty">
            This team does not share anything yet.{canManageOut ? ' Choose New share to offer part of its memory to another team.' : ' A team lead or a workspace admin can set one up.'}
          </p>
        ) : null}
        {list.length > 0 ? (
          <ul className="mi-list" data-testid="share-list">
            {list.map((s) => (
              <ShareCard key={s.id} slug={slug} share={s} canManage={canManageOut} sharingOn={sharingOn} onChanged={changed} />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="ms-section" aria-labelledby="ms-requests">
        <header className="ms-section-head">
          <h2 id="ms-requests" className="ms-h">Asking to share with {thisTeam?.name ?? 'this team'}</h2>
        </header>
        {incoming.status === 'error' ? <p className="mi-error" role="alert" data-testid="incoming-load-error">The requests could not be loaded: {incoming.error.message}</p> : null}
        {incoming.status === 'ok' && requests.length === 0 ? <p className="mi-empty faint" data-testid="requests-empty">No team is waiting for an answer.</p> : null}
        {requests.length > 0 ? (
          <ul className="mi-list" data-testid="request-list">
            {requests.map((l) => (
              <IncomingCard key={l.id} slug={slug} link={l} canManage={canManageIn} onChanged={changed} />
            ))}
          </ul>
        ) : null}
      </section>

      <section className="ms-section" aria-labelledby="ms-received">
        <header className="ms-section-head">
          <h2 id="ms-received" className="ms-h">Received from other teams</h2>
        </header>
        {incoming.status === 'ok' && received.length === 0 ? <p className="mi-empty faint" data-testid="received-empty">Nothing has been received from another team.</p> : null}
        {received.length > 0 ? (
          <ul className="mi-list" data-testid="received-list">
            {received.map((l) => (
              <IncomingCard key={l.id} slug={slug} link={l} canManage={canManageIn} digests={digestsFrom(items, l.fromSlug)} concepts={conceptsFromTeam(conceptList, l.fromTeamId)} onChanged={changed} />
            ))}
          </ul>
        ) : null}
      </section>

      {creating ? (
        <ShareDialog
          slug={slug}
          teams={others}
          taken={taken}
          onClose={() => setCreating(false)}
          onDone={(line) => {
            setWatchUntil(Date.now() + POLL_AFTER_CREATE_MS);
            changed(line);
          }}
        />
      ) : null}
    </div>
  );
}
