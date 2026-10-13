import {
  HttpError,
  buildCopy,
  checkRemove,
  loadShareView,
  shareDigest,
  storedAnswer,
  type AnswerShareView,
  type PluginContext,
} from '@manythreads/sdk';
import {
  AnswerSharePathParams,
  SaveAnswerPageRequest,
  SaveAnswerPageResponse,
  answerPageMarkdown,
  answerPagePath,
  pageTitle,
  saveAnswerPageRoute,
} from '@manythreads/shared';
import { writePage } from './pages.ts';
import { refusalResponse } from './routes.ts';

// "Save as page" (SPEC §6.4, PLAN P5-17): the masked copy of an answer of the caller's own conversation, as a markdown file under `pages/answers/`
// of the answer's team repo, through the one repo writer (`writePage`: the broker, the guarded paths, the `pages/` prefix, the commit as the
// person, the `pages.page.written` event). The page is team content — every reader of the repo may open it — so the copy is made for the team's
// readers by the same rule a share to a team-wide channel uses (`app.answer_share_view` with the page as the target): a source only its asker
// may open is "from <person>'s <kind> · not shared" in the file, with its label, snippet and ids left out.
//
// The request carries the digest the preview returned and the numbers of the claims to remove, never any text. A page is never overwritten:
// the file name carries the answer's id, so saving the same answer again finds the page and answers with its path (`created: false`).

const DAY = (): string => new Date().toISOString().slice(0, 10);

export function registerAnswerPageRoute(ctx: PluginContext): void {
  ctx.http.route({
    ...saveAnswerPageRoute,
    schema: { body: SaveAnswerPageRequest, response: SaveAnswerPageResponse },
    rateLimit: { limit: 30, windowMs: 60_000 },
    handler: async (req, tx) => {
      const params = AnswerSharePathParams.parse(req.params);
      const body = SaveAnswerPageRequest.parse(req.body);
      let view: AnswerShareView;
      try {
        view = await loadShareView(tx, params, 'page');
      } catch (err) {
        // the answer plugin's functions are what decide who may read the page: a deployment without them has nothing to save from
        if ((err as { code?: string }).code === '42883') throw new HttpError(503, 'internal', 'Saving an answer as a page is not available in this deployment');
        throw err;
      }
      const payload = storedAnswer(view);
      const remove = checkRemove(payload, body.remove);
      const built = buildCopy(view, payload, remove);
      const digest = shareDigest('page', params.messageId, built.copy);
      if (digest !== body.digest) {
        throw new HttpError(409, 'conflict', 'This answer would now read differently on a page. Look at the preview again before saving.');
      }

      const day = DAY();
      const path = answerPagePath(day, pageTitle(built.copy.body), params.messageId);
      const outcome = await writePage(ctx, tx, {
        team: view.answer.teamId,
        request: { mode: 'create', path, content: answerPageMarkdown(built.copy, day), message: 'Save an answer as a page' },
      });
      if (!outcome.ok) {
        // the same answer saved before: that page is the answer's page, and nothing a second save would write is worth overwriting it for
        if (outcome.status === 409 && (outcome.conflicts ?? []).some((c) => c.path === path && c.reason === 'exists')) {
          return { status: 200, body: SaveAnswerPageResponse.parse({ path, created: false, counts: built.counts }) };
        }
        return refusalResponse(outcome);
      }

      await tx.query("SELECT app.answer_share_record($1::uuid, 'page', NULL::uuid, $2, $3, NULL::uuid, $4, $5::int[], $6::int[])", [
        params.messageId,
        path,
        digest,
        built.counts.kept,
        built.maskedNumbers,
        built.removedNumbers,
      ]);
      await ctx.audit.emit(tx, {
        type: 'answer.answer.shared',
        kind: 'page',
        personId: view.answer.personId,
        botId: view.answer.botId,
        runId: payload.answeredFor.runId,
        messageId: params.messageId,
        channelId: null,
        copyMessageId: null,
        keptCount: built.counts.kept,
        maskedCount: built.counts.masked,
        removedCount: built.counts.removed,
        maskedNumbers: built.maskedNumbers,
        removedNumbers: built.removedNumbers,
      });
      return { status: 201, body: SaveAnswerPageResponse.parse({ path, created: true, counts: built.counts }) };
    },
  });
}
