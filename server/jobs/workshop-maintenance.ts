import { listOperationalTenantIds } from "@/server/services/inventory-maintenance";
import { maintainTenantWorkshop } from "@/server/services/workshop-maintenance";
import { inngest } from "./client";

/** Cada día (13:00 UTC = 08:00 Lima): garantías por vencer y recordatorios de mantenimiento, por tenant. */
export const workshopMaintenance = inngest.createFunction(
  { id: "workshop-maintenance", triggers: [{ cron: "0 13 * * *" }], retries: 3 },
  async ({ step }) => {
    const tenantIds = await step.run("list-tenants", () => listOperationalTenantIds());
    let noticed = 0;
    let reminders = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`workshop-${tenantId}`, async () => {
        const outcome = await maintainTenantWorkshop(tenantId);
        return { noticed: outcome.warranties.noticed, reminders: outcome.reminders.notified };
      });
      noticed += result.noticed;
      reminders += result.reminders;
    }
    return { tenants: tenantIds.length, noticed, reminders };
  },
);
