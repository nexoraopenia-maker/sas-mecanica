-- Fase 7: reportes, configuración final y cobro de suscripciones.

-- AlterEnum
ALTER TYPE "PaymentGateway" ADD VALUE 'SIMULATED';
ALTER TYPE "PaymentGateway" ADD VALUE 'MANUAL';

-- AlterTable
ALTER TABLE "subscription_payments" ADD COLUMN     "checkoutUrl" TEXT,
ADD COLUMN     "reference" TEXT;

-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN     "gatewayPaymentMethodId" TEXT;

-- AlterTable
ALTER TABLE "tenant_settings" ADD COLUMN     "aiMinutesSavedPerLine" INTEGER NOT NULL DEFAULT 4,
ADD COLUMN     "deadStockDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "staffHourlyCost" DECIMAL(10,2) NOT NULL DEFAULT 15,
ADD COLUMN     "usdExchangeRate" DECIMAL(8,4) NOT NULL DEFAULT 3.75;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "suspendedByBilling" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_subscriptionId_periodStart_key" ON "subscription_payments"("subscriptionId", "periodStart");

-- Rangos válidos de la configuración (defensa en profundidad: la app ya los valida con Zod).
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_aiMinutesSavedPerLine_range" CHECK ("aiMinutesSavedPerLine" BETWEEN 0 AND 240);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_staffHourlyCost_nonneg" CHECK ("staffHourlyCost" >= 0);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_usdExchangeRate_positive" CHECK ("usdExchangeRate" > 0);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_deadStockDays_range" CHECK ("deadStockDays" BETWEEN 7 AND 730);
ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_taxRate_range" CHECK ("taxRate" >= 0 AND "taxRate" < 1);
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_amount_nonneg" CHECK ("amount" >= 0);

SELECT apply_tenant_rls();
SELECT apply_app_privileges();
