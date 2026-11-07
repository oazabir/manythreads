/**
 * What the bot is looking at while it writes ("Searching memory", "3 knowledge hits"). Fixed words and counts, never a document's text. It goes away with the
 * live preview; an Answer keeps its sources in its own card.
 */
export function LookedAt({ labels }: { labels: readonly string[] }) {
  if (labels.length === 0) return null;
  return (
    <ul className="ch-looked" aria-label="Looking at" data-testid="chat-looked-at">
      {labels.map((label) => (
        <li key={label} className="ch-looked-item">{label}</li>
      ))}
    </ul>
  );
}
