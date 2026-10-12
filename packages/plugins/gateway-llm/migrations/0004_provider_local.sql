-- gateway-llm 0004: a provider an admin marks as running inside this deployment (review of P5-11). Forward-only: never edit once applied.
--
-- "Local" used to be inferred from the host name (localhost, 127.0.0.1, ::1). On k3s a self-hosted model is an in-cluster Service or a LAN
-- address, so the inference refused the real thing: the gate's classifier (SPEC §7.3: never a remote provider) could not run, and the
-- air-gapped preset refused the actual `local` alias. Guessing from a name (`*.svc`, `*.cluster.local`, a private IP) would be a guess about
-- a network the platform cannot see, so the admin says it: `local = true` means "this endpoint runs inside this deployment and its traffic
-- never leaves it". The loopback inference stays for a provider-less `ollama/…` model string; an unknown host is still not local.
--
-- The existing policies (workspace owners and admins read and write) and the table-level grants cover the new column. Existing rows are
-- not local: an admin turns it on for the provider they run themselves.

ALTER TABLE app.llm_providers ADD COLUMN local boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN app.llm_providers.local IS 'The admin says this endpoint runs inside this deployment (an in-cluster Service, a model on the same network) and never egresses; the gate classifier and the air-gapped preset treat it as local.';
