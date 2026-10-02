import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as api from '../../src/api/index.ts';
import { BotFrontmatter } from '../../src/bot-md/frontmatter.ts';
import * as entities from '../../src/entities/index.ts';
import * as markup from '../../src/markup/index.ts';
import { eventRegistry } from '../../src/events/registry.ts';

// A breaking schema change fails here unless the snapshot is updated (`vitest -u`), which a reviewer
// must justify with a new version file + upcast (PLAN.md B.4 rule 6).

const render = (schema: z.ZodType, io: 'input' | 'output' = 'output'): string =>
  `${JSON.stringify(z.toJSONSchema(schema, { io }), null, 2)}\n`;

const namedSchemas = (prefix: string, mod: Record<string, unknown>): [string, z.ZodType][] =>
  Object.entries(mod)
    .filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType)
    .map(([name, schema]) => [`${prefix}.${name}`, schema]);

const eventSchemas: [string, z.ZodType][] = Object.entries(eventRegistry).flatMap(([type, versions]) =>
  Object.entries(versions).map(([v, schema]): [string, z.ZodType] => [`event.${type}.v${v}`, schema]),
);

const all: [string, z.ZodType, 'input' | 'output'][] = [
  ...eventSchemas.map(([n, s]): [string, z.ZodType, 'input' | 'output'] => [n, s, 'output']),
  ...namedSchemas('entity', entities).map(([n, s]): [string, z.ZodType, 'input' | 'output'] => [n, s, 'output']),
  ...namedSchemas('api', api).map(([n, s]): [string, z.ZodType, 'input' | 'output'] => [n, s, 'input']),
  ...namedSchemas('markup', markup).map(([n, s]): [string, z.ZodType, 'input' | 'output'] => [n, s, 'output']),
  ['bot-md.BotFrontmatter', BotFrontmatter, 'input'],
];

describe('JSON Schema snapshots', () => {
  it('covers events, entities, api and BotFrontmatter', () => {
    const names = all.map(([n]) => n);
    expect(names).toContain('event.kernel.test.pinged.v1');
    expect(names).toContain('event.kernel.test.pinged.v2');
    expect(names).toContain('entity.Message');
    expect(names).toContain('api.PostMessageRequest');
    expect(names).toContain('bot-md.BotFrontmatter');
  });

  it.each(all)('%s', async (name, schema, io) => {
    await expect(render(schema, io)).toMatchFileSnapshot(`./snapshots/${name}.json`);
  });
});
