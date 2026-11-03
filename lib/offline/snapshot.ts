import type { OutboxEntry, OutboxOwner } from "./outbox";
import type { PosProduct, PosSnapshot } from "@/lib/pos/types";

/** El catálogo guardado se considera viejo pasadas estas horas (se vuelve a descargar al haber conexión). */
export const SNAPSHOT_MAX_AGE_HOURS = 6;

export interface StoredSnapshot extends OutboxOwner {
  snapshot: PosSnapshot;
  savedAt: string;
}

export function isSnapshotStale(saved: StoredSnapshot, now: Date = new Date()): boolean {
  return now.getTime() - Date.parse(saved.savedAt) > SNAPSHOT_MAX_AGE_HOURS * 3_600_000;
}

/**
 * Stock visible sin conexión: el del último catálogo menos lo ya vendido en el dispositivo y todavía sin
 * sincronizar. Así el cajero no vende dos veces la misma unidad estando sin red.
 */
export function withPendingStock(
  products: readonly PosProduct[],
  entries: readonly OutboxEntry[],
): PosProduct[] {
  const sold = new Map<string, number>();
  for (const entry of entries) {
    if (entry.status === "SYNCED") continue;
    const items = (entry.sale.items ?? []) as Array<{ productId?: string; quantity?: string }>;
    for (const item of items)
      if (item.productId)
        sold.set(item.productId, (sold.get(item.productId) ?? 0) + Number(item.quantity ?? 0));
  }
  if (sold.size === 0) return [...products];
  return products.map((product) => {
    const units = sold.get(product.id);
    if (!units || product.stock === null || !product.isStocked) return product;
    return { ...product, stock: product.stock - units };
  });
}
