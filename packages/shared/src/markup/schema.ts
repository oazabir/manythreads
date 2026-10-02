import { z } from 'zod';

/** Offsets are UTF-16 code-unit indices into the markdown string (what `String.prototype.slice` uses); `end` is exclusive. */
const Span = { start: z.number().int().nonnegative(), end: z.number().int().positive() };

/** `@handle`: the span covers the `@`, `handle` does not. `kind` is `bot` only for handles the caller passed in `botHandles`. */
export const MarkupMention = z.object({ kind: z.enum(['person', 'bot']), handle: z.string().min(1).max(64), ...Span });
export type MarkupMention = z.infer<typeof MarkupMention>;

/** `#name`: the span covers the `#`, `name` does not and keeps the case it was typed in. */
export const MarkupChannelRef = z.object({ name: z.string().min(1).max(64), ...Span });
export type MarkupChannelRef = z.infer<typeof MarkupChannelRef>;

export const MARKUP_ENTITY_TYPES = ['thread', 'file', 'page', 'task'] as const;
export const MarkupEntityType = z.enum(MARKUP_ENTITY_TYPES);
export type MarkupEntityType = z.infer<typeof MarkupEntityType>;

/** `[[type:id]]`. `id` is a lower-case uuid for thread/file, a task id, or a repo-relative page path. */
export const MarkupEntityRef = z.object({ type: MarkupEntityType, id: z.string().min(1).max(512), ...Span });
export type MarkupEntityRef = z.infer<typeof MarkupEntityRef>;

export const MARKUP_TOKEN_TYPES = ['text', 'code_block', 'code_span', 'url', 'mention', 'channel', 'entity_ref'] as const;
export const MarkupTokenType = z.enum(MARKUP_TOKEN_TYPES);
export type MarkupTokenType = z.infer<typeof MarkupTokenType>;

/** The tokens tile the whole input: sorted, no gaps, no overlaps. `code_block`, `code_span` and `url` are inert for mentions. */
export const MarkupToken = z.object({ type: MarkupTokenType, ...Span });
export type MarkupToken = z.infer<typeof MarkupToken>;

export const MarkupParseResult = z.object({
  tokens: z.array(MarkupToken),
  mentions: z.array(MarkupMention),
  channels: z.array(MarkupChannelRef),
  entityRefs: z.array(MarkupEntityRef),
});
export type MarkupParseResult = z.infer<typeof MarkupParseResult>;
