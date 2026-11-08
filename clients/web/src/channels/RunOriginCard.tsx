/**
 * The card under a bot's post that says what started the run when a work app did: "Started by a GitHub issue: <title>" with a link back (PLAN Bundle D, P16-10, decision D21). It asks
 * `GET /api/runs/:runId/origin` and draws nothing on a 404. Work package H draws it; until then it draws nothing, so a bot's post looks as it did.
 */
export function RunOriginCard({ runId }: { runId: string }) {
  void runId;
  return null;
}
