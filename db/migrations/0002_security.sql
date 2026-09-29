-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0002_security — tenant isolation at the database layer (defence in depth, layer 3 of 4).
--
-- Model
--   * The app connects as the owner role but ALWAYS runs tenant work under `SET LOCAL ROLE lattice_app`
--     inside a transaction that also sets `app.user_id` / `app.workspace_id` (see src/infra/db/tenant.ts).
--   * `lattice_app` has no BYPASSRLS, so every policy below applies to it. Unset settings evaluate to NULL,
--     and NULL never matches — the system fails CLOSED.
--   * The application query ALSO filters by workspace_id (layer 2). RLS is the backstop for a forgotten filter.
--
-- Honest limit: these settings are transaction-local GUCs. RLS defends against application-logic bugs,
-- not against an attacker who can already run arbitrary SQL as `lattice_app` (that is what parameterised
-- queries are for).
-- ════════════════════════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lattice_app') THEN
    CREATE ROLE lattice_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
--> statement-breakpoint
GRANT lattice_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO lattice_app;
--> statement-breakpoint

-- ── scope accessors ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION app_user_id() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;
--> statement-breakpoint

-- SECURITY DEFINER so membership can be checked without recursing through memberships' own policy.
CREATE OR REPLACE FUNCTION app_is_member(ws uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.workspace_id = ws AND m.user_id = app_user_id()) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_workspace_authorized() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT app_workspace_id() IS NOT NULL AND app_is_member(app_workspace_id()) $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_is_workspace_owner(ws uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = ws AND w.owner_id = app_user_id()) $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_is_member(uuid), app_workspace_authorized(), app_is_workspace_owner(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_id(), app_workspace_id(), app_is_member(uuid), app_workspace_authorized(), app_is_workspace_owner(uuid) TO lattice_app;
--> statement-breakpoint

-- ── grants: tenant tables only; identity tables are NOT reachable by lattice_app ───────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspaces, memberships, documents, document_sources, chunks, ingestion_jobs, document_shares,
  conversations, messages, tool_calls, tasks, workspace_integrations,
  retrieval_events, request_traces, audit_log, rate_limits
TO lattice_app;
--> statement-breakpoint
REVOKE ALL ON "user", session, account, verification FROM lattice_app;
--> statement-breakpoint

-- ── enable RLS everywhere tenant data lives ────────────────────────────────────────────────────
ALTER TABLE workspaces            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE memberships           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE documents             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_sources      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE chunks                ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ingestion_jobs        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_shares       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE conversations         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE messages              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tool_calls            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE tasks                 ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE workspace_integrations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE retrieval_events      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE request_traces        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE audit_log             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ── user-scoped tables ────────────────────────────────────────────────────────────────────────
CREATE POLICY workspaces_select ON workspaces FOR SELECT TO lattice_app
  USING (owner_id = app_user_id() OR app_is_member(id));
--> statement-breakpoint
CREATE POLICY workspaces_insert ON workspaces FOR INSERT TO lattice_app
  WITH CHECK (owner_id = app_user_id());
--> statement-breakpoint
CREATE POLICY workspaces_update ON workspaces FOR UPDATE TO lattice_app
  USING (owner_id = app_user_id()) WITH CHECK (owner_id = app_user_id());
--> statement-breakpoint
CREATE POLICY workspaces_delete ON workspaces FOR DELETE TO lattice_app
  USING (owner_id = app_user_id());
--> statement-breakpoint

-- Members can see co-members. Only a workspace OWNER can add/remove members — this is what stops self-joining.
CREATE POLICY memberships_select ON memberships FOR SELECT TO lattice_app
  USING (user_id = app_user_id() OR app_is_member(workspace_id));
--> statement-breakpoint
CREATE POLICY memberships_insert ON memberships FOR INSERT TO lattice_app
  WITH CHECK (app_is_workspace_owner(workspace_id));
--> statement-breakpoint
CREATE POLICY memberships_update ON memberships FOR UPDATE TO lattice_app
  USING (app_is_workspace_owner(workspace_id)) WITH CHECK (app_is_workspace_owner(workspace_id));
--> statement-breakpoint
CREATE POLICY memberships_delete ON memberships FOR DELETE TO lattice_app
  USING (app_is_workspace_owner(workspace_id) OR user_id = app_user_id());
--> statement-breakpoint

-- ── workspace-scoped tables: row must belong to the ACTIVE workspace AND the user must be a member ─
-- `(SELECT fn())` makes Postgres evaluate the function once per statement (InitPlan), not once per row.
CREATE POLICY documents_select ON documents FOR SELECT TO lattice_app
  USING (
    (SELECT app_workspace_authorized()) AND (
      workspace_id = (SELECT app_workspace_id())
      OR EXISTS (SELECT 1 FROM document_shares s WHERE s.document_id = documents.id AND s.target_workspace_id = (SELECT app_workspace_id()))
    )
  );
--> statement-breakpoint
CREATE POLICY documents_write ON documents FOR INSERT TO lattice_app
  WITH CHECK ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY documents_update ON documents FOR UPDATE TO lattice_app
  USING ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))
  WITH CHECK ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY documents_delete ON documents FOR DELETE TO lattice_app
  USING ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- chunks: the shared vector store. Reads may include chunks of documents explicitly shared INTO this workspace.
CREATE POLICY chunks_select ON chunks FOR SELECT TO lattice_app
  USING (
    (SELECT app_workspace_authorized()) AND (
      workspace_id = (SELECT app_workspace_id())
      OR EXISTS (SELECT 1 FROM document_shares s WHERE s.document_id = chunks.document_id AND s.target_workspace_id = (SELECT app_workspace_id()))
    )
  );
--> statement-breakpoint
CREATE POLICY chunks_insert ON chunks FOR INSERT TO lattice_app
  WITH CHECK ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY chunks_update ON chunks FOR UPDATE TO lattice_app
  USING ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))
  WITH CHECK ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint
CREATE POLICY chunks_delete ON chunks FOR DELETE TO lattice_app
  USING ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- document_shares: visible to source and target workspace; only the SOURCE workspace grants; grantor must belong to the target too.
CREATE POLICY document_shares_select ON document_shares FOR SELECT TO lattice_app
  USING ((SELECT app_workspace_authorized())
         AND (source_workspace_id = (SELECT app_workspace_id()) OR target_workspace_id = (SELECT app_workspace_id())));
--> statement-breakpoint
CREATE POLICY document_shares_insert ON document_shares FOR INSERT TO lattice_app
  WITH CHECK ((SELECT app_workspace_authorized())
              AND source_workspace_id = (SELECT app_workspace_id())
              AND granted_by = app_user_id()
              AND app_is_member(target_workspace_id));
--> statement-breakpoint
CREATE POLICY document_shares_delete ON document_shares FOR DELETE TO lattice_app
  USING ((SELECT app_workspace_authorized()) AND source_workspace_id = (SELECT app_workspace_id()));
--> statement-breakpoint

-- Remaining strictly workspace-scoped tables share one policy shape.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'document_sources','ingestion_jobs','conversations','messages','tool_calls','tasks',
    'workspace_integrations','retrieval_events','request_traces'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO lattice_app
         USING ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))
         WITH CHECK ((SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))',
      t || '_isolation', t);
  END LOOP;
END $$;
--> statement-breakpoint

-- audit_log: workspace rows are scoped; workspace-less rows (sign-in, workspace creation) belong to their user.
CREATE POLICY audit_log_isolation ON audit_log FOR ALL TO lattice_app
  USING (
    (workspace_id IS NOT NULL AND (SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))
    OR (workspace_id IS NULL AND user_id = app_user_id())
  )
  WITH CHECK (
    (workspace_id IS NOT NULL AND (SELECT app_workspace_authorized()) AND workspace_id = (SELECT app_workspace_id()))
    OR (workspace_id IS NULL AND user_id = app_user_id())
  );
