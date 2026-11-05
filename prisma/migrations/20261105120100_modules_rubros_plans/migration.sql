-- Módulos por cliente y por plan, rubro del negocio y contraseña temporal.

-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('AUTOPARTS', 'WORKSHOP', 'MIXED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "businessType" "BusinessType" NOT NULL DEFAULT 'MIXED';
ALTER TABLE "tenant_settings" ADD COLUMN "disabledModules" "AppModule"[];
ALTER TABLE "users" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;

-- Catálogo global de permisos de los módulos nuevos (el seed hace lo mismo en instalaciones nuevas).
INSERT INTO "permissions" ("id", "module", "action")
SELECT gen_random_uuid(), pair.module::"AppModule", pair.action::"PermissionAction"
FROM (VALUES
  ('WHATSAPP', 'ver'), ('WHATSAPP', 'editar'),
  ('ACCOUNTING', 'ver'), ('ACCOUNTING', 'crear'), ('ACCOUNTING', 'editar'), ('ACCOUNTING', 'eliminar'),
  ('BRANCHES', 'ver'), ('BRANCHES', 'crear'), ('BRANCHES', 'editar'), ('BRANCHES', 'eliminar')
) AS pair(module, action)
ON CONFLICT ("module", "action") DO NOTHING;

-- Planes comerciales: Básico / Standard / Premium (se conservan los códigos basic, pro y enterprise).
UPDATE "plans" SET
  "name" = 'Standard',
  "description" = 'Taller completo, compras, WhatsApp, libros PLE y hasta 3 sucursales',
  "includedModules" = ARRAY['USERS','CUSTOMERS','CATALOG','INVENTORY','WARRANTIES','POS','CASH','BILLING','REPORTS','SETTINGS','AUDIT','WORKSHOP','PURCHASING','WHATSAPP','ACCOUNTING','BRANCHES']::"AppModule"[]
WHERE "code" = 'pro';

UPDATE "plans" SET
  "name" = 'Premium',
  "description" = 'Todo incluido: IA de inventario y compras, sucursales ilimitadas y usuarios ilimitados',
  "includedModules" = ARRAY['USERS','CUSTOMERS','CATALOG','INVENTORY','WARRANTIES','POS','CASH','BILLING','REPORTS','SETTINGS','AUDIT','WORKSHOP','PURCHASING','AI_AGENT','WHATSAPP','ACCOUNTING','BRANCHES']::"AppModule"[]
WHERE "code" = 'enterprise';

UPDATE "plans" SET
  "includedModules" = ARRAY['USERS','CUSTOMERS','CATALOG','INVENTORY','WARRANTIES','POS','CASH','BILLING','REPORTS','SETTINGS','AUDIT','WORKSHOP','PURCHASING','AI_AGENT','WHATSAPP','ACCOUNTING','BRANCHES']::"AppModule"[]
WHERE "code" = 'demo';

UPDATE "plans" SET "description" = 'Punto de venta, caja, inventario, facturación SUNAT y reportes' WHERE "code" = 'basic';

-- Los administradores existentes reciben los permisos nuevos. Si el rol que migra no puede saltarse RLS, se
-- omite sin romper el despliegue: el sistema le da al rol Administrador todo el catálogo igualmente.
DO $$
BEGIN
  INSERT INTO "role_permissions" ("id", "tenantId", "roleId", "permissionId")
  SELECT gen_random_uuid(), r."tenantId", r."id", p."id"
  FROM "roles" r
  JOIN "permissions" p ON p."module" IN ('WHATSAPP', 'ACCOUNTING', 'BRANCHES')
  WHERE r."key" = 'admin' AND r."deletedAt" IS NULL
  ON CONFLICT ("roleId", "permissionId") DO NOTHING;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Se omite la asignación de permisos a administradores (RLS); el rol Administrador tiene todo el catálogo por diseño.';
END $$;
