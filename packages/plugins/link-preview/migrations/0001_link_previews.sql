-- link-preview 0001: cards under messages that carry a link (PLAN P14-08). Forward-only: never edit once applied.
--
-- Four tables, in the order the data flows:
--
--   link_preview_settings  one row per workspace: the on/off switch and the allow and deny lists of sites. Read and written by workspace owners and admins.
--   link_preview_cache     what the server read from one address, kept for a day (an hour when the read failed). Workspace-scoped, holds no per-person
--                          data, and is NOT readable by the app role at all: it is keyed by address, so a listing of it would show which addresses were posted
--                          in private channels. Only the fetch job (the system role) reads and writes it.
--   link_preview_images    the picture of a page, stored as bytes after the server sniffed what they are (png, jpeg, gif, webp, avif; never SVG or HTML).
--                          A row is readable only through a card that points at it, i.e. only to people who can read that card's message.
--   link_previews          the card of one link of one message: a copy of title, description and site name taken from the cache. Readable with the message's
--                          channel (app.visible_channel_ids); the message's author may mark one removed. Rows are created only by the fetch job.
--
-- A card is a copy, not a view of the cache: the cache row expires and is deleted after a day while the card on an old message stays as it was.

CREATE TABLE app.link_preview_settings (
  workspace_id uuid PRIMARY KEY REFERENCES app.workspaces (id) ON DELETE CASCADE,
  enabled      boolean NOT NULL DEFAULT true,
  allow        text[] NOT NULL DEFAULT '{}' CHECK (cardinality(allow) <= 200),
  deny         text[] NOT NULL DEFAULT '{}' CHECK (cardinality(deny) <= 200),
  updated_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_preview_settings_updated_by ON app.link_preview_settings (updated_by) WHERE updated_by IS NOT NULL;
COMMENT ON TABLE app.link_preview_settings IS 'rls: workspace — W: whether link previews are on and which sites are allowed or denied; readable and written by workspace owners and admins.';

ALTER TABLE app.link_preview_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.link_preview_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY link_preview_settings_select ON app.link_preview_settings FOR SELECT
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY link_preview_settings_insert ON app.link_preview_settings FOR INSERT
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
CREATE POLICY link_preview_settings_update ON app.link_preview_settings FOR UPDATE
  USING ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')))
  WITH CHECK ((SELECT app.is_system()) OR (workspace_id = (SELECT app.workspace_id()) AND (SELECT app.workspace_role()) IN ('owner', 'admin')));
GRANT SELECT ON app.link_preview_settings TO manythreads_app;
GRANT INSERT (workspace_id, enabled, allow, deny, updated_by, updated_at) ON app.link_preview_settings TO manythreads_app;
GRANT UPDATE (enabled, allow, deny, updated_by, updated_at) ON app.link_preview_settings TO manythreads_app;

-- link_preview_images -------------------------------------------------------------------------------------------------------------------------------------
-- The bytes are capped at 2 MiB by a CHECK as well as by the fetcher, and the type is one of the five the sniffer knows.
CREATE TABLE app.link_preview_images (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif')),
  bytes        bytea NOT NULL CHECK (octet_length(bytes) BETWEEN 12 AND 2097152),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX link_preview_images_workspace ON app.link_preview_images (workspace_id);
CREATE INDEX link_preview_images_created ON app.link_preview_images USING brin (created_at);
COMMENT ON TABLE app.link_preview_images IS 'rls: team — C: a picture kept for a link preview; readable only through a card (link_previews) of a message the caller can read, written by the fetch job.';

-- link_preview_cache ---------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.link_preview_cache (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  url          text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  status       text NOT NULL CHECK (status IN ('ok', 'failed', 'blocked')),
  reason       text NOT NULL DEFAULT '' CHECK (char_length(reason) <= 60),
  final_url    text CHECK (final_url IS NULL OR char_length(final_url) <= 2000),
  title        text CHECK (title IS NULL OR char_length(title) <= 200),
  description  text CHECK (description IS NULL OR char_length(description) <= 400),
  site_name    text CHECK (site_name IS NULL OR char_length(site_name) <= 100),
  image_id     uuid REFERENCES app.link_preview_images (id) ON DELETE SET NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE UNIQUE INDEX link_preview_cache_url ON app.link_preview_cache (workspace_id, url);
CREATE INDEX link_preview_cache_expires ON app.link_preview_cache (expires_at);
CREATE INDEX link_preview_cache_image ON app.link_preview_cache (image_id) WHERE image_id IS NOT NULL;
COMMENT ON TABLE app.link_preview_cache IS 'rls: system — S: what the server read from one address, per workspace, kept for a day; holds no per-person data and is not readable by requests, only by the fetch job.';

ALTER TABLE app.link_preview_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.link_preview_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY link_preview_cache_system ON app.link_preview_cache FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));

-- link_previews --------------------------------------------------------------------------------------------------------------------------------------------
CREATE TABLE app.link_previews (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  workspace_id uuid NOT NULL REFERENCES app.workspaces (id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES app.channels (id) ON DELETE CASCADE,
  message_id   uuid NOT NULL REFERENCES app.messages (id) ON DELETE CASCADE,
  url          text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2000),
  ordinal      integer NOT NULL DEFAULT 0 CHECK (ordinal BETWEEN 0 AND 20),
  host         text NOT NULL CHECK (char_length(host) BETWEEN 1 AND 253),
  title        text CHECK (title IS NULL OR char_length(title) <= 200),
  description  text CHECK (description IS NULL OR char_length(description) <= 400),
  site_name    text CHECK (site_name IS NULL OR char_length(site_name) <= 100),
  image_id     uuid REFERENCES app.link_preview_images (id) ON DELETE SET NULL,
  removed_at   timestamptz,
  removed_by   uuid REFERENCES app.actors (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- one card per link of a message; a removed card stays as a tombstone so an edit does not bring it back
CREATE UNIQUE INDEX link_previews_message_url ON app.link_previews (message_id, url);
CREATE INDEX link_previews_channel ON app.link_previews (channel_id, message_id);
CREATE INDEX link_previews_workspace ON app.link_previews (workspace_id);
CREATE INDEX link_previews_image ON app.link_previews (image_id) WHERE image_id IS NOT NULL;
CREATE INDEX link_previews_removed_by ON app.link_previews (removed_by) WHERE removed_by IS NOT NULL;
COMMENT ON TABLE app.link_previews IS 'rls: team — C: the card of one link of one message; readable with the message''s channel (app.visible_channel_ids), removed by the message''s author, created only by the fetch job.';

ALTER TABLE app.link_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.link_previews FORCE ROW LEVEL SECURITY;
CREATE POLICY link_previews_select ON app.link_previews FOR SELECT
  USING ((SELECT app.is_system()) OR channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[]));
-- INSERT and DELETE: the system role only (no policy for the app role). The author's one write is marking their own message's card removed.
CREATE POLICY link_previews_system_write ON app.link_previews FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
CREATE POLICY link_previews_author_remove ON app.link_previews FOR UPDATE
  USING (
    channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    AND EXISTS (SELECT 1 FROM app.messages m WHERE m.id = link_previews.message_id AND m.author_id = (SELECT app.actor())))
  WITH CHECK (
    workspace_id = (SELECT app.workspace_id())
    AND channel_id = ANY ((SELECT app.visible_channel_ids('read'))::uuid[])
    AND removed_by = (SELECT app.actor()));
GRANT SELECT ON app.link_previews TO manythreads_app;
GRANT UPDATE (removed_at, removed_by) ON app.link_previews TO manythreads_app;

-- the picture is readable through a card the caller can read (the card's own policy decides; this is a lookup by id, not a scan)
CREATE POLICY link_preview_images_select ON app.link_preview_images FOR SELECT
  USING ((SELECT app.is_system()) OR EXISTS (SELECT 1 FROM app.link_previews p WHERE p.image_id = link_preview_images.id));
CREATE POLICY link_preview_images_system_write ON app.link_preview_images FOR ALL USING ((SELECT app.is_system())) WITH CHECK ((SELECT app.is_system()));
ALTER TABLE app.link_preview_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.link_preview_images FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.link_preview_images TO manythreads_app;
