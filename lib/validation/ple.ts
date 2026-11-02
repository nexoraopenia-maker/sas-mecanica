import { z } from "zod";
import { isValidRuc, documentError } from "@/lib/workshop/documents";
import { PURCHASE_DOC_TYPES } from "@/lib/ple/spec";
import { uuidSchema } from "./common";

const MIN_YEAR = 2000;
const MAX_YEAR = 2099;

/** Periodo del libro: mes y año calendario (se acepta texto de formulario o URL). */
export const pleMonthSchema = z.object({
  year: z.coerce.number().int().min(MIN_YEAR, "Año inválido").max(MAX_YEAR, "Año inválido"),
  month: z.coerce.number().int().min(1, "Mes inválido").max(12, "Mes inválido"),
});
export type PleMonth = z.infer<typeof pleMonthSchema>;

export const pleBookSchema = z.enum(["14.1", "8.1"], { error: "Libro inválido" });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida (AAAA-MM-DD)");
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Importe inválido (máx. 2 decimales)");
const text = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`);

/** Series y números de SUNAT: letras/dígitos/guion, sin espacios ni palotes. */
const SERIES = /^[A-Za-z0-9-]{1,20}$/;
const NUMBER = /^[A-Za-z0-9-]{1,20}$/;

/** Tolerancia al comparar el IGV declarado con base × tasa (redondeo por línea del proveedor). */
export const IGV_TOLERANCE = 0.05;

export const purchaseInvoiceSchema = z
  .object({
    docTypeCode: z.enum(PURCHASE_DOC_TYPES, { error: "Tipo de comprobante inválido" }),
    series: z.string().trim().toUpperCase().regex(SERIES, "Serie inválida"),
    number: z.string().trim().toUpperCase().regex(NUMBER, "Número inválido"),
    issueDate: day,
    dueDate: day.optional(),
    /** Mes en que se anota; por defecto el de la emisión. Formato AAAA-MM. */
    period: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Periodo inválido (AAAA-MM)")
      .optional(),
    supplierId: uuidSchema.optional(),
    supplierDocType: z.enum(["RUC", "DNI", "CE", "PASSPORT"]).default("RUC"),
    supplierDocNumber: z.string().trim().max(15).optional(),
    supplierName: text(100).optional(),
    taxedBase: money,
    igv: money,
    exemptTotal: money.default("0"),
    givesTaxCredit: z.boolean().default(true),
    paidWithBankMethod: z.boolean().default(false),
    related: z
      .object({
        docTypeCode: z.enum(PURCHASE_DOC_TYPES, { error: "Tipo de comprobante inválido" }),
        series: z.string().trim().toUpperCase().regex(SERIES, "Serie de referencia inválida"),
        number: z.string().trim().toUpperCase().regex(NUMBER, "Número de referencia inválido"),
        issueDate: day,
      })
      .optional(),
    purchaseOrderId: uuidSchema.optional(),
    notes: text(500).optional(),
    /** Tasa de IGV del tenant (se inyecta desde la configuración, no del formulario). */
    taxRate: z.number().min(0).max(1).default(0.18),
  })
  .superRefine((p, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const base = Number(p.taxedBase);
    const igv = Number(p.igv);
    if (Math.abs(igv - base * p.taxRate) > IGV_TOLERANCE)
      issue("igv", `El IGV no corresponde a la base imponible (${(p.taxRate * 100).toFixed(0)}%)`);
    if (Number(p.taxedBase) + igv + Number(p.exemptTotal) <= 0)
      issue("taxedBase", "El total debe ser mayor a cero");
    if (p.docTypeCode === "01" || p.docTypeCode === "03") {
      if (!p.supplierDocNumber && !p.supplierId)
        issue("supplierDocNumber", "Indica el documento del proveedor");
    }
    if (p.docTypeCode === "01" && p.supplierDocType !== "RUC")
      issue("supplierDocType", "La factura exige un proveedor con RUC");
    if (p.supplierDocNumber) {
      const error = documentError(p.supplierDocType, p.supplierDocNumber);
      if (error) issue("supplierDocNumber", error);
      if (p.supplierDocType === "RUC" && !isValidRuc(p.supplierDocNumber))
        issue("supplierDocNumber", "RUC inválido");
    }
    if (p.dueDate && p.dueDate < p.issueDate)
      issue("dueDate", "El vencimiento no puede ser anterior a la emisión");
    const period = p.period ?? p.issueDate.slice(0, 7);
    if (period < p.issueDate.slice(0, 7))
      issue("period", "El periodo no puede ser anterior al mes de emisión");
    if ((p.docTypeCode === "07" || p.docTypeCode === "08") && !p.related)
      issue("related", "La nota exige el comprobante que modifica");
  });
export type PurchaseInvoiceInput = z.input<typeof purchaseInvoiceSchema>;
export type PurchaseInvoiceParsed = z.output<typeof purchaseInvoiceSchema>;

export const voidPurchaseInvoiceSchema = z.object({
  id: uuidSchema,
  reason: text(300).min(3, "Indica el motivo"),
});
