import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { type Prisma, withTenant } from "@/lib/db";
import { daysOfCover } from "@/lib/inventory/reorder-math";
import { effectiveThresholds, stockStatus, type StockStatus } from "@/lib/inventory/status";
import { stockListSchema, type StockListInput } from "@/lib/validation/inventory";

export interface StockRow {
  productId: string;
  sku: string;
  name: string;
  kind: string;
  warehouseId: string;
  warehouse: string;
  quantity: number;
  status: StockStatus;
  minStock: number;
  reorderPoint: number;
  mode: "AUTO" | "MANUAL";
  avgDailySales30: number | null;
  avgDailySales90: number | null;
  daysOfCover: number | null;
  /** Solo con `purchasing:ver_costos_compra`. */
  avgCost?: string;
  stockValue?: string;
}

const ORDER: Record<StockStatus, number> = { CRITICAL: 0, REORDER: 1, OPTIMAL: 2 };

/** Existencias con semáforo, ordenadas por urgencia. Costos solo para quien puede verlos. */
export async function listStock(actor: AuthUser, input: StockListInput = {}): Promise<StockRow[]> {
  requirePermission(actor, "inventory:ver");
  const data = stockListSchema.parse(input);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");

  return withTenant(requireTenantId(actor), async (tx) => {
    const where: Prisma.StockBalanceWhereInput = {
      ...(data.warehouseId ? { warehouseId: data.warehouseId } : {}),
      product: {
        ...(data.kind ? { kind: data.kind } : {}),
        ...(data.q
          ? {
              OR: [
                { sku: { contains: data.q, mode: "insensitive" } },
                { name: { contains: data.q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
    };
    const balances = await tx.stockBalance.findMany({
      where,
      include: {
        product: { select: { sku: true, name: true, kind: true } },
        warehouse: { select: { name: true } },
      },
      take: 2000,
    });
    const policies = await tx.reorderPolicy.findMany({
      where: { productId: { in: balances.map((b) => b.productId) } },
    });
    const policyByKey = new Map(policies.map((p) => [`${p.warehouseId}:${p.productId}`, p]));

    const rows = balances.map((balance): StockRow => {
      const policy = policyByKey.get(`${balance.warehouseId}:${balance.productId}`) ?? null;
      const thresholds = effectiveThresholds(policy);
      const quantity = Number(balance.quantity);
      const d30 = policy?.avgDailySales30 ? Number(policy.avgDailySales30) : null;
      const d90 = policy?.avgDailySales90 ? Number(policy.avgDailySales90) : null;
      const demand = d30 !== null || d90 !== null ? 0.6 * (d30 ?? 0) + 0.4 * (d90 ?? 0) : 0;
      return {
        productId: balance.productId,
        sku: balance.product.sku,
        name: balance.product.name,
        kind: balance.product.kind,
        warehouseId: balance.warehouseId,
        warehouse: balance.warehouse.name,
        quantity,
        status: stockStatus(quantity, thresholds),
        minStock: thresholds.minStock,
        reorderPoint: thresholds.reorderPoint,
        mode: policy?.mode ?? "AUTO",
        avgDailySales30: d30,
        avgDailySales90: d90,
        daysOfCover: daysOfCover(quantity, demand),
        ...(canSeeCost
          ? {
              avgCost: balance.avgCost.toString(),
              stockValue: balance.avgCost.times(balance.quantity).toFixed(2),
            }
          : {}),
      };
    });
    return rows
      .filter((row) => !data.status || row.status === data.status)
      .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name))
      .slice(0, data.limit);
  });
}

export interface StockSummary {
  critical: number;
  reorder: number;
  optimal: number;
  total: number;
}

export async function stockSummary(actor: AuthUser): Promise<StockSummary> {
  const rows = await listStock(actor, { limit: 500 });
  const count = (status: StockStatus) => rows.filter((row) => row.status === status).length;
  return {
    critical: count("CRITICAL"),
    reorder: count("REORDER"),
    optimal: count("OPTIMAL"),
    total: rows.length,
  };
}

/** Panel de alertas del dashboard: notificaciones de stock sin leer. */
export async function listStockAlerts(actor: AuthUser, limit = 50) {
  requirePermission(actor, "inventory:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.notification.findMany({
      where: { kind: { startsWith: "stock." }, readAt: null },
      orderBy: [{ createdAt: "desc" }],
      take: limit,
      select: {
        id: true,
        kind: true,
        severity: true,
        title: true,
        body: true,
        data: true,
        createdAt: true,
      },
    }),
  );
}

export async function markAlertsRead(actor: AuthUser, ids: string[]): Promise<number> {
  requirePermission(actor, "inventory:ver");
  const result = await withTenant(requireTenantId(actor), (tx) =>
    tx.notification.updateMany({
      where: { id: { in: ids }, readAt: null },
      data: { readAt: new Date() },
    }),
  );
  return result.count;
}

export async function listWarehouses(actor: AuthUser) {
  requirePermission(actor, "inventory:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.warehouse.findMany({
      where: { isActive: true },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
  );
}
