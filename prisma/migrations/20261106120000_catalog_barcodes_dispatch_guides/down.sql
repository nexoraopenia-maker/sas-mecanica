-- Reversa de 20261106120000_catalog_barcodes_dispatch_guides (solo para recuperación manual).
DROP TABLE IF EXISTS "dispatch_guide_items";
DROP TABLE IF EXISTS "dispatch_guides";
DROP TYPE IF EXISTS "DispatchReason";
DROP TYPE IF EXISTS "DispatchTransportMode";
ALTER TABLE "products" DROP COLUMN IF EXISTS "barcodeGenerated";
