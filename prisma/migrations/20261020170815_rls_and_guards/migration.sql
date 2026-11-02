-- =============================================================================
-- Capas 2 y 3 de aislamiento + invariantes de inventario y auditoría.
--
--  1. Rol de aplicación `sas_app` (sin BYPASSRLS, sin ser dueño de las tablas).
--  2. RLS FORCE + política `tenant_isolation` en TODA tabla con "tenantId".
--  3. Privilegios mínimos (tablas de solo lectura, append-only, sin DELETE
--     físico en tablas con soft delete).
--  4. Kardex: CHECKs por tipo y trigger que mantiene saldos y costo promedio.
--  5. Auditoría y kardex inmutables.
--
-- Toda migración futura que cree tablas debe terminar con:
--     SELECT apply_tenant_rls();
--     SELECT apply_app_privileges();
-- (el test tests/integration/rls-coverage.test.ts falla si se olvida).
-- =============================================================================

-- 1. Rol de la aplicación -----------------------------------------------------
-- Sin LOGIN ni contraseña en el repositorio: `npm run db:app-role` lo habilita
-- con la contraseña de APP_DB_PASSWORD.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sas_app') THEN
    CREATE ROLE sas_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$$;

-- 2. RLS ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_tenant_rls() RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'tenantId'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', r.table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', r.table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I '
      'USING ("tenantId" = app_current_tenant()) '
      'WITH CHECK ("tenantId" = app_current_tenant())',
      r.table_name
    );
  END LOOP;
END
$$;

-- `tenants` se aísla por su propio id; plan y permisos son catálogos globales de lectura.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS global_read ON plans;
CREATE POLICY global_read ON plans FOR SELECT USING (true);

ALTER TABLE permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS global_read ON permissions;
CREATE POLICY global_read ON permissions FOR SELECT USING (true);

SELECT apply_tenant_rls();

-- 3. Privilegios --------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_app_privileges() RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r record;
  api_role text;
BEGIN
  GRANT USAGE ON SCHEMA public TO sas_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sas_app;

  -- Borrado lógico: nunca DELETE físico desde la app.
  FOR r IN
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'deletedAt'
  LOOP
    EXECUTE format('REVOKE DELETE ON public.%I FROM sas_app', r.table_name);
  END LOOP;

  -- Catálogos, facturación del SaaS e impersonación: la app solo lee (los escribe
  -- el cliente privilegiado). Así el banner de impersonación no se puede falsificar.
  REVOKE INSERT, UPDATE, DELETE ON
    plans, permissions, subscriptions, subscription_payments, tenants, impersonation_sessions
  FROM sas_app;

  -- La app solo edita datos de contacto de su propia empresa (estado, plan y
  -- demo los gestiona SuperAdmin).
  GRANT UPDATE ("tradeName", address, city, phone, "contactName", "contactEmail",
                "billingEmail", "logoUrl", "updatedAt")
    ON tenants TO sas_app;

  -- Saldos: se modifican SOLO vía trigger del kardex (SECURITY DEFINER).
  REVOKE INSERT, UPDATE, DELETE ON stock_balances, stock_lot_balances FROM sas_app;

  -- Tablas append-only.
  REVOKE UPDATE, DELETE ON kardex_movements, audit_logs FROM sas_app;

  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    REVOKE ALL ON TABLE public._prisma_migrations FROM sas_app;
  END IF;

  -- Supabase expone `public` por PostgREST: sus roles de API no deben tocar nada.
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;

-- 4. Usuarios: SuperAdmin <=> sin tenant -------------------------------------
ALTER TABLE users ADD CONSTRAINT users_superadmin_has_no_tenant CHECK (
  ("isSuperAdmin" AND "tenantId" IS NULL) OR (NOT "isSuperAdmin" AND "tenantId" IS NOT NULL)
);

-- 5. Kardex -------------------------------------------------------------------
ALTER TABLE kardex_movements ADD CONSTRAINT kardex_sign_by_type CHECK (
  (type IN ('INITIAL', 'PURCHASE', 'ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_IN', 'TRANSFER_IN',
            'RETURN_CUSTOMER', 'WORK_ORDER_RETURN', 'SALE_VOID')
     AND "quantityDelta" > 0)
  OR
  (type IN ('SALE', 'ADJUSTMENT_OUT', 'COUNT_ADJUSTMENT_OUT', 'TRANSFER_OUT',
            'RETURN_SUPPLIER', 'WORK_ORDER_CONSUMPTION')
     AND "quantityDelta" < 0)
);

ALTER TABLE kardex_movements ADD CONSTRAINT kardex_cost_required CHECK (
  type NOT IN ('INITIAL', 'PURCHASE') OR "unitCost" IS NOT NULL
);

ALTER TABLE kardex_movements ADD CONSTRAINT kardex_cost_non_negative CHECK (
  "unitCost" IS NULL OR "unitCost" >= 0
);

-- Los ajustes manuales exigen motivo.
ALTER TABLE kardex_movements ADD CONSTRAINT kardex_adjustment_reason CHECK (
  type NOT IN ('ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'COUNT_ADJUSTMENT_IN', 'COUNT_ADJUSTMENT_OUT')
  OR length(btrim(coalesce(reason, ''))) > 0
);

-- Guarda: los saldos solo cambian dentro del trigger del kardex.
CREATE OR REPLACE FUNCTION stock_balance_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.kardex_write', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'stock_guard: % solo se modifica mediante kardex_movements', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER stock_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_balances
  FOR EACH ROW EXECUTE FUNCTION stock_balance_guard();

CREATE TRIGGER stock_lot_balances_guard
  BEFORE INSERT OR UPDATE OR DELETE ON stock_lot_balances
  FOR EACH ROW EXECUTE FUNCTION stock_balance_guard();

-- Aplica el movimiento al saldo (y al lote) de forma atómica y serializada.
-- SECURITY DEFINER: la app no tiene permiso directo sobre los saldos.
-- Dos ventas simultáneas se serializan en el FOR UPDATE: la segunda relee el
-- saldo ya confirmado y falla si no alcanza (salvo allowNegative).
CREATE OR REPLACE FUNCTION kardex_apply_movement() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_qty      numeric(14,4);
  v_avg      numeric(14,4);
  v_new_qty  numeric(14,4);
  v_new_avg  numeric(14,4);
  v_lot_qty  numeric(14,4);
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'kardex: el tenant del movimiento no coincide con el contexto de la sesión'
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('app.kardex_write', 'on', true);

  INSERT INTO stock_balances (id, "tenantId", "warehouseId", "productId", quantity, "avgCost", "updatedAt")
  VALUES (gen_random_uuid(), NEW."tenantId", NEW."warehouseId", NEW."productId", 0, 0, now())
  ON CONFLICT ("tenantId", "warehouseId", "productId") DO NOTHING;

  SELECT quantity, "avgCost" INTO v_qty, v_avg
  FROM stock_balances
  WHERE "tenantId" = NEW."tenantId" AND "warehouseId" = NEW."warehouseId" AND "productId" = NEW."productId"
  FOR UPDATE;

  v_new_qty := v_qty + NEW."quantityDelta";

  IF v_new_qty < 0 AND NOT NEW."allowNegative" THEN
    PERFORM set_config('app.kardex_write', 'off', true);
    RAISE EXCEPTION 'insufficient_stock: producto % almacén % disponible % solicitado %',
      NEW."productId", NEW."warehouseId", v_qty, -NEW."quantityDelta"
      USING ERRCODE = 'P0001';
  END IF;

  -- Costo promedio ponderado: solo las entradas valorizadas lo recalculan.
  IF NEW."quantityDelta" > 0 AND NEW."unitCost" IS NOT NULL THEN
    IF GREATEST(v_qty, 0) + NEW."quantityDelta" > 0 THEN
      v_new_avg := ROUND(
        (GREATEST(v_qty, 0) * v_avg + NEW."quantityDelta" * NEW."unitCost")
        / (GREATEST(v_qty, 0) + NEW."quantityDelta"), 4);
    ELSE
      v_new_avg := NEW."unitCost";
    END IF;
  ELSE
    v_new_avg := v_avg;
  END IF;

  -- Las salidas se valorizan al costo promedio vigente (para el margen).
  IF NEW."quantityDelta" < 0 AND NEW."unitCost" IS NULL THEN
    NEW."unitCost" := v_avg;
  END IF;

  UPDATE stock_balances
  SET quantity = v_new_qty, "avgCost" = v_new_avg, "updatedAt" = now()
  WHERE "tenantId" = NEW."tenantId" AND "warehouseId" = NEW."warehouseId" AND "productId" = NEW."productId";

  IF NEW."lotId" IS NOT NULL THEN
    INSERT INTO stock_lot_balances (id, "tenantId", "warehouseId", "productId", "lotId", quantity, "updatedAt")
    VALUES (gen_random_uuid(), NEW."tenantId", NEW."warehouseId", NEW."productId", NEW."lotId", 0, now())
    ON CONFLICT ("tenantId", "warehouseId", "lotId") DO NOTHING;

    SELECT quantity INTO v_lot_qty
    FROM stock_lot_balances
    WHERE "tenantId" = NEW."tenantId" AND "warehouseId" = NEW."warehouseId" AND "lotId" = NEW."lotId"
    FOR UPDATE;

    IF v_lot_qty + NEW."quantityDelta" < 0 AND NOT NEW."allowNegative" THEN
      PERFORM set_config('app.kardex_write', 'off', true);
      RAISE EXCEPTION 'insufficient_stock: lote % disponible % solicitado %',
        NEW."lotId", v_lot_qty, -NEW."quantityDelta"
        USING ERRCODE = 'P0001';
    END IF;

    UPDATE stock_lot_balances
    SET quantity = quantity + NEW."quantityDelta", "updatedAt" = now()
    WHERE "tenantId" = NEW."tenantId" AND "warehouseId" = NEW."warehouseId" AND "lotId" = NEW."lotId";
  END IF;

  PERFORM set_config('app.kardex_write', 'off', true);

  NEW."balanceAfter" := v_new_qty;
  NEW."avgCostAfter" := v_new_avg;
  RETURN NEW;
END
$$;

CREATE TRIGGER kardex_apply_movement
  BEFORE INSERT ON kardex_movements
  FOR EACH ROW EXECUTE FUNCTION kardex_apply_movement();

-- 6. Inmutabilidad ------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'immutable: % es de solo inserción (% bloqueado)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER kardex_movements_immutable
  BEFORE UPDATE OR DELETE ON kardex_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER kardex_movements_no_truncate
  BEFORE TRUNCATE ON kardex_movements
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_logs_no_truncate
  BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- 7. Login: búsqueda de usuario por email antes de conocer el tenant ----------
-- RLS impediría resolver el tenant a partir del email; esta función
-- SECURITY DEFINER es la única puerta y devuelve solo lo necesario.
CREATE OR REPLACE FUNCTION auth_find_user_by_email(p_email text)
RETURNS TABLE (
  id uuid,
  "tenantId" uuid,
  "passwordHash" text,
  status "UserStatus",
  "isSuperAdmin" boolean,
  "sessionVersion" integer,
  "failedLoginCount" integer,
  "lockedUntil" timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u."tenantId", u."passwordHash", u.status, u."isSuperAdmin",
         u."sessionVersion", u."failedLoginCount", u."lockedUntil"
  FROM users u
  WHERE lower(u.email) = lower(p_email) AND u."deletedAt" IS NULL
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_find_user_by_email(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user_by_email(text) TO sas_app;

SELECT apply_app_privileges();
