import { memo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { parseMarkdown, type Block, type Inline } from './markdown';

/** Parsed messages by their text: scrolling back over a row does not parse it again. Bounded, oldest out first. */
const parsed = new Map<string, Block[]>();
function read(source: string): Block[] {
  const hit = parsed.get(source);
  if (hit) return hit;
  const tree = parseMarkdown(source);
  parsed.set(source, tree);
  if (parsed.size > 3_000) parsed.delete(parsed.keys().next().value as string);
  return tree;
}

/** Draws the number of a citation in place of `[3]` in the text of an answer (`Answer.tsx`); everything else in the message is as written. */
export type CitationMarker = (n: number, key: string) => ReactNode;

const MARKER = /\[(\d{1,3})\]/g;

/** Splits a run of text at `[n]` markers; linear in the text (one pass, no backtracking). */
function withMarkers(text: string, marker: CitationMarker, key: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(marker(Number(m[1]), `${key}m${count}`));
    count += 1;
    last = at + m[0].length;
  }
  if (count === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Draws what `markdown.ts` read. Only React elements: message text never becomes HTML. External links open safely. */
function inline(nodes: Inline[], teamSlug: string | null, key = '', marker?: CitationMarker): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return marker ? <span key={k} className="an-run">{withMarkers(n.v, marker, k)}</span> : n.v;
      case 'br':
        return <br key={k} />;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'strong':
        return <strong key={k}>{inline(n.c, teamSlug, `${k}.`, marker)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.c, teamSlug, `${k}.`, marker)}</em>;
      case 'del':
        return <del key={k}>{inline(n.c, teamSlug, `${k}.`, marker)}</del>;
      case 'link': {
        const local = n.href.startsWith('/');
        return local ? (
          <Link key={k} to={n.href}>{inline(n.c, teamSlug, `${k}.`, marker)}</Link>
        ) : (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{inline(n.c, teamSlug, `${k}.`, marker)}</a>
        );
      }
      case 'mention':
        return <span key={k} className="m" data-mention={n.handle.toLowerCase()}>{`@${n.handle}`}</span>;
      case 'channel':
        return teamSlug ? (
          <Link key={k} className="chref" to={`/t/${encodeURIComponent(teamSlug)}/c/${encodeURIComponent(n.name.toLowerCase())}`}>{`#${n.name}`}</Link>
        ) : (
          <span key={k} className="chref">{`#${n.name}`}</span>
        );
    }
  });
}

function blocks(list: Block[], teamSlug: string | null, marker?: CitationMarker): ReactNode[] {
  return list.map((b, i) => {
    switch (b.t) {
      case 'p':
        return <p key={i}>{inline(b.c, teamSlug, '', marker)}</p>;
      case 'heading':
        return <p key={i} className="md-heading" data-level={b.level}>{inline(b.c, teamSlug, '', marker)}</p>;
      case 'code':
        return (
          <pre key={i} className="md-code" data-lang={b.lang || undefined} tabIndex={0}>
            <code>{b.v}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(b.c, teamSlug, marker)}</blockquote>;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{inline(it, teamSlug, '', marker)}</li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
    }
  });
}

export const Markdown = memo(function Markdown({ source, teamSlug = null, marker }: { source: string; teamSlug?: string | null; marker?: CitationMarker }) {
  return <div className="md">{blocks(read(source), teamSlug, marker)}</div>;
});
