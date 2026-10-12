-- approvals plugin 0002: a tool that may never wait for an approval cannot be filed by any door (PLAN P5-13, the open item of the P5-12
-- re-review). Forward-only: never edit once applied.
--
-- `NEVER_APPROVAL_GATED` (SDK) names the capabilities whose safety depends on what the *run* read, which an approved call — re-run later in a
-- new run with no history — would not carry. Today that is `memory.retain`. The SDK helper (`requestToolApproval`), the provider
-- (`ApprovalProvider.request`) and the resume job all refuse one; this is the database's own refusal, so a plugin that writes through
-- `app.approvals_request` directly gets the same answer (23514). NOT VALID: no row can exist for it (every door refused), and the constraint
-- need not scan the table. A test keeps this list equal to the SDK's.
-- A NOT VALID constraint is still checked when a row is UPDATED, so a legacy row of such a tool that is not final would fail the first thing that
-- touches it (a decision, the sweep). Every door has refused them since the P5-12 re-review, so there should be none; any that exist are ended
-- here, before the constraint: a pending one lapses, an approved one that has not run is called failed (it is never re-run).
UPDATE app.approvals SET status = 'expired', decided_at = now()
 WHERE tool = 'memory.retain' AND status = 'pending';
UPDATE app.approvals SET outcome = 'failed', outcome_detail = 'This call can no longer wait for an approval, so it was not made.'
 WHERE tool = 'memory.retain' AND status = 'approved' AND outcome IN ('queued', 'running');
ALTER TABLE app.approvals ADD CONSTRAINT approvals_never_gated CHECK (tool NOT IN ('memory.retain')) NOT VALID;
COMMENT ON CONSTRAINT approvals_never_gated ON app.approvals IS 'Mirrors NEVER_APPROVAL_GATED in @manythreads/sdk (memory.retain): such a call is refused for a run that read anything private, and an approved call runs later without that history.';
