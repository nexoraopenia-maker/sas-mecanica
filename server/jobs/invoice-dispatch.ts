import { dispatchPendingForTenant } from "@/server/services/billing";
import { listOperationalTenantIds } from "@/server/services/inventory-maintenance";
import { inngest } from "./client";

/** Cada 5 minutos: envía al OSE/PSE los comprobantes pendientes que ya tocan (reintentos con backoff). */
export const invoiceDispatch = inngest.createFunction(
  { id: "invoice-dispatch", triggers: [{ cron: "*/5 * * * *" }], retries: 1 },
  async ({ step }) => {
    const tenantIds = await step.run("list-tenants", () => listOperationalTenantIds());
    let sent = 0;
    let rejected = 0;
    let retry = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`dispatch-${tenantId}`, () =>
        dispatchPendingForTenant(tenantId),
      );
      sent += result.sent;
      rejected += result.rejected;
      retry += result.retry;
    }
    return { tenants: tenantIds.length, sent, rejected, retry };
  },
);
