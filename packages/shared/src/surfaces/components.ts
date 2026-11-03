import { z } from 'zod';
import { createSurfaceRegistry, defineSurfaceComponent } from './registry.ts';

// The parts every client draws (PLAN P9-02, P9-05): the primitives (Stack, Row, Grid, Heading, Text, Stat, Table, Chart, List, Badge, Button, Callout, Code,
// Divider) and the manythreads parts (EntityCard, PersonChip, ChannelLink, ApprovalCard, DiffView), one definition each; the web client adds a drawing for
// each name (clients/web/src/surfaces/views.tsx). Every value is checked here, with a size cap on everything a bot can make long: a part's values may not
// exceed SURFACE_MAX_PROP_CHARS in all (openui.ts), so the caps below sit under that on purpose. Text, Stat, Table, Chart, List and Badge can be bound to data
// (`bindable`, PLAN P9-06, ./bind.ts): their values are filled from a read tool as the viewer, and judged by the same schema. No value is ever an address, an image or markup: the
// manythreads parts take an id and a label, and the client looks the id up as the person who is looking.

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
  bindable: ['text'],
});

const Tone = z.enum(['neutral', 'good', 'warn', 'bad', 'info']);
/** An id of a thing in manythreads. Only letters, digits and `_ . : -`, so it can never be an address or markup. */
const EntityId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/, 'must be an id (letters, digits and _ . : -)');
/** A name or title shown for an id when this app cannot look it up. */
const Label = z.string().min(1).max(120);

/** Parts laid out side by side; they wrap when the line is full. */
export const RowComponent = defineSurfaceComponent({
  name: 'Row',
  summary: 'Puts its children side by side. They wrap onto the next line when there is no room.',
  args: ['children', 'gap', 'align'],
  children: 'children',
  props: z.object({ gap: Gap.optional(), align: z.enum(['start', 'center', 'end', 'between']).optional() }),
});

/** Parts in equal columns. */
export const GridComponent = defineSurfaceComponent({
  name: 'Grid',
  summary: 'Puts its children in 1 to 4 equal columns (default 2). On a narrow screen it uses one column.',
  args: ['children', 'columns', 'gap'],
  children: 'children',
  props: z.object({ columns: z.number().int().min(1).max(4).optional(), gap: Gap.optional() }),
});

/** One number with its name. */
export const StatComponent = defineSurfaceComponent({
  name: 'Stat',
  summary: 'One figure with its name and, if you like, how it changed ("+4%").',
  args: ['label', 'value', 'delta', 'tone'],
  props: z.object({
    label: z.string().min(1).max(80),
    value: z.union([z.string().min(1).max(40), z.number().finite()]),
    delta: z.string().min(1).max(40).optional(),
    tone: Tone.optional(),
  }),
  bindable: ['value', 'delta'],
});

export const TABLE_MAX_COLUMNS = 10;
export const TABLE_MAX_ROWS = 50;
const Cell = z.union([z.string().max(300), z.number().finite(), z.boolean(), z.null()]);

/** Rows and columns of plain values. */
export const TableComponent = defineSurfaceComponent({
  name: 'Table',
  summary: `A table: the column names, then the rows (each a list of values in column order). At most ${TABLE_MAX_COLUMNS} columns and ${TABLE_MAX_ROWS} rows.`,
  args: ['columns', 'rows', 'caption'],
  props: z
    .object({
      columns: z.array(z.string().min(1).max(60)).min(1).max(TABLE_MAX_COLUMNS),
      rows: z.array(z.array(Cell).max(TABLE_MAX_COLUMNS)).max(TABLE_MAX_ROWS),
      caption: z.string().min(1).max(200).optional(),
    })
    .refine((p) => p.rows.every((r) => r.length <= p.columns.length), { message: 'a row has more values than there are columns', path: ['rows'] }),
  bindable: ['columns', 'rows'],
});

export const CHART_MAX_POINTS = 40;

/** A bar or line chart of numbers. */
export const ChartComponent = defineSurfaceComponent({
  name: 'Chart',
  summary: `A bar or line chart of one series: a name for each point and its number (same count, at most ${CHART_MAX_POINTS}). It always comes with a table of the same numbers.`,
  args: ['kind', 'labels', 'values', 'title', 'unit'],
  props: z
    .object({
      kind: z.enum(['bar', 'line']),
      labels: z.array(z.string().min(1).max(60)).min(1).max(CHART_MAX_POINTS),
      values: z.array(z.number().finite().min(-1e12).max(1e12)).min(1).max(CHART_MAX_POINTS),
      title: z.string().min(1).max(120).optional(),
      unit: z.string().min(1).max(20).optional(),
    })
    .refine((p) => p.labels.length === p.values.length, { message: 'needs one label for each value', path: ['labels'] }),
  bindable: ['labels', 'values'],
});

/** A bulleted or numbered list of plain lines. */
export const ListComponent = defineSurfaceComponent({
  name: 'List',
  summary: 'A list of plain lines, bulleted or (with ordered) numbered. At most 100 items.',
  args: ['items', 'ordered'],
  props: z.object({ items: z.array(z.string().min(1).max(500)).min(1).max(100), ordered: z.boolean().optional() }),
  bindable: ['items'],
});

/** A short coloured label. */
export const BadgeComponent = defineSurfaceComponent({
  name: 'Badge',
  summary: 'A short coloured label ("Open", "Late").',
  args: ['text', 'tone'],
  props: z.object({ text: z.string().min(1).max(40), tone: Tone.optional() }),
  bindable: ['text'],
});

/**
 * A button. Pressing it sends the bot one `press` event naming this part and nothing else: the payload is empty, so a viewer cannot make a press carry a value
 * the bot did not offer (the bot knows what each button means by the name it gave the part). The first part that can be answered (PLAN P9-04).
 */
export const ButtonComponent = defineSurfaceComponent({
  name: 'Button',
  summary: 'A button. When a person presses it you get one "press" event naming this part. Give each button its own name so you can tell them apart.',
  args: ['label', 'tone'],
  props: z.object({ label: z.string().min(1).max(80), tone: z.enum(['normal', 'primary']).optional() }),
  events: { press: z.object({}) },
});

/** A highlighted note. */
export const CalloutComponent = defineSurfaceComponent({
  name: 'Callout',
  summary: 'A highlighted note with an optional title.',
  args: ['text', 'tone', 'title'],
  props: z.object({ text: z.string().min(1).max(2000), tone: Tone.optional(), title: z.string().min(1).max(120).optional() }),
});

/** Text in a fixed-width font. */
export const CodeComponent = defineSurfaceComponent({
  name: 'Code',
  summary: 'Text in a fixed-width font, exactly as written (at most 8,000 characters). It is not run and gets no colouring.',
  args: ['code', 'language'],
  props: z.object({
    code: z.string().min(1).max(8000),
    language: z.string().regex(/^[a-z0-9][a-z0-9+#._-]{0,19}$/, 'must be a short lower case name such as "ts"').optional(),
  }),
});

/** A thin line between parts. */
export const DividerComponent = defineSurfaceComponent({
  name: 'Divider',
  summary: 'A thin line between two parts.',
  args: [],
  props: z.object({}),
});

/** Something in manythreads (a task, a page, a file ...) shown as a card. The client looks the id up as the viewer; the label is only the fallback. */
export const EntityCardComponent = defineSurfaceComponent({
  name: 'EntityCard',
  summary: 'A card for one thing in manythreads, by its kind and id. The label is shown only when the app cannot look the thing up for the person looking.',
  args: ['entityType', 'id', 'label', 'summary'],
  props: z.object({
    entityType: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/, 'must be a lower case kind such as "task" or "page"'),
    id: EntityId,
    label: Label,
    summary: z.string().min(1).max(300).optional(),
  }),
});

/** A person, by id. */
export const PersonChipComponent = defineSurfaceComponent({
  name: 'PersonChip',
  summary: 'A small chip for a person, by id. The label is shown only when the app cannot look the person up for the one looking.',
  args: ['id', 'label'],
  props: z.object({ id: EntityId, label: Label }),
});

/** A channel, by id. */
export const ChannelLinkComponent = defineSurfaceComponent({
  name: 'ChannelLink',
  summary: 'A link to a channel, by id. The label is shown only when the app cannot look the channel up for the one looking.',
  args: ['id', 'label'],
  props: z.object({ id: EntityId, label: Label }),
});

/** A request waiting for a person to decide. It never decides: the person decides in the approvals list. */
export const ApprovalCardComponent = defineSurfaceComponent({
  name: 'ApprovalCard',
  summary: 'Shows a request that waits for a person, by its approval id. It has no buttons that decide; the decision is made in the approvals list.',
  args: ['approvalId', 'title', 'summary'],
  props: z.object({ approvalId: EntityId, title: z.string().min(1).max(120), summary: z.string().min(1).max(1000).optional() }),
});

export const DIFF_MAX_CHARS = 16_000;
export const DIFF_MAX_LINES = 400;

/** A unified diff shown line by line. */
export const DiffViewComponent = defineSurfaceComponent({
  name: 'DiffView',
  summary: `A unified diff (the text a version-control "diff" prints), shown line by line with added and removed lines coloured. At most ${DIFF_MAX_LINES} lines and ${DIFF_MAX_CHARS} characters.`,
  args: ['diff', 'title'],
  props: z.object({
    diff: z
      .string()
      .min(1)
      .max(DIFF_MAX_CHARS)
      .refine((d) => d.split('\n').length <= DIFF_MAX_LINES, { message: `has more than ${DIFF_MAX_LINES} lines` }),
    title: z.string().min(1).max(200).optional(),
  }),
});

/** Every part a surface may use. */
export const SURFACE_COMPONENTS = [
  StackComponent,
  RowComponent,
  GridComponent,
  HeadingComponent,
  TextComponent,
  StatComponent,
  TableComponent,
  ChartComponent,
  ListComponent,
  BadgeComponent,
  ButtonComponent,
  CalloutComponent,
  CodeComponent,
  DividerComponent,
  EntityCardComponent,
  PersonChipComponent,
  ChannelLinkComponent,
  ApprovalCardComponent,
  DiffViewComponent,
] as const;

/** The registry the web client and the server use. */
export const SURFACE_REGISTRY = createSurfaceRegistry(SURFACE_COMPONENTS);
