import { memo, useState, type ReactNode } from 'react';
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
const NONE: ReadonlySet<number> = new Set();

/** Splits a run of text at `[n]` markers; linear in the text (one pass, no backtracking). */
function withMarkers(text: string, marker: CitationMarker, key: string, cited: ReadonlySet<number>): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  let count = 0;
  for (const m of text.matchAll(MARKER)) {
    const n = Number(m[1]);
    // only the answer's own numbers are markers; any other `[n]` stays the text it was written as
    if (!cited.has(n)) continue;
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(marker(n, `${key}m${count}`));
    count += 1;
    last = at + m[0].length;
  }
  if (count === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Draws what `markdown.ts` read. Only React elements: message text never becomes HTML. External links open safely. */
function inline(nodes: Inline[], teamSlug: string | null, key = '', marker?: CitationMarker, cited: ReadonlySet<number> = NONE): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return marker ? <span key={k} className="an-run">{withMarkers(n.v, marker, k, cited)}</span> : n.v;
      case 'br':
        return <br key={k} />;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'strong':
        return <strong key={k}>{inline(n.c, teamSlug, `${k}.`, marker, cited)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.c, teamSlug, `${k}.`, marker, cited)}</em>;
      case 'del':
        return <del key={k}>{inline(n.c, teamSlug, `${k}.`, marker, cited)}</del>;
      case 'link': {
        const local = n.href.startsWith('/');
        return local ? (
          <Link key={k} to={n.href}>{inline(n.c, teamSlug, `${k}.`, marker, cited)}</Link>
        ) : (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer nofollow">{inline(n.c, teamSlug, `${k}.`, marker, cited)}</a>
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

/** A code block: the language label, a Copy button, and the code in monospace that scrolls sideways instead of wrapping. */
function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(code);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
      } catch {
        // the clipboard may be blocked; the text stays selectable in the block
      }
    })();
  };
  return (
    <div className="md-codeblock" data-testid="md-codeblock">
      <div className="md-codebar">
        <span className="md-codelang">{lang || 'text'}</span>
        <button type="button" className="md-copy" onClick={copy} aria-label="Copy code" data-testid="md-copy">{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <pre className="md-code" data-lang={lang || undefined} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** What a tick does when the text may be edited: the number of the box among all the boxes of the text, and the new state. */
export type TaskToggle = (nth: number, checked: boolean) => void;

function blocks(list: Block[], teamSlug: string | null, marker?: CitationMarker, cited: ReadonlySet<number> = NONE, toggle?: TaskToggle, counter: { n: number } = { n: 0 }): ReactNode[] {
  return list.map((b, i) => {
    switch (b.t) {
      case 'p':
        return <p key={i}>{inline(b.c, teamSlug, '', marker, cited)}</p>;
      case 'heading':
        return <p key={i} className="md-heading" data-level={b.level}>{inline(b.c, teamSlug, '', marker, cited)}</p>;
      case 'code':
        return <CodeBlock key={i} lang={b.lang} code={b.v} />;
      case 'quote':
        return <blockquote key={i}>{blocks(b.c, teamSlug, marker, cited, toggle, counter)}</blockquote>;
      case 'list': {
        if (b.checks) {
          const done = b.checks.filter((c) => c === true).length;
          const total = b.checks.filter((c) => c !== null).length;
          return (
            <div key={i} className="md-tasklist" data-testid="md-tasklist">
              <p className="md-taskcount">{done} of {total} done</p>
              <ul className="md-tasks">
                {b.items.map((it, j) => {
                  const box = b.checks?.[j] ?? null;
                  const nth = box === null ? -1 : counter.n++;
                  return (
                    <li key={j} className={box === true ? 'md-task done' : 'md-task'} data-checked={box === null ? undefined : String(box)}>
                      {box === null ? null : (
                        <input type="checkbox" className="md-task-box" checked={box} disabled={!toggle} onChange={(e) => toggle?.(nth, e.target.checked)} aria-label={box ? 'Done' : 'Not done'} />
                      )}
                      <span className="md-task-text">{inline(it, teamSlug, '', marker, cited)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        }
        const items = b.items.map((it, j) => <li key={j}>{inline(it, teamSlug, '', marker, cited)}</li>);
        return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
    }
  });
}

export const Markdown = memo(function Markdown({ source, teamSlug = null, marker, cited, toggle }: { source: string; teamSlug?: string | null; marker?: CitationMarker; /** The citation numbers a `[n]` may become; none when absent. */ cited?: ReadonlySet<number>; /** When given, the boxes of a task list can be ticked; each tick calls it. Absent: the boxes are shown, not changeable. */ toggle?: TaskToggle }) {
  return <div className="md">{blocks(read(source), teamSlug, marker, cited, toggle)}</div>;
});
