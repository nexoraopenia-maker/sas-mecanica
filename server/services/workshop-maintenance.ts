import { withTenant } from "@/lib/db";
import { logger } from "@/lib/logger";
import { listOperationalTenantIds } from "./inventory-maintenance";
import { processReminders, type ReminderJobSummary } from "./reminders";
import { processWarranties, type WarrantyJobSummary } from "./warranties";

export interface TenantWorkshopResult {
  warranties: WarrantyJobSummary;
  reminders: ReminderJobSummary;
}

/** Tarea diaria del taller para un tenant: garantías por vencer y recordatorios de mantenimiento. */
export async function maintainTenantWorkshop(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantWorkshopResult> {
  return withTenant(
    tenantId,
    async (tx) => ({
      warranties: await processWarranties(tx, now),
      reminders: await processReminders(tx, now),
    }),
    { timeoutMs: 60_000 },
  );
}

export async function maintainAllWorkshops(
  now: Date = new Date(),
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const tenantId of await listOperationalTenantIds(now)) {
    try {
      await maintainTenantWorkshop(tenantId, now);
      ok += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, tenantId }, "falló el mantenimiento del taller del tenant");
    }
  }
  return { ok, failed };
}
