-- Fase 6: POS, caja, cuentas por cobrar y facturación electrónica.

-- AlterTable
ALTER TABLE "cash_sessions" ADD COLUMN     "openKey" TEXT;

-- AlterTable
ALTER TABLE "fiscal_documents" ADD COLUMN     "docKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
ADD COLUMN     "itemsSnapshot" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "lastSharedAt" TIMESTAMPTZ(3),
ADD COLUMN     "noteReason" TEXT,
ADD COLUMN     "noteReasonCode" TEXT,
ADD COLUMN     "saleReturnId" UUID,
ADD COLUMN     "sentAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "maxDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sale_payments" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "sale_returns" ADD COLUMN     "idempotencyKey" TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "sale_returns" ALTER COLUMN "idempotencyKey" DROP DEFAULT;

-- AlterTable
ALTER TABLE "sale_return_items" ADD COLUMN     "amount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales" ADD COLUMN     "documentType" "DocumentType" NOT NULL DEFAULT 'NOTA_VENTA',
ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "boletaSeries" TEXT NOT NULL DEFAULT 'B001',
ADD COLUMN     "cashTolerance" DECIMAL(10,2) NOT NULL DEFAULT 1,
ADD COLUMN     "creditNoteBoletaSeries" TEXT NOT NULL DEFAULT 'BC01',
ADD COLUMN     "creditNoteFacturaSeries" TEXT NOT NULL DEFAULT 'FC01',
ADD COLUMN     "debitNoteBoletaSeries" TEXT NOT NULL DEFAULT 'BD01',
ADD COLUMN     "debitNoteFacturaSeries" TEXT NOT NULL DEFAULT 'FD01',
ADD COLUMN     "defaultCreditDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "facturaSeries" TEXT NOT NULL DEFAULT 'F001',
ADD COLUMN     "saleNoteSeries" TEXT NOT NULL DEFAULT 'NV01';

-- CreateIndex
CREATE UNIQUE INDEX "cash_sessions_tenantId_openKey_key" ON "cash_sessions"("tenantId", "openKey");

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_documents_tenantId_docKey_key" ON "fiscal_documents"("tenantId", "docKey");

-- CreateIndex
CREATE UNIQUE INDEX "sale_returns_tenantId_idempotencyKey_key" ON "sale_returns"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "sale_payments_tenantId_idempotencyKey_key" ON "sale_payments"("tenantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_tenantId_saleReturnId_fkey" FOREIGN KEY ("tenantId", "saleReturnId") REFERENCES "sale_returns"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Los valores por defecto solo existen para filas previas (la tabla no tenía uso): la app siempre los informa.
ALTER TABLE "fiscal_documents" ALTER COLUMN "docKey" DROP DEFAULT, ALTER COLUMN "itemsSnapshot" DROP DEFAULT;

-- Tope de descuento por rol: el Administrador puede todo y el Cajero/Vendedor hasta 10 %.
UPDATE "roles" SET "maxDiscountPercent" = 100 WHERE "key" = 'admin';
UPDATE "roles" SET "maxDiscountPercent" = 10 WHERE "key" = 'cashier';

-- Invariantes monetarias en la propia base (defensa en profundidad frente a bugs de la app).
ALTER TABLE "roles" ADD CONSTRAINT "roles_maxDiscountPercent_range" CHECK ("maxDiscountPercent" >= 0 AND "maxDiscountPercent" <= 100);
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_openingAmount_nonneg" CHECK ("openingAmount" >= 0);
ALTER TABLE "cash_movements" ADD CONSTRAINT "cash_movements_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "sales" ADD CONSTRAINT "sales_total_nonneg" CHECK ("total" >= 0);
ALTER TABLE "receivables" ADD CONSTRAINT "receivables_balance_range" CHECK ("balance" >= 0 AND "balance" <= "total");
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_total_nonneg" CHECK ("total" >= 0);

SELECT apply_tenant_rls();
SELECT apply_app_privileges();
