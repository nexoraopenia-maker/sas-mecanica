-- =============================================================================
-- Políticas de Supabase Storage por tenant (regla: rutas `{tenantId}/...`).
--
-- Ejecutar UNA VEZ en el SQL Editor de Supabase (o con `supabase db push`),
-- después de las migraciones de Prisma. Es idempotente.
--
-- Modelo de acceso:
--  * Los buckets son PRIVADOS.
--  * La aplicación accede desde el servidor con la clave service_role y entrega
--    URLs firmadas de corta duración, construyendo SIEMPRE la ruta con
--    buildStoragePath() (lib/security/storage-path.ts).
--  * Defensa en profundidad: si algún día se usa un JWT de Supabase con el claim
--    `tenant_id`, estas políticas solo dejan operar sobre la carpeta de ese
--    tenant. Sin ese claim (o con `anon`) no se puede leer ni escribir nada.
-- =============================================================================
DO $$
DECLARE
  bucket text;
  buckets text[] := ARRAY['work-order-photos', 'receipts'];
BEGIN
  IF to_regclass('storage.objects') IS NULL THEN
    RAISE NOTICE 'Esquema storage no encontrado: este script solo aplica en Supabase.';
    RETURN;
  END IF;

  FOREACH bucket IN ARRAY buckets LOOP
    INSERT INTO storage.buckets (id, name, public)
    VALUES (bucket, bucket, false)
    ON CONFLICT (id) DO UPDATE SET public = false;
  END LOOP;

  DROP POLICY IF EXISTS tenant_storage_select ON storage.objects;
  DROP POLICY IF EXISTS tenant_storage_insert ON storage.objects;
  DROP POLICY IF EXISTS tenant_storage_update ON storage.objects;
  DROP POLICY IF EXISTS tenant_storage_delete ON storage.objects;

  CREATE POLICY tenant_storage_select ON storage.objects FOR SELECT TO authenticated
    USING (
      bucket_id IN ('work-order-photos', 'receipts')
      AND (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    );

  CREATE POLICY tenant_storage_insert ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (
      bucket_id IN ('work-order-photos', 'receipts')
      AND (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    );

  CREATE POLICY tenant_storage_update ON storage.objects FOR UPDATE TO authenticated
    USING (
      bucket_id IN ('work-order-photos', 'receipts')
      AND (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    )
    WITH CHECK (
      bucket_id IN ('work-order-photos', 'receipts')
      AND (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    );

  CREATE POLICY tenant_storage_delete ON storage.objects FOR DELETE TO authenticated
    USING (
      bucket_id IN ('work-order-photos', 'receipts')
      AND (storage.foldername(name))[1] = (auth.jwt() ->> 'tenant_id')
    );
END
$$;
