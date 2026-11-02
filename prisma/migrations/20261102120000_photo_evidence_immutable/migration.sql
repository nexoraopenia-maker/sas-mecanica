-- Evidencia fotográfica inmutable: las fotos de ingreso/daño de una OT son de solo inserción.
-- Reutiliza forbid_mutation(): el DELETE solo se permite dentro de purge_tenant() (demos y retención vencida).
CREATE TRIGGER work_order_photos_immutable
  BEFORE UPDATE OR DELETE ON work_order_photos
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER work_order_photos_no_truncate
  BEFORE TRUNCATE ON work_order_photos
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
