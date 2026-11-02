import {
  listOperationalTenantIds,
  maintainTenantInventory,
} from "@/server/services/inventory-maintenance";
import { inngest } from "./client";

/**
 * Cada día (04:00 UTC): una ejecución por tenant, reintentable y aislada, de modo
 * que un tenant con problemas no bloquea a los demás.
 */
export const inventoryMaintenance = inngest.createFunction(
  { id: "inventory-maintenance", triggers: [{ cron: "0 4 * * *" }], retries: 3 },
  async ({ step }) => {
    const tenantIds = await step.run("list-tenants", () => listOperationalTenantIds());
    let alerts = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`maintain-${tenantId}`, async () => {
        const outcome = await maintainTenantInventory(tenantId);
        return { alerts: outcome.reorder.alerts, discrepancies: outcome.discrepancies.length };
      });
      alerts += result.alerts;
    }
    return { tenants: tenantIds.length, alerts };
  },
);
