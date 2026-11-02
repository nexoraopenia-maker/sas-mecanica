import type { AppModule, TenantTx } from "@/lib/db";
import { ModuleDisabledError, PlanLimitError } from "@/lib/errors";

export type LimitedResource = "users" | "branches" | "warehouses";

const LABELS: Record<LimitedResource, string> = {
  users: "usuarios",
  branches: "sucursales",
  warehouses: "almacenes",
};

interface PlanFacts {
  maxBranches: number | null;
  maxUsers: number | null;
  maxWarehouses: number | null;
  multiWarehouse: boolean;
  includedModules: AppModule[];
}

export async function loadPlan(
  tx: TenantTx,
): Promise<{ plan: PlanFacts; enabledModules: AppModule[] }> {
  const tenant = await tx.tenant.findFirstOrThrow({ include: { plan: true, settings: true } });
  return { plan: tenant.plan, enabledModules: tenant.settings?.enabledModules ?? [] };
}

/** Módulos efectivos = incluidos en el plan y, si el tenant los restringió, activados por él. */
export function effectiveModules(
  plan: Pick<PlanFacts, "includedModules">,
  enabledModules: AppModule[],
): AppModule[] {
  return enabledModules.length === 0
    ? plan.includedModules
    : plan.includedModules.filter((module) => enabledModules.includes(module));
}

function limitFor(plan: PlanFacts, resource: LimitedResource): number | null {
  if (resource === "users") return plan.maxUsers;
  if (resource === "branches") return plan.maxBranches;
  // Sin plan multialmacén solo se permite un almacén.
  return plan.multiWarehouse ? plan.maxWarehouses : 1;
}

async function currentUsage(tx: TenantTx, resource: LimitedResource): Promise<number> {
  if (resource === "users") return tx.user.count({ where: { status: { not: "DISABLED" } } });
  if (resource === "branches") return tx.branch.count();
  return tx.warehouse.count();
}

/** Límites del plan aplicados en BACKEND: lanza PlanLimitError si agregar `adding` los excede. */
export async function assertWithinPlan(
  tx: TenantTx,
  resource: LimitedResource,
  adding = 1,
): Promise<void> {
  const { plan } = await loadPlan(tx);
  const max = limitFor(plan, resource);
  if (max === null) return;
  const used = await currentUsage(tx, resource);
  if (used + adding > max) throw new PlanLimitError(LABELS[resource], max);
}

export async function assertModuleEnabled(tx: TenantTx, module: AppModule): Promise<void> {
  const { plan, enabledModules } = await loadPlan(tx);
  if (!effectiveModules(plan, enabledModules).includes(module))
    throw new ModuleDisabledError(module);
}
