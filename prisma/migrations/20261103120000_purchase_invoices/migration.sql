-- Comprobantes de compra de proveedores (base del Registro de Compras / PLE 8.1).

-- CreateTable
CREATE TABLE "purchase_invoices" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL DEFAULT app_current_tenant(),
    "supplierId" UUID,
    "supplierDocType" "DocumentIdType" NOT NULL DEFAULT 'RUC',
    "supplierDocNumber" TEXT,
    "supplierName" TEXT,
    "docTypeCode" TEXT NOT NULL,
    "series" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issueDate" TIMESTAMPTZ(3) NOT NULL,
    "dueDate" TIMESTAMPTZ(3),
    "period" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PEN',
    "taxedBase" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "igv" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "exemptTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "givesTaxCredit" BOOLEAN NOT NULL DEFAULT true,
    "paidWithBankMethod" BOOLEAN NOT NULL DEFAULT false,
    "relatedDocTypeCode" TEXT,
    "relatedSeries" TEXT,
    "relatedNumber" TEXT,
    "relatedIssueDate" TIMESTAMPTZ(3),
    "purchaseOrderId" UUID,
    "notes" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_invoices_tenantId_period_idx" ON "purchase_invoices"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_tenantId_id_key" ON "purchase_invoices"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_doc_active" ON "purchase_invoices"("tenantId", "supplierDocNumber", "docTypeCode", "series", "number") WHERE "deletedAt" IS NULL;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_tenantId_supplierId_fkey" FOREIGN KEY ("tenantId", "supplierId") REFERENCES "suppliers"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_tenantId_purchaseOrderId_fkey" FOREIGN KEY ("tenantId", "purchaseOrderId") REFERENCES "purchase_orders"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariantes del comprobante de compra (la app valida con Zod; la base lo garantiza).
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_amounts_nonneg" CHECK ("taxedBase" >= 0 AND "igv" >= 0 AND "exemptTotal" >= 0 AND "total" >= 0);
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_total_matches" CHECK ("total" = "taxedBase" + "igv" + "exemptTotal");
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_period_valid" CHECK ("period" BETWEEN 200001 AND 209912 AND "period" % 100 BETWEEN 1 AND 12);
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_doc_type_code" CHECK ("docTypeCode" ~ '^[0-9]{2}$');
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_currency_pen" CHECK ("currency" = 'PEN');

SELECT apply_tenant_rls();
SELECT apply_app_privileges();
