-- onboarding 0002: the first-run wizard of Phase 27 (docs/plans/onboarding-journey.md §5). Forward-only: never edit once applied.
--
-- The wizard has thirteen steps instead of nine. Four more can record something a person did, and two of the records point at a thing:
--
--  * `theme`: "keep this theme" (a decision, like the sign-in confirmation); the choice itself is stored with the person by the identity plugin.
--  * `runners`: a runner answered a real test turn from the wizard. `ref_id` is the runner. A fact the wizard reads again each time is that a runner is
--    ready; this mark says one of them was proved by a real answer, which no other table keeps.
--  * `delivery`: the first delivery was started (`started`, `ref_id` is the thread's root message) or set aside (`skipped`).
--
-- `ref_id` carries no foreign key on purpose (a runner or a message is owned by another plugin and the record should outlive it), like the ids of
-- onboarding_state. `launch_message_id` is the root message of the question put to Brain, so the wizard can show that run.

ALTER TABLE app.onboarding_marks DROP CONSTRAINT onboarding_marks_step_check;
ALTER TABLE app.onboarding_marks DROP CONSTRAINT onboarding_marks_kind_check;
ALTER TABLE app.onboarding_marks DROP CONSTRAINT onboarding_marks_kind_by_step;

ALTER TABLE app.onboarding_marks ADD COLUMN ref_id uuid;

ALTER TABLE app.onboarding_marks ADD CONSTRAINT onboarding_marks_step_check
  CHECK (step IN ('signin', 'theme', 'code', 'infrastructure', 'servers', 'runners', 'delivery'));
ALTER TABLE app.onboarding_marks ADD CONSTRAINT onboarding_marks_kind_check
  CHECK (kind IN ('skipped', 'acknowledged', 'checked', 'started'));
-- which kind each step takes; a check or a start must say what it points at
ALTER TABLE app.onboarding_marks ADD CONSTRAINT onboarding_marks_kind_by_step CHECK (
  (step IN ('signin', 'theme') AND kind = 'acknowledged' AND ref_id IS NULL)
  OR (step IN ('code', 'infrastructure', 'servers') AND kind = 'skipped' AND ref_id IS NULL)
  OR (step = 'runners' AND kind = 'checked' AND ref_id IS NOT NULL)
  OR (step = 'delivery' AND ((kind = 'skipped' AND ref_id IS NULL) OR (kind = 'started' AND ref_id IS NOT NULL)))
);

ALTER TABLE app.onboarding_state ADD COLUMN launch_message_id uuid;
