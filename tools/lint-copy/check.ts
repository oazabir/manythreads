import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Copy lint (P21-13): finds words in the web client's visible text that a person should not have to read — file paths, dotted
 * setting names, snake_case names, product file names and internal terms. It reads every `.tsx` file with the TypeScript parser and
 * looks only at text that can reach the screen: JSX text, string pieces inside JSX, and the attributes and object properties that
 * hold labels. Text inside `<code>`, `<pre>` and `<kbd>` is skipped (it is shown as a command or a name on purpose).
 */

export type CopyRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7';
export type CopyFinding = { file: string; line: number; rule: CopyRule; text: string };
export type AllowEntry = { file: string; text: string; why: string };

const ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt', 'label', 'hint', 'lede', 'description', 'emptyState', 'count', 'body']);
const PROPS = new Set(['label', 'hint', 'title', 'body', 'description', 'emptyState']);
const SKIP_TAGS = new Set(['code', 'pre', 'kbd']);
const SKIP_ATTRS = new Set(['className', 'key', 'to', 'href', 'id', 'type', 'value', 'name', 'role', 'htmlFor']);

const RULES: { rule: CopyRule; re: RegExp }[] = [
  { rule: 'R1', re: /`[A-Za-z][\w.-]*`/ },
  { rule: 'R2', re: /\b[\w-]+(?:\/[\w.-]+)*\/[\w-]+\.(?:md|ts|tsx|json|ya?ml)\b|\b[\w-]+\.(?:md|json|ya?ml)\b|\b(?:bots|skills|routines|memory|inbox)\/[\w.-]*/ },
  { rule: 'R3', re: /\b[a-z][a-z]+\.[a-z]+[A-Z][A-Za-z]*\b|\b[a-z][a-z0-9]*\.[a-z][a-z0-9]*\.[a-z][a-z0-9]*\b/ },
  { rule: 'R4', re: /\b[a-z]+(?:_[a-z0-9]+)+\b/ },
  { rule: 'R5', re: /\b(?:BOT|TEAM|SKILL)\.md\b/ },
  { rule: 'R6', re: /\b(?:10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|localhost:\d+|127\.0\.0\.1)/ },
  { rule: 'R7', re: /\b(?:OKF|RLS|outbox|allowlist|broker|slug|frontmatter|DLP|loader)\b/i },
];

/** A web address (api.github.com) is not a setting name, so R3 leaves it alone. */
const HOST_END = /\.(?:com|org|net|io|dev|ai|to|app|cloud)$/;

/** The rules a piece of text breaks (the first match of each). */
export function copyIssues(text: string): { rule: CopyRule; text: string }[] {
  const out: { rule: CopyRule; text: string }[] = [];
  for (const { rule, re } of RULES) {
    const m = re.exec(text);
    if (m && !(rule === 'R3' && HOST_END.test(m[0]))) out.push({ rule, text: m[0] });
  }
  return out;
}

function tagName(el: ts.Node): string {
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : ts.isJsxSelfClosingElement(el) ? el.tagName : null;
  return tag ? tag.getText() : '';
}

/** Findings for one source text (a `.tsx` file). */
export function lintSource(file: string, source: string): CopyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: CopyFinding[] = [];
  const add = (node: ts.Node, text: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    for (const f of copyIssues(text)) out.push({ file, line, rule: f.rule, text: f.text });
  };
  /** Strings reached from an expression: literals, template pieces, both ternary branches, `a || 'x'`. */
  const strings = (node: ts.Node, visit: (n: ts.Node, t: string) => void): void => {
    if (ts.isStringLiteralLike(node)) visit(node, node.text);
    else if (ts.isTemplateExpression(node)) {
      visit(node.head, node.head.text);
      for (const s of node.templateSpans) visit(s.literal, s.literal.text);
    } else if (ts.isConditionalExpression(node)) {
      strings(node.whenTrue, visit);
      strings(node.whenFalse, visit);
    } else if (ts.isBinaryExpression(node)) {
      strings(node.right, visit);
    } else if (ts.isParenthesizedExpression(node)) strings(node.expression, visit);
  };
  const walk = (node: ts.Node, skipped: boolean): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (SKIP_TAGS.has(tagName(node))) return;
    }
    if (!skipped) {
      if (ts.isJsxText(node)) add(node, node.text);
      else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
        strings(node.expression, add);
      } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) || ts.isJsxAttribute(node) && ts.isJsxNamespacedName(node.name)) {
        const name = node.name.getText(sf);
        if (ATTRS.has(name) && !SKIP_ATTRS.has(name) && node.initializer) {
          if (ts.isStringLiteral(node.initializer)) add(node.initializer, node.initializer.text);
          else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) strings(node.initializer.expression, add);
        }
      } else if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && PROPS.has(node.name.text)) {
        strings(node.initializer, add);
      }
    }
    ts.forEachChild(node, (c) => walk(c, skipped));
  };
  walk(sf, false);
  return out;
}

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Findings for every `.tsx` file under `webSrc`, with allow-listed ones removed. File names are relative to `root`. */
export function lintTree(root: string, webSrc: string, allow: AllowEntry[]): { findings: CopyFinding[]; unused: AllowEntry[] } {
  const all: CopyFinding[] = [];
  for (const f of tsxFiles(webSrc)) all.push(...lintSource(relative(root, f), readFileSync(f, 'utf8')));
  const used = new Set<AllowEntry>();
  const findings = all.filter((f) => {
    const hit = allow.find((a) => a.file === f.file && f.text.includes(a.text));
    if (hit) used.add(hit);
    return !hit;
  });
  return { findings, unused: allow.filter((a) => !used.has(a)) };
}
