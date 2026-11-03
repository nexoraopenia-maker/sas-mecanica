import {
  computeSale,
  exceedsDiscountLimit,
  type Affectation,
  type SaleTotals,
  type TaxContext,
} from "./totals";
import { validateIssuance, type Buyer } from "@/lib/billing/sunat";

/** Línea del carrito tal como la ve el mostrador (cantidades y montos como texto, nunca coma flotante). */
export interface DraftLine {
  name: string;
  unitPrice: string;
  quantity: string;
  discount: string;
  affectation: Affectation;
}

export type DraftPricing =
  | { ok: true; totals: SaleTotals; lines: Array<{ lineTotal: string }> }
  | { ok: false; error: string };

/**
 * Totales del carrito calculados en el navegador con la MISMA aritmética del servidor (`computeSale`):
 * son inmediatos y sirven sin conexión. El servidor vuelve a calcular todo al cobrar y es la fuente de verdad.
 */
export function priceDraft(
  lines: DraftLine[],
  ctx: TaxContext,
  maxDiscountPercent = 100,
): DraftPricing {
  for (const line of lines) {
    const quantity = Number(line.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0)
      return { ok: false, error: `Cantidad inválida en «${line.name}»` };
    if (!Number.isFinite(Number(line.unitPrice)) || Number(line.unitPrice) < 0)
      return { ok: false, error: `Precio inválido en «${line.name}»` };
    if (line.discount !== "" && !Number.isFinite(Number(line.discount)))
      return { ok: false, error: `Descuento inválido en «${line.name}»` };
  }
  try {
    const result = computeSale(
      lines.map((line) => ({
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discount: line.discount || "0",
        affectation: line.affectation,
      })),
      ctx,
    );
    const over = result.lines.findIndex((line) => exceedsDiscountLimit(line, maxDiscountPercent));
    if (over >= 0)
      return {
        ok: false,
        error: `El descuento de «${lines[over]?.name}» supera tu tope de ${maxDiscountPercent} %`,
      };
    return { ok: true, totals: result.totals, lines: result.lines };
  } catch (error) {
    if (error instanceof RangeError) return { ok: false, error: error.message };
    throw error;
  }
}

export interface DraftDocumentCheck {
  documentType: "BOLETA" | "FACTURA" | "NOTA_VENTA";
  total: number;
  buyer: Buyer | null;
  /** El mostrador está sin conexión: la factura y el crédito se emiten solo en línea. */
  offline: boolean;
  isCredit: boolean;
}

/**
 * Misma validación que hace el servidor al emitir (RUC en facturas, identificar al cliente en boletas
 * mayores al tope), más las reglas propias del modo sin conexión. Devuelve el motivo o null.
 */
export function validateDraftDocument(check: DraftDocumentCheck): string | null {
  if (check.offline && check.documentType === "FACTURA")
    return "Las facturas se emiten solo con conexión: SUNAT exige validar el RUC del cliente. Usa boleta o nota de venta.";
  if (check.offline && check.isCredit)
    return "Las ventas a crédito requieren conexión para validar el límite del cliente.";
  if (check.documentType === "NOTA_VENTA") return null;
  return validateIssuance(check.documentType, check.total, check.buyer);
}
