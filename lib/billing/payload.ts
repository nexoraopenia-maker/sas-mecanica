import { z } from "zod";
import { Prisma } from "@/lib/db";
import type { ComputedLine, SaleTotals, TaxContext } from "@/lib/pos/totals";
import {
  AFFECTATION_CODE,
  amountInWords,
  DOCUMENT_TYPE_CODE,
  IDENTITY_CODE,
  qrString,
  type Buyer,
  type FiscalType,
} from "./sunat";
import type { Affectation } from "@/lib/pos/totals";

/** Línea ya calculada y congelada en el comprobante (no cambia aunque cambie el catálogo). */
export type DocumentLine = {
  code: string | null;
  description: string;
  /** NIU = bien; ZZ = servicio (catálogo 03). */
  unitCode: "NIU" | "ZZ";
  quantity: string;
  /** Valor unitario sin IGV ni descuento. */
  unitValue: string;
  /** Precio unitario con IGV. */
  unitPrice: string;
  /** Descuento de la línea sin IGV. */
  discount: string;
  base: string;
  tax: string;
  total: string;
  affectation: Affectation;
};

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

/**
 * Congela una línea de venta en el formato del comprobante. Parte de la línea ya calculada para
 * que base + IGV = total en el comprobante, exactamente igual que en el ticket.
 */
export function toDocumentLine(
  input: {
    code: string | null;
    description: string;
    isService: boolean;
    quantity: string;
    affectation: Affectation;
  },
  computed: ComputedLine,
  ctx: TaxContext,
): DocumentLine {
  const rate = input.affectation === "TAXED" ? D(ctx.taxRate) : D(0);
  const qty = D(input.quantity);
  // El descuento se informa sin IGV: si el precio de lista ya lo incluye, se le quita.
  const discountBase =
    ctx.pricesIncludeTax || input.affectation !== "TAXED"
      ? D(computed.discount).div(rate.plus(1))
      : D(computed.discount);
  const grossBase = D(computed.base).plus(discountBase);
  return {
    code: input.code,
    description: input.description,
    unitCode: input.isService ? "ZZ" : "NIU",
    quantity: qty.toString(),
    unitValue: grossBase.div(qty).toDecimalPlaces(6).toString(),
    unitPrice: grossBase.times(rate.plus(1)).div(qty).toDecimalPlaces(4).toString(),
    discount: discountBase.toDecimalPlaces(2).toFixed(2),
    base: computed.base,
    tax: computed.tax,
    total: computed.lineTotal,
    affectation: input.affectation,
  };
}

export interface Issuer {
  ruc: string;
  name: string;
  tradeName: string | null;
  address: string | null;
}

export interface InvoicePayload {
  documentTypeCode: string;
  series: string;
  correlative: number;
  issueDate: string;
  currency: string;
  paymentTerms: "Contado" | "Credito";
  issuer: Issuer;
  customer: { identityCode: string; docNumber: string; name: string; address: string | null };
  items: Array<{
    code: string | null;
    description: string;
    unitCode: string;
    quantity: string;
    unitValue: string;
    unitPrice: string;
    discount: string;
    affectationCode: string;
    base: string;
    tax: string;
    total: string;
  }>;
  totals: {
    taxed: string;
    exempt: string;
    unaffected: string;
    tax: string;
    discount: string;
    total: string;
    legend: string;
  };
  related: { typeCode: string; series: string; correlative: number } | null;
  note: { reasonCode: string; reason: string } | null;
  qr: string;
}

export interface PayloadSource {
  type: FiscalType;
  series: string;
  correlative: number;
  issueDate: Date;
  currency: string;
  isCredit: boolean;
  buyer: Buyer | null;
  lines: DocumentLine[];
  totals: Pick<SaleTotals, "taxed" | "exempt" | "unaffected" | "tax" | "discount" | "total">;
  related: { type: FiscalType; series: string; correlative: number } | null;
  note: { reasonCode: string; reason: string } | null;
}

/**
 * Carga neutral para cualquier OSE/PSE, con los códigos de los catálogos SUNAT. Cada adaptador de
 * proveedor la traduce a su API; el sistema no depende del formato de ningún proveedor.
 */
export function buildPayload(source: PayloadSource, issuer: Issuer): InvoicePayload {
  const buyer = source.buyer;
  return {
    documentTypeCode: DOCUMENT_TYPE_CODE[source.type],
    series: source.series,
    correlative: source.correlative,
    issueDate: new Date(source.issueDate.getTime() - 5 * 3_600_000).toISOString().slice(0, 10),
    currency: source.currency,
    paymentTerms: source.isCredit ? "Credito" : "Contado",
    issuer,
    customer: buyer
      ? {
          identityCode: IDENTITY_CODE[buyer.docType],
          docNumber: buyer.docNumber,
          name: buyer.name,
          address: buyer.address ?? null,
        }
      : { identityCode: "0", docNumber: "-", name: "CLIENTES VARIOS", address: null },
    items: source.lines.map((line) => ({
      code: line.code,
      description: line.description,
      unitCode: line.unitCode,
      quantity: line.quantity,
      unitValue: line.unitValue,
      unitPrice: line.unitPrice,
      discount: line.discount,
      affectationCode: AFFECTATION_CODE[line.affectation],
      base: line.base,
      tax: line.tax,
      total: line.total,
    })),
    totals: { ...source.totals, legend: amountInWords(source.totals.total, source.currency) },
    related: source.related
      ? {
          typeCode: DOCUMENT_TYPE_CODE[source.related.type],
          series: source.related.series,
          correlative: source.related.correlative,
        }
      : null,
    note: source.note,
    qr: qrString({
      issuerRuc: issuer.ruc,
      type: source.type,
      series: source.series,
      correlative: source.correlative,
      tax: source.totals.tax,
      total: source.totals.total,
      issueDate: source.issueDate,
      buyer,
    }),
  };
}

export const documentLineSchema = z.object({
  code: z.string().nullable(),
  description: z.string(),
  unitCode: z.enum(["NIU", "ZZ"]),
  quantity: z.string(),
  unitValue: z.string(),
  unitPrice: z.string(),
  discount: z.string(),
  base: z.string(),
  tax: z.string(),
  total: z.string(),
  affectation: z.enum(["TAXED", "EXEMPT", "UNAFFECTED"]),
});

export const buyerSchema = z.object({
  docType: z.enum(["DNI", "RUC", "CE", "PASSPORT", "OTHER"]),
  docNumber: z.string(),
  name: z.string(),
  address: z.string().nullable().optional(),
});

/** Lo que se congela en `customerSnapshot`. */
export const customerSnapshotSchema = z.object({
  buyer: buyerSchema.nullable(),
  isCredit: z.boolean(),
});
export type CustomerSnapshot = z.infer<typeof customerSnapshotSchema>;

/** Totales de SUNAT calculados desde las líneas congeladas (una sola fuente de verdad). */
export function totalsOfLines(
  lines: DocumentLine[],
): Pick<SaleTotals, "taxed" | "exempt" | "unaffected" | "tax" | "discount" | "total" | "subtotal"> {
  let taxed = D(0);
  let exempt = D(0);
  let unaffected = D(0);
  let tax = D(0);
  let discount = D(0);
  let total = D(0);
  for (const line of lines) {
    if (line.affectation === "EXEMPT") exempt = exempt.plus(line.base);
    else if (line.affectation === "UNAFFECTED") unaffected = unaffected.plus(line.base);
    else taxed = taxed.plus(line.base);
    tax = tax.plus(line.tax);
    discount = discount.plus(line.discount);
    total = total.plus(line.total);
  }
  return {
    taxed: taxed.toFixed(2),
    exempt: exempt.toFixed(2),
    unaffected: unaffected.toFixed(2),
    tax: tax.toFixed(2),
    discount: discount.toFixed(2),
    subtotal: taxed.plus(exempt).plus(unaffected).toFixed(2),
    total: total.toFixed(2),
  };
}
