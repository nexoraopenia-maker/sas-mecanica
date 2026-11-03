-- Reversión manual de 20261104120000_settings_phase3 (Prisma no ejecuta este archivo).
ALTER TABLE "tenant_settings"
  DROP CONSTRAINT IF EXISTS "tenant_settings_series_distinct",
  DROP CONSTRAINT IF EXISTS "tenant_settings_factura_series_format",
  DROP CONSTRAINT IF EXISTS "tenant_settings_boleta_series_format";
DROP FUNCTION IF EXISTS tenant_series_all_distinct(text[]);
ALTER TABLE "tenant_settings"
  DROP COLUMN IF EXISTS "whatsappNoticesEnabled",
  DROP COLUMN IF EXISTS "aiAgentEnabled";
