import { memo, type ReactNode } from 'react';
import { Link } from 'react-router';
import { parseMarkdown, type Block, type Inline } from './markdown';

/** Draws what `markdown.ts` read. Only React elements: message text never becomes HTML. External links open safely. */
function inline(nodes: Inline[], teamSlug: string | null, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return n.v;
      case 'br':
        return <br key={k} />;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'strong':
        return <strong key={k}>{inline(n.c, teamSlug, `${k}.`)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.c, teamSlug, `${k}.`)}</em>;
      case 'del':
        return <del key={k}>{inline(n.c, teamSlug, `${k}.`)}</del>;
      case 'link': {
        const local = n.href.startsWith('/');
        return local ? (
          <Link key={k} to={n.href}>{inline(n.c, teamSlug, `${k}.`)}</Link>
        ) : (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{inline(n.c, teamSlug, `${k}.`)}</a>
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

function blocks(list: Block[], teamSlug: string | null): ReactNode[] {
  return list.map((b, i) => {
    switch (b.t) {
      case 'p':
        return <p key={i}>{inline(b.c, teamSlug)}</p>;
      case 'heading':
        return <p key={i} className="md-heading" data-level={b.level}>{inline(b.c, teamSlug)}</p>;
      case 'code':
        return (
          <pre key={i} className="md-code" data-lang={b.lang || undefined} tabIndex={0}>
            <code>{b.v}</code>
          </pre>
        );
      case 'quote':
        return <blockquote key={i}>{blocks(b.c, teamSlug)}</blockquote>;
      case 'list': {
        const items = b.items.map((it, j) => <li key={j}>{inline(it, teamSlug)}</li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
    }
  });
}

export const Markdown = memo(function Markdown({ source, teamSlug = null }: { source: string; teamSlug?: string | null }) {
  return <div className="md">{blocks(parseMarkdown(source), teamSlug)}</div>;
});
