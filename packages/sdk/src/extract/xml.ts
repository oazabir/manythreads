// A small XML scanner for the Office readers (PLAN P8-16). Pure and linear: one left-to-right pass, no recursion, no tree, no entity table beyond the five
// predefined names and numeric references. That makes the classic attacks impossible by construction: a DOCTYPE or an ENTITY declaration is skipped as
// text that is never expanded (no billion laughs, no external entity), and nesting is a counter, so a million nested elements cost a million steps and
// no stack. A tag that does not close within `MAX_TAG_CHARS` is text, so a long run of `<` is scanned once, not once per `<`.

const MAX_TAG_CHARS = 8_192;

export interface XmlHandlers {
  /** An opening tag (also called for a self-closing one, with `selfClosed` true). `name` is as written, with its prefix (`w:p`); `attrs` is the raw text after the name. */
  open?(name: string, attrs: string, selfClosed: boolean): void;
  close?(name: string): void;
  /** Character data between tags, with entities decoded. */
  text?(text: string): void;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decodes the five predefined entities and numeric references. Anything else (including a named entity a document declared) stays as written. */
export function decodeXmlEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code < 0xe000)) return ' ';
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

/** The value of attribute `name` in the raw attribute text of one tag, or null. Bounded by the tag, which is bounded by `MAX_TAG_CHARS`. */
export function xmlAttr(attrs: string, name: string): string | null {
  let from = 0;
  for (;;) {
    const at = attrs.indexOf(name, from);
    if (at === -1) return null;
    from = at + name.length;
    const before = at === 0 ? ' ' : attrs.charAt(at - 1);
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') continue;
    let i = from;
    while (attrs.charAt(i) === ' ') i += 1;
    if (attrs.charAt(i) !== '=') continue;
    i += 1;
    while (attrs.charAt(i) === ' ') i += 1;
    const quote = attrs.charAt(i);
    if (quote !== '"' && quote !== "'") continue;
    const end = attrs.indexOf(quote, i + 1);
    if (end === -1) return null;
    return decodeXmlEntities(attrs.slice(i + 1, end));
  }
}

/** Reads `src` once. Stops early when a handler returns by setting `state.stop` (the handlers close over their own state; `shouldStop` is polled between tags). */
export function scanXml(src: string, handlers: XmlHandlers, shouldStop: () => boolean = () => false): void {
  let pos = 0;
  const n = src.length;
  // the nearest ">" ahead of a "<", remembered so a run of "<" with no ">" is looked up once
  let gtAt = -1;
  let gtGone = false;
  while (pos < n) {
    if (shouldStop()) return;
    const lt = src.indexOf('<', pos);
    if (lt === -1) {
      handlers.text?.(decodeXmlEntities(src.slice(pos)));
      return;
    }
    if (lt > pos) handlers.text?.(decodeXmlEntities(src.slice(pos, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      pos = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      handlers.text?.(src.slice(lt + 9, end === -1 ? n : end));
      pos = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      pos = end === -1 ? n : end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // a DOCTYPE (with an internal subset in square brackets) or another declaration: skipped, never expanded
      const bracket = src.indexOf('[', lt);
      const gt = src.indexOf('>', lt);
      if (gt === -1) {
        pos = n;
        continue;
      }
      if (bracket !== -1 && bracket < gt) {
        const close = src.indexOf(']>', bracket);
        pos = close === -1 ? n : close + 2;
      } else pos = gt + 1;
      continue;
    }
    if (!gtGone && gtAt <= lt) {
      gtAt = src.indexOf('>', lt + 1);
      if (gtAt === -1) gtGone = true;
    }
    const gt = gtGone ? -1 : gtAt;
    if (gt === -1 || gt - lt > MAX_TAG_CHARS) {
      handlers.text?.('<');
      pos = lt + 1;
      continue;
    }
    pos = gt + 1;
    const closing = src.charAt(lt + 1) === '/';
    const selfClosed = src.charAt(gt - 1) === '/';
    const inner = src.slice(lt + (closing ? 2 : 1), selfClosed ? gt - 1 : gt);
    let nameEnd = 0;
    while (nameEnd < inner.length) {
      const c = inner.charCodeAt(nameEnd);
      if (c === 32 || c === 9 || c === 10 || c === 13) break;
      nameEnd += 1;
    }
    const name = inner.slice(0, nameEnd);
    if (name.length === 0) continue;
    if (closing) handlers.close?.(name);
    else {
      handlers.open?.(name, inner.slice(nameEnd), selfClosed);
      if (selfClosed) handlers.close?.(name);
    }
  }
}
