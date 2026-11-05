-- Códigos de barras autogenerados y Guía de Remisión Electrónica (GRE remitente).
-- CreateEnum
CREATE TYPE "DispatchReason" AS ENUM ('SALE', 'PURCHASE', 'TRANSFER_BETWEEN_ESTABLISHMENTS', 'OTHER');

-- CreateEnum
CREATE TYPE "DispatchTransportMode" AS ENUM ('PUBLIC', 'PRIVATE');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "barcodeGenerated" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "dispatch_guides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "series" TEXT NOT NULL,
    "correlative" INTEGER NOT NULL,
    "issueDate" TIMESTAMPTZ(3) NOT NULL,
    "transferDate" TIMESTAMPTZ(3) NOT NULL,
    "reason" "DispatchReason" NOT NULL,
    "reasonNote" TEXT,
    "transportMode" "DispatchTransportMode" NOT NULL,
    "carrierDocType" "DocumentIdType",
    "carrierDocNumber" TEXT,
    "carrierName" TEXT,
    "driverDocNumber" TEXT,
    "driverName" TEXT,
    "driverLicense" TEXT,
    "vehiclePlate" TEXT,
    "grossWeightKg" DECIMAL(12,3) NOT NULL,
    "packages" INTEGER,
    "originAddress" TEXT NOT NULL,
    "originUbigeo" TEXT NOT NULL,
    "destinationAddress" TEXT NOT NULL,
    "destinationUbigeo" TEXT NOT NULL,
    "recipientDocType" "DocumentIdType" NOT NULL,
    "recipientDocNumber" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "saleId" UUID,
    "transferId" UUID,
    "relatedDocument" TEXT,
    "status" "FiscalStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "hash" TEXT,
    "xmlUrl" TEXT,
    "pdfUrl" TEXT,
    "cdrUrl" TEXT,
    "errorMessage" TEXT,
    "voidedAt" TIMESTAMPTZ(3),
    "voidReason" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "dispatch_guides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_guide_items" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "guideId" UUID NOT NULL,
    "productId" UUID,
    "description" TEXT NOT NULL,
    "sku" TEXT,
    "unit" TEXT NOT NULL DEFAULT 'UND',
    "quantity" DECIMAL(14,4) NOT NULL,

    CONSTRAINT "dispatch_guide_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispatch_guides_tenantId_createdAt_idx" ON "dispatch_guides"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_guides_tenantId_id_key" ON "dispatch_guides"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "dispatch_guides_tenantId_series_correlative_key" ON "dispatch_guides"("tenantId", "series", "correlative");

-- CreateIndex
CREATE INDEX "dispatch_guide_items_tenantId_guideId_idx" ON "dispatch_guide_items"("tenantId", "guideId");

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_saleId_fkey" FOREIGN KEY ("tenantId", "saleId") REFERENCES "sales"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_tenantId_transferId_fkey" FOREIGN KEY ("tenantId", "transferId") REFERENCES "stock_transfers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_tenantId_guideId_fkey" FOREIGN KEY ("tenantId", "guideId") REFERENCES "dispatch_guides"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "products"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Invariantes de la GRE (la app valida con Zod; la base lo garantiza).
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_series_format" CHECK ("series" ~ '^[TV][A-Z0-9]{3}$');
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_weight_positive" CHECK ("grossWeightKg" > 0);
ALTER TABLE "dispatch_guides" ADD CONSTRAINT "dispatch_guides_ubigeo_format" CHECK ("originUbigeo" ~ '^[0-9]{6}$' AND "destinationUbigeo" ~ '^[0-9]{6}$');
ALTER TABLE "dispatch_guide_items" ADD CONSTRAINT "dispatch_guide_items_qty_positive" CHECK ("quantity" > 0);

SELECT apply_tenant_rls();
SELECT apply_app_privileges();
