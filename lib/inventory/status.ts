/** Semáforo de stock: Óptimo (verde), Punto de reorden (amarillo), Crítico (rojo). */
export type StockStatus = "OPTIMAL" | "REORDER" | "CRITICAL";

export interface Thresholds {
  minStock: number;
  reorderPoint: number;
}

export function stockStatus(quantity: number, thresholds: Thresholds): StockStatus {
  if (quantity <= thresholds.minStock) return "CRITICAL";
  if (quantity <= thresholds.reorderPoint) return "REORDER";
  return "OPTIMAL";
}

export interface PolicyThresholdFields {
  mode: "AUTO" | "MANUAL";
  manualMinStock: { toString(): string } | null;
  manualReorderPoint: { toString(): string } | null;
  computedMinStock: { toString(): string } | null;
  computedReorderPoint: { toString(): string } | null;
}

const num = (value: { toString(): string } | null): number | null =>
  value === null ? null : Number(value.toString());

/**
 * Umbrales vigentes: en modo MANUAL manda lo fijado por el usuario (si dejó
 * alguno vacío cae al calculado); en AUTO manda el calculado por rotación.
 * Sin política todo es 0: solo se alerta cuando el stock llega a 0.
 */
export function effectiveThresholds(policy: PolicyThresholdFields | null): Thresholds {
  if (!policy) return { minStock: 0, reorderPoint: 0 };
  const computedMin = num(policy.computedMinStock) ?? 0;
  const computedRop = num(policy.computedReorderPoint) ?? 0;
  const minStock =
    policy.mode === "MANUAL" ? (num(policy.manualMinStock) ?? computedMin) : computedMin;
  const rop =
    policy.mode === "MANUAL" ? (num(policy.manualReorderPoint) ?? computedRop) : computedRop;
  return { minStock, reorderPoint: Math.max(rop, minStock) };
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  OPTIMAL: "Óptimo",
  REORDER: "Punto de reorden",
  CRITICAL: "Crítico",
};
