-- bot_runner_usage was granted INSERT, UPDATE and DELETE to manythreads_app in 0003. Only the system role writes this table
-- (recordUsage runs through ctx.db.system, and manythreads_system holds its own table privileges by default); the admin usage
-- route only reads it. Keep SELECT for the app role and drop the rest; the row policies already refused the writes, this
-- removes the privileges too.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON app.bot_runner_usage FROM manythreads_app;
