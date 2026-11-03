-- Fase 3 (Configuración): interruptores de IA/WhatsApp y reglas de series de comprobantes.

-- AlterTable
ALTER TABLE "tenant_settings"
  ADD COLUMN "aiAgentEnabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "whatsappNoticesEnabled" BOOLEAN NOT NULL DEFAULT true;

-- Las 7 series de un tenant deben ser distintas entre sí.
CREATE FUNCTION tenant_series_all_distinct(series text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT cardinality(series) = (SELECT count(DISTINCT s) FROM unnest(series) AS s) $$;

-- NOT VALID: se exige en toda escritura nueva sin reprobar filas históricas.
ALTER TABLE "tenant_settings"
  ADD CONSTRAINT "tenant_settings_boleta_series_format" CHECK ("boletaSeries" ~ '^B[0-9]{3}$') NOT VALID,
  ADD CONSTRAINT "tenant_settings_factura_series_format" CHECK ("facturaSeries" ~ '^F[0-9]{3}$') NOT VALID,
  ADD CONSTRAINT "tenant_settings_series_distinct" CHECK (
    tenant_series_all_distinct(ARRAY[
      "boletaSeries", "facturaSeries", "creditNoteBoletaSeries", "creditNoteFacturaSeries",
      "debitNoteBoletaSeries", "debitNoteFacturaSeries", "saleNoteSeries"
    ])
  ) NOT VALID;
