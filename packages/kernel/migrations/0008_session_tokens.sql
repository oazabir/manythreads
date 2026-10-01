-- 0008_session_tokens: the durable side of the cookie token lookup. Forward-only: never edit this file once applied.
--
-- 0005 gave the hot lookup (app.session_cache, UNLOGGED: token_hash -> session) but nothing it can be rebuilt from, so a
-- crash (which empties an UNLOGGED table) would have signed everybody out. session_tokens keeps the sha256 of every live
-- cookie token of a session. A cache miss reads here and re-fills the cache. Tokens are random 256-bit values, so the
-- hash is not guessable, but it never leaves the system role: manythreads_app has no privilege on the table.
--
-- Rotation: a new token is inserted and the old one is marked superseded_at; the old token keeps working for a short
-- grace period (parallel requests that left before the browser saw the new cookie), then the row is deleted.

CREATE TABLE app.session_tokens (
  token_hash    bytea PRIMARY KEY,
  session_id    uuid NOT NULL REFERENCES app.sessions (id) ON DELETE CASCADE,
  issued_at     timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE INDEX session_tokens_session ON app.session_tokens (session_id);
COMMENT ON TABLE app.session_tokens IS 'rls: system — S: sha256 of live session cookie tokens (the durable source of session_cache); no privilege for manythreads_app.';

ALTER TABLE app.session_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.session_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY session_tokens_system ON app.session_tokens FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

REVOKE ALL ON app.session_tokens FROM PUBLIC, manythreads_app;
