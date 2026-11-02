import {
  effectiveThresholds,
  stockStatus,
  STOCK_STATUS_LABEL,
  type StockStatus,
} from "@/lib/inventory/status";
import type { TenantTx } from "@/lib/db";

const day = (now: Date): string => now.toISOString().slice(0, 10);

/**
 * Estado actual de un producto en un almacén y, si está en reorden o crítico,
 * notificación INMEDIATA al tenant (una por producto/almacén/estado/día).
 * Se invoca dentro de la misma transacción del movimiento.
 */
export async function evaluateStockAlert(
  tx: TenantTx,
  warehouseId: string,
  productId: string,
  now: Date = new Date(),
): Promise<StockStatus> {
  const [balance, policy, product] = await Promise.all([
    tx.stockBalance.findFirst({ where: { warehouseId, productId } }),
    tx.reorderPolicy.findFirst({ where: { warehouseId, productId } }),
    tx.product.findFirst({ where: { id: productId }, select: { name: true, sku: true } }),
  ]);
  const quantity = Number(balance?.quantity.toString() ?? 0);
  const thresholds = effectiveThresholds(policy);
  const status = stockStatus(quantity, thresholds);
  if (status === "OPTIMAL" || !product) return status;

  const critical = status === "CRITICAL";
  await tx.notification.createMany({
    data: [
      {
        kind: critical ? "stock.critical" : "stock.reorder",
        severity: critical ? "CRITICAL" : "WARNING",
        title: `${STOCK_STATUS_LABEL[status]}: ${product.name}`,
        body: `Quedan ${quantity} unidades (mínimo ${thresholds.minStock}, reorden ${thresholds.reorderPoint}).`,
        data: { productId, warehouseId, sku: product.sku, quantity, ...thresholds },
        dedupeKey: `stock:${status}:${warehouseId}:${productId}:${day(now)}`,
      },
    ],
    skipDuplicates: true,
  });
  return status;
}
