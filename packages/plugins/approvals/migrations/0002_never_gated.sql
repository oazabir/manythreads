-- approvals plugin 0002: a tool that may never wait for an approval cannot be filed by any door (PLAN P5-13, the open item of the P5-12
-- re-review). Forward-only: never edit once applied.
--
-- `NEVER_APPROVAL_GATED` (SDK) names the capabilities whose safety depends on what the *run* read, which an approved call — re-run later in a
-- new run with no history — would not carry. Today that is `memory.retain`. The SDK helper (`requestToolApproval`), the provider
-- (`ApprovalProvider.request`) and the resume job all refuse one; this is the database's own refusal, so a plugin that writes through
-- `app.approvals_request` directly gets the same answer (23514). NOT VALID: no row can exist for it (every door refused), and the constraint
-- need not scan the table. A test keeps this list equal to the SDK's.
ALTER TABLE app.approvals ADD CONSTRAINT approvals_never_gated CHECK (tool NOT IN ('memory.retain')) NOT VALID;
COMMENT ON CONSTRAINT approvals_never_gated ON app.approvals IS 'Mirrors NEVER_APPROVAL_GATED in @manythreads/sdk (memory.retain): such a call is refused for a run that read anything private, and an approved call runs later without that history.';
