import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Takes the commands of an install page out of its Markdown (PLAN P10-09, decision E27). A fenced block whose first line is "```sh k3s-test" is a step the fresh-k3s test runs; the
// page and the test are the same text, so the page cannot say one thing and the test do another. A block with any other tag (the k3s install, a values example) is only read.

/** One step of a page. */
export interface Block {
  /** The line of the opening fence, from 1. */
  line: number;
  /** The commands, without the fence. */
  code: string;
}

/** The blocks of `markdown` whose opening fence is "```<language> <tag>". Nested fences are not a thing in these pages. */
export function extractBlocks(markdown: string, language: string, tag: string): Block[] {
  const out: Block[] = [];
  const lines = markdown.split('\n');
  const open = new RegExp(`^\`\`\`${language}\\s+${tag}\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    if (!open.test(lines[i]!)) continue;
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length && !/^```\s*$/.test(lines[j]!); j++) body.push(lines[j]!);
    if (j >= lines.length) throw new Error(`the block that opens on line ${i + 1} is never closed`);
    out.push({ line: i + 1, code: body.join('\n') });
    i = j;
  }
  return out;
}

/** Single quotes around `text`, so the shell expands nothing in it. */
const shellQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

/** One script: every block in order, each under a line that says which one it is, so a failure names the line of the page. */
export function scriptOf(blocks: readonly Block[], source: string): string {
  const parts = ['#!/usr/bin/env bash', 'set -euo pipefail'];
  blocks.forEach((block, index) => {
    const first = block.code.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('#')) ?? '';
    parts.push(`echo ${shellQuote(`=== ${source}:${block.line} (step ${index + 1} of ${blocks.length}): ${first.slice(0, 70)}`)}`, block.code);
  });
  return `${parts.join('\n')}\n`;
}

// `tsx tools/deploy-test/src/extract.ts docs/deploy/k3s.md` prints the script.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (file === undefined) {
    process.stderr.write('usage: extract.ts <page.md> [tag]\n');
    process.exit(2);
  }
  const blocks = extractBlocks(readFileSync(file, 'utf8'), 'sh', process.argv[3] ?? 'k3s-test');
  if (blocks.length === 0) {
    process.stderr.write(`${file} has no block tagged "sh ${process.argv[3] ?? 'k3s-test'}"\n`);
    process.exit(1);
  }
  process.stdout.write(scriptOf(blocks, file));
}
