import { maintainTenantBilling } from "@/server/services/billing-maintenance";
import { listOperationalTenantIds } from "@/server/services/inventory-maintenance";
import { inngest } from "./client";

/** Cada día (14:00 UTC = 09:00 Lima): deudas vencidas con recordatorio y cotizaciones vencidas, por tenant. */
export const billingMaintenance = inngest.createFunction(
  { id: "billing-maintenance", triggers: [{ cron: "0 14 * * *" }], retries: 3 },
  async ({ step }) => {
    const tenantIds = await step.run("list-tenants", () => listOperationalTenantIds());
    let overdue = 0;
    let reminded = 0;
    let dueSoon = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`billing-${tenantId}`, async () => {
        const outcome = await maintainTenantBilling(tenantId);
        return {
          overdue: outcome.receivables.overdue,
          reminded: outcome.receivables.reminded,
          dueSoon: outcome.receivables.dueSoon,
        };
      });
      overdue += result.overdue;
      reminded += result.reminded;
      dueSoon += result.dueSoon;
    }
    return { tenants: tenantIds.length, overdue, reminded, dueSoon };
  },
);
