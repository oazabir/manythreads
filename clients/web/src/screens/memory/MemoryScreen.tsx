import { useEffect, useState } from 'react';
import { useParams } from 'react-router';

interface ConceptSummary {
  path: string;
  type: string;
  title: string;
  description: string | null;
  tags: string[];
  status: string;
  trustTier: string;
  stale: boolean;
  deprecated: boolean;
  origin: string;
  fromTeam: string | null;
}

export function MemoryScreen() {
  const { team } = useParams<{ team: string }>();
  const [concepts, setConcepts] = useState<ConceptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!team) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/teams/${encodeURIComponent(team)}/memory/concepts`, { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as ConceptSummary[];
      })
      .then((data) => {
        if (!cancelled) setConcepts(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [team]);

  if (loading) return <div className="view-empty" aria-busy="true" />;
  if (error) return <div className="view-empty">Could not load memory concepts: {error}</div>;

  return (
    <section className="mm-screen">
      <header className="mm-header">
        <h1 className="mm-title">Memory</h1>
        <p className="mm-subtitle">The team's OKF memory bundle — concepts, trust tiers, and provenance.</p>
      </header>
      {concepts.length === 0 ? (
        <div className="view-empty">No concepts yet. Drop a file into the team's inbox or ask a bot to write one.</div>
      ) : (
        <ul className="mm-tree">
          {concepts.map((c) => (
            <li key={c.path} className="mm-concept">
              <span className="mm-concept-path">{c.path}</span>
              <span className="mm-chip mm-chip-type">{c.type}</span>
              <span className={`mm-chip mm-chip-trust mm-trust-${c.trustTier}`}>{c.trustTier}</span>
              {c.stale && <span className="mm-chip mm-chip-stale">stale</span>}
              {c.status === 'deprecated' && <span className="mm-chip mm-chip-deprecated">deprecated</span>}
              {c.fromTeam && <span className="mm-chip mm-chip-from">from {c.fromTeam}'s digest</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default MemoryScreen;