-- bot-runners 0002: the machine a pod runner stands on (PLAN.md Phase 19, P19-08). Forward-only: never edit once applied.
--
-- The column `app.bot_runners.node` exists since 0001 (it was reserved for the pod kinds). This migration makes it safe to use:
--
--   * a node is the value of a machine's `kubernetes.io/hostname` label, because that is what the pod's `nodeSelector` names. A label value is at most 63
--     characters of letters, digits, "-", "_" and ".", beginning and ending with a letter or a digit. The same rule is the Zod `RunnerNodeName` in packages/shared.
--   * only a pod kind (hermes_pod, claude_cli, codex_cli) has a node.
--
-- Both are NOT VALID: a row that was written before this migration is not checked by the constraint itself, every new write is. A NOT VALID check still judges a
-- row again the moment any later UPDATE touches it (23514), so a row written before this migration that breaks either rule would make an unrelated edit of that runner
-- fail for good. The statement below clears such a value first. A node on a kind that is not a pod could not be written through the API, and a name that is no label
-- value could not be used in a nodeSelector, so nothing that worked is lost: the runner goes back to "the cluster chooses".
UPDATE app.bot_runners SET node = NULL
 WHERE node IS NOT NULL
   AND (node !~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$' OR kind NOT IN ('hermes_pod', 'claude_cli', 'codex_cli'));

-- No table is added, so no new policy: `bot_runners` stays forced row level security, workspace owners and admins only (policy bot_runners_admin in 0001); a team
-- member never reads this column (app.bot_runners_for_team does not return it).

ALTER TABLE app.bot_runners
  ADD CONSTRAINT bot_runners_node_label CHECK (node IS NULL OR node ~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$') NOT VALID;
ALTER TABLE app.bot_runners
  ADD CONSTRAINT bot_runners_node_kind CHECK (node IS NULL OR kind IN ('hermes_pod', 'claude_cli', 'codex_cli')) NOT VALID;

COMMENT ON COLUMN app.bot_runners.node IS 'The machine (kubernetes.io/hostname) a pod runner''s pods are pinned to; null: the cluster chooses. Set only by PUT /api/admin/bot-runners/:id/node. Admin-only, never in an event, a team view or a log.';
