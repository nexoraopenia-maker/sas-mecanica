-- CreateTable
CREATE TABLE "rate_limit_buckets" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "rate_limit_buckets_windowStart_idx" ON "rate_limit_buckets"("windowStart");

-- =============================================================================
-- Servicios de plataforma (Fase 2): rate limit, búsqueda de tokens y purga.
-- =============================================================================

-- Rate limit: tabla de plataforma, bajo RLS permisivo (nada de anon/authenticated).
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
CREATE POLICY app_all ON rate_limit_buckets USING (true) WITH CHECK (true);

-- Purga controlada: DELETE permitido en tablas inmutables SOLO dentro de
-- purge_tenant() (GUC app.allow_purge). UPDATE y TRUNCATE siguen bloqueados.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'immutable: % es de solo inserción (% bloqueado)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END
$$;

-- Elimina TODOS los datos de un tenant. Solo para tenants demo o cancelados
-- cuya retención ya venció. Lo ejecuta el rol dueño (no sas_app). Borra por
-- pasadas: lo que aún tenga referencias (FK RESTRICT) se reintenta en la
-- siguiente pasada, así el orden de dependencias no se codifica a mano.
CREATE OR REPLACE FUNCTION purge_tenant(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  pass integer := 0;
  blocked integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tenants
    WHERE id = p_tenant
      AND ("isDemo" OR (status = 'CANCELLED' AND "purgeAfter" IS NOT NULL AND "purgeAfter" <= now()))
  ) THEN
    RAISE EXCEPTION 'purge_denied: el tenant no es demo ni cumplió su retención' USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.allow_purge', 'on', true);
  PERFORM set_config('app.kardex_write', 'on', true);

  LOOP
    pass := pass + 1;
    blocked := 0;
    FOR r IN
      SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND c.column_name = 'tenantId' AND t.table_type = 'BASE TABLE'
    LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE "tenantId" = $1', r.table_name) USING p_tenant;
      EXCEPTION WHEN foreign_key_violation THEN
        blocked := blocked + 1;
      END;
    END LOOP;
    EXIT WHEN blocked = 0;
    IF pass > 40 THEN
      RAISE EXCEPTION 'purge_stuck: dependencias circulares al purgar %', p_tenant;
    END IF;
  END LOOP;

  DELETE FROM tenants WHERE id = p_tenant;
  PERFORM set_config('app.allow_purge', 'off', true);
  PERFORM set_config('app.kardex_write', 'off', true);
  RETURN pass;
END
$$;

REVOKE ALL ON FUNCTION purge_tenant(uuid) FROM PUBLIC;

-- Tokens de invitación / recuperación: se buscan por hash ANTES de conocer el
-- tenant (el usuario aún no tiene sesión), igual que el login.
CREATE OR REPLACE FUNCTION auth_find_token(p_hash text)
RETURNS TABLE (
  id uuid,
  "tenantId" uuid,
  "userId" uuid,
  type "AuthTokenType",
  "expiresAt" timestamptz,
  "usedAt" timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t."tenantId", t."userId", t.type, t."expiresAt", t."usedAt"
  FROM auth_tokens t
  WHERE t."tokenHash" = p_hash
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_find_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_token(text) TO sas_app;

SELECT apply_tenant_rls();
SELECT apply_app_privileges();

-- Zona horaria: toda la plataforma opera en UTC (regla 19). El adaptador de
-- Prisma asume sesiones en UTC; si la BD usa otra zona, las fechas se desplazan
-- (retención, vencimientos de demo, MFA...). Se fija por rol y por base de datos
-- porque `options=-c timezone` no es aceptado por el pooler de Supabase.
ALTER ROLE sas_app SET timezone = 'UTC';
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO ''UTC''', current_database());
END
$$;
