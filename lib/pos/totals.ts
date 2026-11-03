// Aritmética decimal también disponible en el navegador (el mostrador calcula totales sin conexión).
import { Decimal } from "@/lib/decimal";

export type Affectation = "TAXED" | "EXEMPT" | "UNAFFECTED";

export interface PricedLine {
  quantity: string | number;
  unitPrice: string | number;
  /** Monto (no porcentaje) descontado de la línea, en la misma base que el precio. */
  discount: string | number;
  affectation: Affectation;
}

export interface ComputedLine {
  /** quantity × unitPrice, antes del descuento. */
  gross: string;
  discount: string;
  /** Valor sin impuesto de la línea. */
  base: string;
  tax: string;
  /** Lo que paga el cliente por la línea (base + impuesto). */
  lineTotal: string;
  discountPercent: string;
}

export interface SaleTotals {
  /** Operaciones gravadas / exoneradas / inafectas (valor sin impuesto), como las pide SUNAT. */
  taxed: string;
  exempt: string;
  unaffected: string;
  tax: string;
  discount: string;
  /** Base total sin impuesto. */
  subtotal: string;
  total: string;
}

export interface TaxContext {
  /** Tasa como fracción (0.18). */
  taxRate: string | number;
  /** Si el precio de lista ya incluye el IGV (lo habitual en mostrador). */
  pricesIncludeTax: boolean;
}

const D = (value: string | number | Decimal): Decimal => new Decimal(value);
const r2 = (value: Decimal): Decimal => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/** Calcula una línea. Todo en Decimal: nunca se usa coma flotante con dinero. */
export function computeLine(line: PricedLine, ctx: TaxContext): ComputedLine {
  const gross = D(line.quantity).times(D(line.unitPrice));
  const discount = D(line.discount);
  if (discount.isNegative()) throw new RangeError("El descuento no puede ser negativo");
  if (discount.gt(gross)) throw new RangeError("El descuento supera el valor de la línea");
  const rate = D(ctx.taxRate);
  const taxed = line.affectation === "TAXED";
  const net = gross.minus(discount);

  let base: Decimal;
  let tax: Decimal;
  let total: Decimal;
  if (ctx.pricesIncludeTax || !taxed) {
    total = r2(net);
    base = taxed ? r2(total.div(rate.plus(1))) : total;
    tax = total.minus(base);
  } else {
    base = r2(net);
    tax = r2(base.times(rate));
    total = base.plus(tax);
  }
  return {
    gross: r2(gross).toFixed(2),
    discount: r2(discount).toFixed(2),
    base: base.toFixed(2),
    tax: tax.toFixed(2),
    lineTotal: total.toFixed(2),
    discountPercent: gross.isZero() ? "0.00" : r2(discount.div(gross).times(100)).toFixed(2),
  };
}

export function computeSale(
  lines: PricedLine[],
  ctx: TaxContext,
): { lines: ComputedLine[]; totals: SaleTotals } {
  const computed = lines.map((line) => computeLine(line, ctx));
  let taxed = D(0);
  let exempt = D(0);
  let unaffected = D(0);
  let tax = D(0);
  let discount = D(0);
  let total = D(0);
  computed.forEach((line, index) => {
    const affectation = lines[index]?.affectation;
    const base = D(line.base);
    if (affectation === "EXEMPT") exempt = exempt.plus(base);
    else if (affectation === "UNAFFECTED") unaffected = unaffected.plus(base);
    else taxed = taxed.plus(base);
    tax = tax.plus(line.tax);
    discount = discount.plus(line.discount);
    total = total.plus(line.lineTotal);
  });
  return {
    lines: computed,
    totals: {
      taxed: taxed.toFixed(2),
      exempt: exempt.toFixed(2),
      unaffected: unaffected.toFixed(2),
      tax: tax.toFixed(2),
      discount: discount.toFixed(2),
      subtotal: taxed.plus(exempt).plus(unaffected).toFixed(2),
      total: total.toFixed(2),
    },
  };
}

/** Reparte un monto entre partes proporcionales a `weights`; el resto de céntimos va a la última. */
export function allocate(amount: string, weights: Array<string | number>): string[] {
  const total = weights.reduce<Decimal>((sum, w) => sum.plus(w), D(0));
  if (weights.length === 0) return [];
  if (total.isZero()) throw new RangeError("No hay con qué repartir");
  const shares: string[] = [];
  let assigned = D(0);
  weights.forEach((weight, index) => {
    const share =
      index === weights.length - 1
        ? D(amount).minus(assigned)
        : r2(D(amount).times(weight).div(total));
    assigned = assigned.plus(share);
    shares.push(share.toFixed(2));
  });
  return shares;
}

/** Porcentaje de descuento efectivo de una línea, para compararlo con el tope del rol. */
export function exceedsDiscountLimit(line: ComputedLine, maxPercent: number): boolean {
  return D(line.discountPercent).gt(D(maxPercent));
}
