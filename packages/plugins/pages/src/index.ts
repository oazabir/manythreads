import { definePlugin } from '@manythreads/sdk';
import { WritePageRequest } from '@manythreads/shared';
import { writePage } from './pages.ts';
import { registerPageRoutes } from './routes.ts';

export { writePage, refuse, type PageOutcome, type PageRefusal, type PageWritten, type WritePageInput } from './pages.ts';

/**
 * pages: durable pages (reports, saved answers, routine outputs) as text files under `pages/` of the team repo (SPEC section 6.4, PLAN P4-07).
 * `pages.write` creates, replaces or appends through the repo writer, as the caller, and emits `pages.page.written`. docs/plugins/pages.md.
 */
export default definePlugin({
  manifest: {
    name: 'pages',
    version: '0.1.0',
    kind: 'server',
    extends: ['event.emit'],
    // Not `files.write`: a bot that may only save pages (Brain's "Save as page") is granted `pages.write` alone. The broker's path guard covers both names.
    capabilities: [{ name: 'pages.write', destructive: false }],
    events: { emits: ['pages.page.written'], consumes: [] },
  },
  register(ctx) {
    registerPageRoutes(ctx);
    // What the MCP gateway calls for a bot's `pages.write` tool (phase 5): `{ team, mode, path, content, baseBlobSha?, message? }` as the bot's transaction.
    // Answers `{ ok: true, ... }` or `{ ok: false, status, code, message }`; the broker has already logged a denial.
    ctx.capabilities.register('pages.write', async (input, tx) => {
      const { team, ...rest } = input as { team?: unknown } & Record<string, unknown>;
      if (typeof team !== 'string' || team === '') return { ok: false, status: 400, code: 'validation_failed', message: 'team: the team slug or id is needed' };
      const parsed = WritePageRequest.safeParse(rest);
      if (!parsed.success) return { ok: false, status: 400, code: 'validation_failed', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
      return writePage(ctx, tx, { team, request: parsed.data });
    });
  },
});
