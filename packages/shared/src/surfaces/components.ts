import { z } from 'zod';
import { createSurfaceRegistry, defineSurfaceComponent } from './registry.ts';

// The parts every client draws today. P9-05 adds the rest of the primitives (Row, Grid, Stat, Table, Chart, List, Badge, Button, Callout, Code, Divider) and the
// manythreads parts (EntityCard, PersonChip, ChannelLink, ApprovalCard, DiffView) here, one definition each; the web client adds a drawing for each name.

const Gap = z.enum(['none', 'small', 'medium', 'large']);

/** Parts laid out one under the other. */
export const StackComponent = defineSurfaceComponent({
  name: 'Stack',
  summary: 'Puts its children one under the other.',
  args: ['children', 'gap'],
  children: 'children',
  props: z.object({ gap: Gap.optional() }),
});

/** A title. */
export const HeadingComponent = defineSurfaceComponent({
  name: 'Heading',
  summary: 'A title. Level 1 is the largest, 3 the smallest.',
  args: ['text', 'level'],
  props: z.object({ text: z.string().min(1).max(300), level: z.number().int().min(1).max(3).optional() }),
});

/** A paragraph of plain text. */
export const TextComponent = defineSurfaceComponent({
  name: 'Text',
  summary: 'A paragraph of plain text. Nothing in it is read as markup.',
  args: ['text', 'tone'],
  props: z.object({ text: z.string().max(5000), tone: z.enum(['normal', 'muted', 'strong']).optional() }),
});

/**
 * A button. Pressing it sends the bot one `press` event naming this part and nothing else: the payload is empty, so a viewer cannot make a press carry a value
 * the bot did not offer (the bot knows what each button means by the name it gave the part). The first part that can be answered (PLAN P9-04); P9-05 gives it
 * company and may widen it.
 */
export const ButtonComponent = defineSurfaceComponent({
  name: 'Button',
  summary: 'A button. When a person presses it you get one "press" event naming this part. Give each button its own name so you can tell them apart.',
  args: ['label', 'tone'],
  props: z.object({ label: z.string().min(1).max(80), tone: z.enum(['normal', 'primary']).optional() }),
  events: { press: z.object({}) },
});

/** Every part a surface may use today. */
export const SURFACE_COMPONENTS = [StackComponent, HeadingComponent, TextComponent, ButtonComponent] as const;

/** The registry the web client and the server use. */
export const SURFACE_REGISTRY = createSurfaceRegistry(SURFACE_COMPONENTS);
