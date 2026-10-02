import { useEffect, useState, type ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';

/*
 * The rendered Markdown diff: both versions are read with the editor's own parser, split into their top-level blocks, and the blocks are
 * compared (a longest common subsequence over a block's JSON). What was taken out is shown struck through on a red wash, what came in on a green wash,
 * the rest as it reads. Drawn with React elements from the document tree: nothing becomes HTML, so page text can never run.
 */

type Block = { node: JSONContent; key: string };
type Part = { type: 'same' | 'add' | 'del'; node: JSONContent };

const keyOf = (n: JSONContent): string => JSON.stringify(n);

export function diffBlocks(before: JSONContent[], after: JSONContent[]): Part[] {
  const a: Block[] = before.map((node) => ({ node, key: keyOf(node) }));
  const b: Block[] = after.map((node) => ({ node, key: keyOf(node) }));
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i * w + j] = a[i]?.key === b[j]?.key ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
  const out: Part[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]?.key === b[j]?.key) {
      out.push({ type: 'same', node: (b[j] as Block).node });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
      out.push({ type: 'del', node: (a[i] as Block).node });
      i++;
    } else {
      out.push({ type: 'add', node: (b[j] as Block).node });
      j++;
    }
  }
  return out;
}

function inline(nodes: JSONContent[] | undefined): ReactNode {
  return (nodes ?? []).map((n, i) => {
    if (n.type === 'hardBreak') return <br key={i} />;
    let el: ReactNode = n.text ?? '';
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') el = <strong key={`b${i}`}>{el}</strong>;
      else if (m.type === 'italic') el = <em key={`i${i}`}>{el}</em>;
      else if (m.type === 'strike') el = <s key={`s${i}`}>{el}</s>;
      else if (m.type === 'code') el = <code key={`c${i}`}>{el}</code>;
    }
    return <span key={i}>{el}</span>;
  });
}

function blockOf(n: JSONContent, k: string): ReactNode {
  const kids = (): ReactNode => (n.content ?? []).map((c, i) => blockOf(c, `${k}.${i}`));
  switch (n.type) {
    case 'paragraph': return <p key={k}>{inline(n.content)}</p>;
    case 'heading': {
      const level = Math.min(6, Math.max(1, Number(n.attrs?.['level'] ?? 2)));
      const H = `h${level}` as 'h1';
      return <H key={k}>{inline(n.content)}</H>;
    }
    case 'bulletList': return <ul key={k}>{kids()}</ul>;
    case 'orderedList': return <ol key={k}>{kids()}</ol>;
    case 'taskList': return <ul key={k} className="tasks">{kids()}</ul>;
    case 'listItem': return <li key={k}>{kids()}</li>;
    case 'taskItem': return <li key={k}>{n.attrs?.['checked'] ? '☑ ' : '☐ '}{kids()}</li>;
    case 'blockquote': return <blockquote key={k}>{kids()}</blockquote>;
    case 'codeBlock': return <pre key={k}><code>{(n.content ?? []).map((c) => c.text ?? '').join('')}</code></pre>;
    case 'horizontalRule': return <hr key={k} />;
    case 'table': return <table key={k}><tbody>{kids()}</tbody></table>;
    case 'tableRow': return <tr key={k}>{kids()}</tr>;
    case 'tableHeader': return <th key={k}>{kids()}</th>;
    case 'tableCell': return <td key={k}>{kids()}</td>;
    default: return n.content ? <div key={k}>{kids()}</div> : <p key={k}>{n.text ?? ''}</p>;
  }
}

export function RenderedDiff({ before, after }: { before: string | null; after: string | null }) {
  const [parts, setParts] = useState<Part[] | null>(null);
  useEffect(() => {
    let live = true;
    void import('../../viewers/markdown/codec').then(({ bodyToDoc }) => {
      if (!live) return;
      const a = before === null ? [] : (bodyToDoc(before).doc.content ?? []);
      const b = after === null ? [] : (bodyToDoc(after).doc.content ?? []);
      setParts(diffBlocks(a, b));
    });
    return () => {
      live = false;
    };
  }, [before, after]);
  if (!parts) return <p className="loading" aria-busy="true">Loading…</p>;
  if (parts.every((p) => p.type === 'same')) return <p className="vw-note">No visible change in the text of this page.</p>;
  return (
    <div className="rdiff md-prose" data-testid="rendered-diff">
      {parts.map((p, i) => (
        <div key={i} className={`rd ${p.type}`} data-change={p.type}>
          {blockOf(p.node, String(i))}
        </div>
      ))}
    </div>
  );
}
