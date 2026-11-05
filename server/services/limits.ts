import type { AppModule, TenantTx } from "@/lib/db";
import { ModuleDisabledError, PlanLimitError } from "@/lib/errors";
import { effectiveModuleList } from "@/lib/modules";

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
): Promise<{ plan: PlanFacts; enabledModules: AppModule[]; disabledModules: AppModule[] }> {
  const tenant = await tx.tenant.findFirstOrThrow({ include: { plan: true, settings: true } });
  return {
    plan: tenant.plan,
    enabledModules: tenant.settings?.enabledModules ?? [],
    disabledModules: tenant.settings?.disabledModules ?? [],
  };
}

/**
 * Módulos efectivos = los del plan, sin los que el SuperAdmin apagó para este cliente (y respetando la lista
 * blanca heredada si existe). Al subir de plan se activan solos los nuevos; al bajar desaparecen.
 */
export function effectiveModules(
  plan: Pick<PlanFacts, "includedModules">,
  enabledModules: AppModule[],
  disabledModules: AppModule[] = [],
): AppModule[] {
  return effectiveModuleList(plan.includedModules, disabledModules, enabledModules);
}

function limitFor(plan: PlanFacts, resource: LimitedResource): number | null {
  if (resource === "users") return plan.maxUsers;
  if (resource === "branches") return plan.maxBranches;
  // Sin plan multialmacén solo se permite un almacén.
  return plan.multiWarehouse ? plan.maxWarehouses : 1;
}

async function currentUsage(tx: TenantTx, resource: LimitedResource): Promise<number> {
  if (resource === "users") return tx.user.count({ where: { status: { not: "DISABLED" } } });
  // Una sucursal o almacén desactivado libera su cupo en el plan.
  if (resource === "branches") return tx.branch.count({ where: { isActive: true } });
  return tx.warehouse.count({ where: { isActive: true } });
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
  const { plan, enabledModules, disabledModules } = await loadPlan(tx);
  if (!effectiveModules(plan, enabledModules, disabledModules).includes(module))
    throw new ModuleDisabledError(module);
}

/** ¿El cliente tiene este módulo activo (en su plan y sin apagar por el SuperAdmin)? */
export async function isModuleEnabled(tx: TenantTx, module: AppModule): Promise<boolean> {
  const { plan, enabledModules, disabledModules } = await loadPlan(tx);
  return effectiveModules(plan, enabledModules, disabledModules).includes(module);
}
