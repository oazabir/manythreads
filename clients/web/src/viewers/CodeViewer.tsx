import { useMemo } from 'react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { extensionOf } from '@manythreads/shared';
import type { ViewerProps } from '../kernel/viewers';
import { ViewerBar } from './common';

const LANGUAGES = { bash, css, diff, go, ini, javascript, json, python, rust, sql, typescript, xml, yaml };
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  py: 'python', go: 'go', rs: 'rust', sh: 'bash', bash: 'bash', sql: 'sql', diff: 'diff', patch: 'diff',
};

/** Above this the text is shown without colour: highlighting is linear but a megabyte of spans is not worth it. */
const HIGHLIGHT_LIMIT = 300_000;

export const languageFor = (path: string): string | null => BY_EXT[extensionOf(path)] ?? null;

/** Highlighted HTML (highlight.js escapes the source; the markup it adds is span tags with class names only). */
export function highlight(text: string, path: string): { html: string; language: string | null } {
  const language = languageFor(path);
  if (!language || text.length > HIGHLIGHT_LIMIT) return { html: escapeHtml(text), language };
  return { html: hljs.highlight(text, { language, ignoreIllegals: true }).value, language };
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Source code, read-only, highlighted. */
export default function CodeViewer({ path, text = '' }: ViewerProps) {
  const { html, language } = useMemo(() => highlight(text, path), [text, path]);
  return (
    <div className="vw code" data-testid="viewer-code" data-language={language ?? 'plain'}>
      <ViewerBar path={path}>
        <span className="vw-tag">{language ?? 'text'} · read-only</span>
      </ViewerBar>
      <pre className="code-pre" tabIndex={0} aria-label={`Source of ${path}`}>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
