import { Prisma } from "@/lib/db";

export interface MarginContext {
  taxRate: string | number;
  pricesIncludeTax: boolean;
}

/** Precio sin IGV: el costo de compra se registra sin impuesto, así que el margen se mide sobre el valor de venta neto. */
export function netSalePrice(
  price: string | number,
  taxAffectation: "TAXED" | "EXEMPT" | "UNAFFECTED",
  ctx: MarginContext,
): Prisma.Decimal {
  const value = new Prisma.Decimal(price);
  if (taxAffectation !== "TAXED" || !ctx.pricesIncludeTax) return value;
  return value.div(new Prisma.Decimal(ctx.taxRate).plus(1));
}

/** Margen % = (precio neto − costo) / precio neto, con 1 decimal. Sin costo o sin precio no hay margen (null). */
export function marginPercent(
  netPrice: Prisma.Decimal,
  cost: string | number | null | undefined,
): string | null {
  if (cost === null || cost === undefined) return null;
  const c = new Prisma.Decimal(cost);
  if (c.lte(0) || netPrice.lte(0)) return null;
  return netPrice.minus(c).div(netPrice).times(100).toDecimalPlaces(1).toFixed(1);
}
