-- Reversión manual de 20261105120100_modules_rubros_plans (Prisma no ejecuta este archivo).
DELETE FROM "role_permissions" WHERE "permissionId" IN (SELECT "id" FROM "permissions" WHERE "module" IN ('WHATSAPP', 'ACCOUNTING', 'BRANCHES'));
DELETE FROM "permissions" WHERE "module" IN ('WHATSAPP', 'ACCOUNTING', 'BRANCHES');
UPDATE "plans" SET "includedModules" = array_remove(array_remove(array_remove("includedModules", 'WHATSAPP'), 'ACCOUNTING'), 'BRANCHES');
ALTER TABLE "users" DROP COLUMN IF EXISTS "mustChangePassword";
ALTER TABLE "tenant_settings" DROP COLUMN IF EXISTS "disabledModules";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "businessType";
DROP TYPE IF EXISTS "BusinessType";
