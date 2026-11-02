export interface TotalsItem {
  quantity: number;
  unitPrice: number;
  discount: number;
  taxable: boolean;
  approvalStatus: "PENDING" | "APPROVED" | "REJECTED";
  /** Repuestos devueltos al almacén dejan de cobrarse. */
  returned: boolean;
}

export interface Totals {
  subtotal: number;
  taxTotal: number;
  total: number;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Cuenta mixta (mano de obra + repuestos). Los ítems rechazados por el cliente y los
 * repuestos devueltos no suman; los pendientes sí (es el presupuesto vigente).
 * El precio NO incluye impuesto (el IGV se suma sobre los ítems gravados).
 */
export function computeTotals(items: TotalsItem[], taxRate: number): Totals {
  let subtotal = 0;
  let tax = 0;
  for (const item of items) {
    if (item.approvalStatus === "REJECTED" || item.returned) continue;
    const line = Math.max(0, item.quantity * item.unitPrice - item.discount);
    subtotal += line;
    if (item.taxable) tax += line * taxRate;
  }
  return { subtotal: round2(subtotal), taxTotal: round2(tax), total: round2(subtotal + tax) };
}
