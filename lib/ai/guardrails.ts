/**
 * Guardrails del agente de compras. Función PURA y determinista: se ejecuta
 * después del LLM y su resultado manda sobre cualquier cosa que el modelo diga.
 */
export type GuardrailViolation =
  | "SUPPLIER_NOT_WHITELISTED"
  | "MAX_ORDER_AMOUNT"
  | "MAX_QTY_PER_SKU"
  | "MAX_ORDERS_PER_DAY"
  | "NO_LIMITS_CONFIGURED";

export interface GuardrailLimits {
  maxOrderAmount: number | null;
  maxQtyPerSku: number | null;
  maxOrdersPerDay: number;
}

export interface GuardrailInput {
  supplierWhitelisted: boolean;
  /** Total del pedido (precios de la BD, nunca los del modelo). */
  total: number;
  items: Array<{ sku: string; quantity: number }>;
  /** Pedidos de IA ya colocados hoy (incluye los de esta misma corrida). */
  ordersPlacedToday: number;
  limits: GuardrailLimits;
  mode: "DRAFT_APPROVAL" | "AUTOMATIC";
}

export const VIOLATION_LABELS: Record<GuardrailViolation, string> = {
  SUPPLIER_NOT_WHITELISTED: "El proveedor no está en la lista blanca",
  MAX_ORDER_AMOUNT: "Supera el monto máximo por pedido",
  MAX_QTY_PER_SKU: "Supera la cantidad máxima por SKU",
  MAX_ORDERS_PER_DAY: "Supera el máximo de pedidos por día",
  NO_LIMITS_CONFIGURED: "No hay topes configurados para el modo automático",
};

export function evaluateGuardrails(input: GuardrailInput): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];
  const { limits } = input;
  if (!input.supplierWhitelisted) violations.push("SUPPLIER_NOT_WHITELISTED");
  if (limits.maxOrderAmount !== null && input.total > limits.maxOrderAmount)
    violations.push("MAX_ORDER_AMOUNT");
  if (
    limits.maxQtyPerSku !== null &&
    input.items.some((item) => item.quantity > (limits.maxQtyPerSku ?? Infinity))
  ) {
    violations.push("MAX_QTY_PER_SKU");
  }
  if (input.ordersPlacedToday + 1 > limits.maxOrdersPerDay) violations.push("MAX_ORDERS_PER_DAY");
  // Fallo seguro: el modo automático sin topes explícitos nunca envía solo.
  if (
    input.mode === "AUTOMATIC" &&
    (limits.maxOrderAmount === null || limits.maxQtyPerSku === null)
  ) {
    violations.push("NO_LIMITS_CONFIGURED");
  }
  return violations;
}

/** El pedido solo sale sin intervención humana en modo automático y sin ninguna violación. */
export function canAutoSend(
  mode: "DRAFT_APPROVAL" | "AUTOMATIC",
  violations: GuardrailViolation[],
): boolean {
  return mode === "AUTOMATIC" && violations.length === 0;
}
