import { listAgentTenantIds, runPurchasingAgent } from "@/server/services/purchasing-agent";
import { inngest } from "./client";

/**
 * Cada día (05:00 UTC, después del recálculo de reorden): una corrida por tenant con el
 * agente habilitado. La clave de idempotencia por día evita corridas duplicadas si Inngest reintenta.
 */
export const purchasingAgent = inngest.createFunction(
  { id: "purchasing-agent", triggers: [{ cron: "0 5 * * *" }], retries: 2 },
  async ({ step }) => {
    const tenantIds = await step.run("list-tenants", () => listAgentTenantIds());
    const day = new Date().toISOString().slice(0, 10);
    let drafts = 0;
    for (const tenantId of tenantIds) {
      const result = await step.run(`agent-${tenantId}`, async () => {
        try {
          const outcome = await runPurchasingAgent({
            tenantId,
            idempotencyKey: `agent:job:${tenantId}:${day}`,
          });
          return { drafts: outcome.draftIds.length, status: outcome.status };
        } catch {
          return { drafts: 0, status: "ERROR" };
        }
      });
      drafts += result.drafts;
    }
    return { tenants: tenantIds.length, drafts };
  },
);
