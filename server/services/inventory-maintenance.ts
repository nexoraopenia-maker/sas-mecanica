import { withPlatform, withTenant } from "@/lib/db";
import { logger } from "@/lib/logger";
import { findOldTireLots } from "./catalog";
import { reconcileAndNotify, type StockDiscrepancy } from "./reconcile";
import { recomputeReorderPolicies, type RecomputeSummary } from "./reorder";

export interface TenantMaintenanceResult {
  tenantId: string;
  reorder: RecomputeSummary;
  discrepancies: StockDiscrepancy[];
  oldTireLots: number;
}

/** Tenants operativos: activos, no eliminados y (si son demo) no vencidos. */
export async function listOperationalTenantIds(now: Date = new Date()): Promise<string[]> {
  const tenants = await withPlatform((db) =>
    db.tenant.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        OR: [{ isDemo: false }, { demoExpiresAt: { gt: now } }],
      },
      select: { id: true },
    }),
  );
  return tenants.map((tenant) => tenant.id);
}

/**
 * Mantenimiento diario de inventario de UN tenant, en una sola transacción con RLS:
 *  1. recalcula mínimos y puntos de reorden (rotación 30/90 días) y alerta stock bajo;
 *  2. concilia saldos contra el kardex;
 *  3. avisa de llantas con DOT más antiguo que el máximo configurado (una vez al mes por lote).
 * Idempotente: repetirlo no duplica notificaciones.
 */
export async function maintainTenantInventory(
  tenantId: string,
  now: Date = new Date(),
): Promise<TenantMaintenanceResult> {
  return withTenant(
    tenantId,
    async (tx) => {
      const reorder = await recomputeReorderPolicies(tx, now);
      const discrepancies = await reconcileAndNotify(tx, now);
      const oldLots = await findOldTireLots(tx, now);
      if (oldLots.length > 0) {
        const month = now.toISOString().slice(0, 7);
        await tx.notification.createMany({
          data: oldLots.map((lot) => ({
            kind: "stock.old_tire",
            severity: "WARNING" as const,
            title: `Llantas antiguas: ${lot.name}`,
            body: `DOT ${lot.dotCode ?? "s/n"} (${lot.ageYears} años) con ${lot.quantity} unidades en stock.`,
            data: {
              lotId: lot.lotId,
              productId: lot.productId,
              dotCode: lot.dotCode,
              ageYears: lot.ageYears,
              quantity: lot.quantity,
            },
            dedupeKey: `tire-age:${lot.lotId}:${month}`,
          })),
          skipDuplicates: true,
        });
      }
      return { tenantId, reorder, discrepancies, oldTireLots: oldLots.length };
    },
    { timeoutMs: 120_000 },
  );
}

/** Corre el mantenimiento en todos los tenants; el fallo de uno no detiene a los demás. */
export async function maintainAllTenants(
  now: Date = new Date(),
): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  for (const tenantId of await listOperationalTenantIds(now)) {
    try {
      await maintainTenantInventory(tenantId, now);
      ok += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, tenantId }, "falló el mantenimiento de inventario del tenant");
    }
  }
  return { ok, failed };
}
