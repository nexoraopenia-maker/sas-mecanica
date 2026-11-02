import { withTenant } from "@/lib/db";
import { logger } from "@/lib/logger";
import { listOperationalTenantIds } from "./inventory-maintenance";
import { expireQuotes } from "./quotes";
import { processReceivables, type ReceivableJobSummary } from "./receivables";

export interface TenantBillingResult {
  receivables: ReceivableJobSummary;
  quotesExpired: number;
}

/** Tarea diaria de ventas para un tenant: deudas vencidas (con recordatorio) y cotizaciones vencidas. */
export async function maintainTenantBilling(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantBillingResult> {
  return withTenant(
    tenantId,
    async (tx) => ({
      receivables: await processReceivables(tx, now),
      quotesExpired: await expireQuotes(tx, now),
    }),
    { timeoutMs: 60_000 },
  );
}

export async function maintainAllBilling(
  now: Date = new Date(),
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const tenantId of await listOperationalTenantIds(now)) {
    try {
      await maintainTenantBilling(tenantId, now);
      ok += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, tenantId }, "falló el mantenimiento de cobranza del tenant");
    }
  }
  return { ok, failed };
}
