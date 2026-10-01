-- 0004_identity: PLAN.md A.2 identity tables (workspaces, people, person_emails, workspace_members,
-- auth_providers, secrets, identities), the real workspace-role helpers, and the `rls:` table comment convention.
-- Forward-only: never edit this file once applied.
--
-- HELPER DESIGN (read with 0003). app.is_system() is `current_user = 'majlis_system'` and SECURITY INVOKER, so a
-- definer function can never be mistaken for the system actor by its *callers*. Membership lookups need to read
-- RLS-protected tables (workspace_members, team_members, ...) on behalf of whoever is asking, which would recurse
-- if they ran under the caller's own policies. So every lookup is a narrow SECURITY DEFINER function
-- `app.lookup_*` OWNED BY majlis_system with a pinned search_path: inside it current_user = majlis_system, the
-- tables' `app.is_system() OR ...` policy short-circuits on its first operand, and no policy is re-entered.
-- A lookup only ever answers about the CALLER (app.actor(), app.workspace_id()); it takes no person id. The public
-- helpers keep the 0003 shape: invoker functions `app.is_system() OR <lookup>`; only the lookup is a definer.
-- Ownership by majlis_system (not majlis_owner) keeps them working when the owner is not a superuser (CNPG-style
-- setups still make it one, but nothing here depends on that).

-- RLS table comments --------------------------------------------------------------------------------------------
-- Every table in schema app outside global_tables carries `COMMENT ON TABLE ... IS 'rls: <kind>'` with kind one of
-- team | person | workspace | system | global (free text may follow). The harness (pnpm test:rls) reports a
-- missing or unknown kind, so phase 3's tables need no harness edits.
COMMENT ON TABLE app.actors IS 'rls: system — identity rows; the actor reads its own row, writes are system only.';
COMMENT ON TABLE app.events IS 'rls: team — T: team rows by membership; workspace rows (team_id NULL) by workspace admin; append-only.';
COMMENT ON TABLE app.outbox IS 'rls: system — S: deliveries per subscriber.';
COMMENT ON TABLE app.outbox_processed IS 'rls: system — S: idempotency marks of delivered outbox rows.';
COMMENT ON TABLE app.event_subscriptions IS 'rls: system — S: which subscriber wants which event type.';
COMMENT ON TABLE app.jobs IS 'rls: system — S: durable queue.';
COMMENT ON TABLE app.job_leases IS 'rls: system — S: UNLOGGED worker leases.';
COMMENT ON TABLE app.job_schedules IS 'rls: system — S: cron schedules.';
COMMENT ON TABLE app.scoped_kv IS 'rls: team — plugin storage scoped to a workspace, team or person (see policies).';
COMMENT ON TABLE app.entity_links IS 'rls: team — T: links between entities of one team.';
COMMENT ON TABLE app.capability_grants IS 'rls: team — T read, S write: broker allowlists from BOT.md.';

-- workspaces (WR) ---------------------------------------------------------------------------------------------------
CREATE TABLE app.workspaces (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name        text NOT NULL CHECK (name <> ''),
  self_signup boolean NOT NULL DEFAULT false,
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug)
);
COMMENT ON TABLE app.workspaces IS 'rls: workspace — WR: members read their workspace, admins update, system creates.';

-- people (WR; P own details) ---------------------------------------------------------------------------------------
CREATE TABLE app.people (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id),
  display_name  text NOT NULL CHECK (display_name <> ''),
  primary_email text NOT NULL CHECK (primary_email <> ''),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX people_workspace_email ON app.people (workspace_id, lower(primary_email));
COMMENT ON TABLE app.people IS 'rls: workspace — WR: non-guest members read everyone, a guest only themself; P: own display name; admins manage.';

-- person_emails (P; W) -----------------------------------------------------------------------------------------------
CREATE TABLE app.person_emails (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id),
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  email        text NOT NULL CHECK (email <> ''),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX person_emails_email ON app.person_emails (lower(email));
CREATE INDEX person_emails_person ON app.person_emails (person_id);
CREATE INDEX person_emails_workspace ON app.person_emails (workspace_id);
COMMENT ON TABLE app.person_emails IS 'rls: person — P: own addresses (unverified inserts only); W: admins; verification is system.';

-- workspace_members (WR) -----------------------------------------------------------------------------------------------
CREATE TABLE app.workspace_members (
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id    uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, person_id)
);
CREATE INDEX workspace_members_person ON app.workspace_members (person_id);
COMMENT ON TABLE app.workspace_members IS 'rls: workspace — WR: non-guest members read the roster, admins write; only an owner grants or touches owner.';

-- secrets (S) ----------------------------------------------------------------------------------------------------------
-- Envelope encryption (see packages/kernel/src/kms): ciphertext = nonce|tag|AES-256-GCM(data key) of the secret,
-- wrapped_key = the data key wrapped by the KMS master key. majlis_app has NO privilege on this table; the only
-- door is app.put_secret / app.delete_secret below. Reading is the system role's alone (getSecret in the kernel).
CREATE TABLE app.secrets (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  ciphertext  bytea NOT NULL,
  wrapped_key bytea NOT NULL,
  key_id      text NOT NULL CHECK (key_id <> ''),
  created_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE app.secrets IS 'rls: system — S: envelope-encrypted blobs; no privilege for majlis_app, never returned by any API.';

-- auth_providers (W) --------------------------------------------------------------------------------------------------
CREATE TABLE app.auth_providers (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id    uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('google', 'microsoft', 'password', 'oidc')),
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_id       uuid REFERENCES app.secrets (id),
  enabled         boolean NOT NULL DEFAULT false,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  disabled_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_providers_workspace_kind ON app.auth_providers (workspace_id, kind);
CREATE INDEX auth_providers_secret ON app.auth_providers (secret_id) WHERE secret_id IS NOT NULL;
COMMENT ON TABLE app.auth_providers IS 'rls: workspace — W: workspace admins only (config holds no secrets; the secret is secret_id).';

-- identities (P; W) ----------------------------------------------------------------------------------------------------
CREATE TABLE app.identities (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id  uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  person_id     uuid NOT NULL REFERENCES app.people (id) ON DELETE CASCADE,
  provider_id   uuid NOT NULL REFERENCES app.auth_providers (id) ON DELETE CASCADE,
  subject       text NOT NULL CHECK (subject <> ''),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, subject)
);
CREATE INDEX identities_person ON app.identities (person_id);
CREATE INDEX identities_workspace ON app.identities (workspace_id);
COMMENT ON TABLE app.identities IS 'rls: person — P: own links (may unlink); W: admins; linking happens at sign-in, as system.';

-- Lookups (SECURITY DEFINER, owned by majlis_system; see the header) -------------------------------------------------------
-- The caller's workspace role in app.workspace_id(); NULL for a bot, a suspended or unknown person, a person with no
-- membership, or an actor of another workspace.
CREATE FUNCTION app.lookup_workspace_role() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT wm.role
  FROM app.actors a
  JOIN app.people p ON p.id = a.ref_id AND p.workspace_id = a.workspace_id AND p.status = 'active'
  JOIN app.workspace_members wm ON wm.workspace_id = a.workspace_id AND wm.person_id = p.id
  WHERE a.id = app.actor() AND a.kind = 'person' AND a.workspace_id = app.workspace_id()
$$;

-- Public helpers: replace the 0003 placeholders, same signatures, same invoker shape. -------------------------------------
-- The caller's own `actors` row is readable under its policy, so person_id() needs no definer any more.
CREATE OR REPLACE FUNCTION app.person_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT ref_id FROM app.actors WHERE id = app.actor() AND kind = 'person' $$;

CREATE FUNCTION app.workspace_role() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT CASE WHEN app.is_system() THEN 'system' ELSE app.lookup_workspace_role() END $$;

CREATE OR REPLACE FUNCTION app.is_workspace_admin() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp
  AS $$ SELECT app.is_system() OR coalesce(app.lookup_workspace_role() IN ('owner', 'admin'), false) $$;

-- Secrets: the only write doors for majlis_app ------------------------------------------------------------------------------
-- put_secret / delete_secret run as majlis_system but only for a workspace admin (or the system pool itself:
-- session_user is the LOGIN role, which SET ROLE and definer ownership do not change).
CREATE FUNCTION app.put_secret(p_id uuid, p_ciphertext bytea, p_wrapped_key bytea, p_key_id text) RETURNS uuid
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF session_user <> 'majlis_system' AND coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
    RAISE EXCEPTION 'only a workspace admin may store a secret' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO app.secrets (id, ciphertext, wrapped_key, key_id) VALUES (p_id, p_ciphertext, p_wrapped_key, p_key_id);
  RETURN p_id;
END
$$;

CREATE FUNCTION app.delete_secret(p_id uuid) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, app, pg_temp
AS $$
DECLARE
  n integer;
BEGIN
  IF session_user <> 'majlis_system' AND coalesce(app.lookup_workspace_role() NOT IN ('owner', 'admin'), true) THEN
    RAISE EXCEPTION 'only a workspace admin may delete a secret' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM app.secrets WHERE id = p_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END
$$;

-- Trigger: only admins change a person's email or status ------------------------------------------------------------------
CREATE FUNCTION app.people_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp
AS $$
BEGIN
  IF app.is_system() THEN
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id THEN
    RAISE EXCEPTION 'a person cannot change id or workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.primary_email IS DISTINCT FROM OLD.primary_email OR NEW.status IS DISTINCT FROM OLD.status)
     AND NOT app.is_workspace_admin() THEN
    RAISE EXCEPTION 'only a workspace admin may change a person''s email or status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER people_guard BEFORE UPDATE ON app.people FOR EACH ROW EXECUTE FUNCTION app.people_guard();

-- Row level security ---------------------------------------------------------------------------------------------------------
ALTER TABLE app.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_select ON app.workspaces FOR SELECT
  USING (app.is_system() OR (id = app.workspace_id() AND app.workspace_role() IS NOT NULL));
CREATE POLICY workspaces_insert ON app.workspaces FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY workspaces_update ON app.workspaces FOR UPDATE
  USING (app.is_system() OR (id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY workspaces_delete ON app.workspaces FOR DELETE USING (app.is_system());

ALTER TABLE app.people ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.people FORCE ROW LEVEL SECURITY;
CREATE POLICY people_select ON app.people FOR SELECT USING (
  app.is_system()
  OR id = app.person_id()
  OR (workspace_id = app.workspace_id() AND app.workspace_role() IN ('owner', 'admin', 'member'))
);
CREATE POLICY people_insert ON app.people FOR INSERT
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY people_update ON app.people FOR UPDATE
  USING (app.is_system() OR id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY people_delete ON app.people FOR DELETE USING (app.is_system());

ALTER TABLE app.person_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.person_emails FORCE ROW LEVEL SECURITY;
CREATE POLICY person_emails_select ON app.person_emails FOR SELECT USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY person_emails_insert ON app.person_emails FOR INSERT WITH CHECK (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
  OR (workspace_id = app.workspace_id() AND person_id = app.person_id() AND verified_at IS NULL)
);
CREATE POLICY person_emails_update ON app.person_emails FOR UPDATE
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));
CREATE POLICY person_emails_delete ON app.person_emails FOR DELETE USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);

ALTER TABLE app.workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workspace_members FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_members_select ON app.workspace_members FOR SELECT USING (
  app.is_system()
  OR person_id = app.person_id()
  OR (workspace_id = app.workspace_id() AND app.workspace_role() IN ('owner', 'admin', 'member'))
);
CREATE POLICY workspace_members_insert ON app.workspace_members FOR INSERT WITH CHECK (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND (role <> 'owner' OR app.workspace_role() = 'owner'))
);
CREATE POLICY workspace_members_update ON app.workspace_members FOR UPDATE
  USING (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND (role <> 'owner' OR app.workspace_role() = 'owner'))
  )
  WITH CHECK (
    app.is_system()
    OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND (role <> 'owner' OR app.workspace_role() = 'owner'))
  );
CREATE POLICY workspace_members_delete ON app.workspace_members FOR DELETE USING (
  app.is_system()
  OR (workspace_id = app.workspace_id() AND app.is_workspace_admin() AND (role <> 'owner' OR app.workspace_role() = 'owner'))
);

ALTER TABLE app.secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY secrets_system ON app.secrets FOR ALL USING (app.is_system()) WITH CHECK (app.is_system());

ALTER TABLE app.auth_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.auth_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_providers_admin ON app.auth_providers FOR ALL
  USING (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()))
  WITH CHECK (app.is_system() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin()));

ALTER TABLE app.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.identities FORCE ROW LEVEL SECURITY;
CREATE POLICY identities_select ON app.identities FOR SELECT USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);
CREATE POLICY identities_insert ON app.identities FOR INSERT WITH CHECK (app.is_system());
CREATE POLICY identities_update ON app.identities FOR UPDATE USING (app.is_system()) WITH CHECK (app.is_system());
CREATE POLICY identities_delete ON app.identities FOR DELETE USING (
  app.is_system() OR person_id = app.person_id() OR (workspace_id = app.workspace_id() AND app.is_workspace_admin())
);

-- Privileges (system gets everything through the default privileges of 0003; secrets get nothing for majlis_app) --------------
GRANT SELECT, UPDATE ON app.workspaces TO majlis_app;
GRANT SELECT, INSERT, UPDATE ON app.people TO majlis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.person_emails, app.workspace_members, app.auth_providers TO majlis_app;
GRANT SELECT, DELETE ON app.identities TO majlis_app;
REVOKE ALL ON app.secrets FROM PUBLIC, majlis_app;

REVOKE ALL ON FUNCTION app.put_secret(uuid, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.delete_secret(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.put_secret(uuid, bytea, bytea, text) TO majlis_app, majlis_system;
GRANT EXECUTE ON FUNCTION app.delete_secret(uuid) TO majlis_app, majlis_system;
GRANT EXECUTE ON FUNCTION app.lookup_workspace_role() TO majlis_app, majlis_system;
GRANT EXECUTE ON FUNCTION app.workspace_role() TO majlis_app, majlis_system;

-- Definer functions belong to majlis_system (ALTER ... OWNER needs CREATE on the schema for the new owner). ------------------------
GRANT CREATE ON SCHEMA app TO majlis_system;
ALTER FUNCTION app.lookup_workspace_role() OWNER TO majlis_system;
ALTER FUNCTION app.put_secret(uuid, bytea, bytea, text) OWNER TO majlis_system;
ALTER FUNCTION app.delete_secret(uuid) OWNER TO majlis_system;
REVOKE CREATE ON SCHEMA app FROM majlis_system;
