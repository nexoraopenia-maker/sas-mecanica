import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import { loadPlan } from "./limits";

export interface PlanLimitRow {
  id: "users" | "branches" | "warehouses";
  label: string;
  used: number;
  /** null = ilimitado. */
  max: number | null;
}

export interface PlanOverview {
  name: string;
  limits: PlanLimitRow[];
  features: Array<{ label: string; included: boolean }>;
}

/** Plan vigente con sus límites y el uso actual (usuarios, sucursales, almacenes). */
export async function getPlanOverview(actor: AuthUser): Promise<PlanOverview> {
  requirePermission(actor, "settings:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const { plan } = await loadPlan(tx);
    const tenant = await tx.tenant.findFirstOrThrow({ include: { plan: true } });
    const [users, branches, warehouses] = await Promise.all([
      tx.user.count({ where: { status: { not: "DISABLED" } } }),
      tx.branch.count(),
      tx.warehouse.count(),
    ]);
    return {
      name: tenant.plan.name,
      limits: [
        { id: "users", label: "Usuarios", used: users, max: plan.maxUsers },
        { id: "branches", label: "Sucursales", used: branches, max: plan.maxBranches },
        {
          id: "warehouses",
          label: "Almacenes",
          used: warehouses,
          max: plan.multiWarehouse ? plan.maxWarehouses : 1,
        },
      ],
      features: [
        { label: "Taller completo", included: tenant.plan.fullWorkshop },
        { label: "Alertas de stock", included: tenant.plan.stockAlerts },
        { label: "Agente de compras con IA", included: tenant.plan.aiPurchasingAgent },
        { label: "Varios almacenes", included: tenant.plan.multiWarehouse },
      ],
    };
  });
}
