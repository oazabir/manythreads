-- search 0002: what makes the LEAKPROOF mark of 0001 true. Forward-only: never edit once applied.
--
-- A LEAKPROOF function must not reveal its arguments through an error. pg_trgm's operators never fail on a value of ordinary size, but they
-- do on an absurd one: a text of about 100 MB makes `word_similarity_op` raise "out of memory" (measured on this Postgres: fine at 100 MB,
-- `invalid memory alloc request size` at 250 MB). The planner may evaluate a LEAKPROOF qual on a row BEFORE the row level security policy has
-- hidden it, so if a hidden row could hold such a value, an error would tell a caller that a hidden row exists and how long it is.
-- That cannot happen as long as every column the operators run on is bounded far below that size, so the bound is a constraint, not a habit
-- of the application: messages.body is limited to 40,000 characters, files.name to 255, and now body_plain (derived from body, so never
-- longer) and the thread title (the first 120 characters of the root) are limited too. These are the only three columns the search functions
-- and the trigram indexes use; a new searchable column needs the same bound before it gets a trigram index.
ALTER TABLE app.messages ADD CONSTRAINT messages_body_plain_len CHECK (length(body_plain) <= 100000);
ALTER TABLE app.threads ADD CONSTRAINT threads_title_len CHECK (length(title) <= 200);

COMMENT ON INDEX app.messages_body_plain_trgm IS 'trigram search; body_plain is bounded by messages_body_plain_len (the LEAKPROOF pg_trgm operators rely on bounded text, search 0002)';
COMMENT ON INDEX app.threads_title_trgm IS 'trigram search; title is bounded by threads_title_len (the LEAKPROOF pg_trgm operators rely on bounded text, search 0002)';
COMMENT ON INDEX app.files_name_trgm IS 'trigram search; name is bounded to 255 characters by files_name_check (the LEAKPROOF pg_trgm operators rely on bounded text, search 0002)';
