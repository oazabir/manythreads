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

/** Every part a surface may use today. */
export const SURFACE_COMPONENTS = [StackComponent, HeadingComponent, TextComponent] as const;

/** The registry the web client and the server use. */
export const SURFACE_REGISTRY = createSurfaceRegistry(SURFACE_COMPONENTS);
