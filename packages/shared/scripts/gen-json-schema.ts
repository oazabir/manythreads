import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { BotFrontmatter } from '../src/bot-md/frontmatter.ts';

// Authors write the input shape (defaults optional), so the published JSON Schema is the input one.
const jsonSchema = z.toJSONSchema(BotFrontmatter, { io: 'input' });
const out = new URL('../src/bot-md/bot-frontmatter.schema.json', import.meta.url);
writeFileSync(out, `${JSON.stringify(jsonSchema, null, 2)}\n`);
console.log(`wrote ${out.pathname}`);
