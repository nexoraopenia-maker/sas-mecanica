
-- AlterTable
ALTER TABLE "warranty_claims" ADD COLUMN     "coverageOverrideReason" TEXT,
ADD COLUMN     "creditAmount" DECIMAL(14,2),
ADD COLUMN     "mileageAtClaim" INTEGER,
ADD COLUMN     "replacementMovementId" UUID,
ADD COLUMN     "replacementWarrantyId" UUID;

-- AlterTable
ALTER TABLE "work_order_items" ADD COLUMN     "warrantyPolicyId" UUID;

-- AlterTable
ALTER TABLE "work_orders" ADD COLUMN     "approvalIp" TEXT,
ADD COLUMN     "approvalTokenExpiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "approvedByName" TEXT,
ADD COLUMN     "currentApprovalRound" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE UNIQUE INDEX "warranties_tenantId_workOrderItemId_key" ON "warranties"("tenantId", "workOrderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "work_orders_approvalToken_key" ON "work_orders"("approvalTokenHash");

-- AddForeignKey
ALTER TABLE "work_order_items" ADD CONSTRAINT "work_order_items_tenantId_warrantyPolicyId_fkey" FOREIGN KEY ("tenantId", "warrantyPolicyId") REFERENCES "warranty_policies"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =============================================================================
-- Fase 5: aprobación pública de presupuestos.
-- El cliente abre un enlace SIN sesión: el token (solo su hash) se resuelve a
-- tenant/OT por esta función SECURITY DEFINER, igual que el login y los tokens
-- de correo. Devuelve lo mínimo; el resto lo lee la app ya con contexto de tenant.
-- =============================================================================
CREATE OR REPLACE FUNCTION auth_find_work_order_by_token(p_hash text)
RETURNS TABLE (id uuid, "tenantId" uuid, "approvalTokenExpiresAt" timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT w.id, w."tenantId", w."approvalTokenExpiresAt"
  FROM work_orders w
  WHERE w."approvalTokenHash" = p_hash AND w."deletedAt" IS NULL
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION auth_find_work_order_by_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_work_order_by_token(text) TO sas_app;

SELECT apply_tenant_rls();
SELECT apply_app_privileges();
