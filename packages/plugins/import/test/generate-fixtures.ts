import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mattermostExport, slackExport } from './fixtures.ts';

// Writes the two fixture exports to test/fixtures/. Run it after changing fixtures.ts:
//   pnpm exec tsx packages/plugins/import/test/generate-fixtures.ts
// The files are plain data for people to open and for other tests (the seed of P14-18) to upload; nothing in them is secret.

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}slack-export.zip`, slackExport());
writeFileSync(`${dir}mattermost-export.jsonl`, mattermostExport());
console.log(`wrote ${dir}`);
