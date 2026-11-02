import { z } from "zod";
import { PAYMENT_METHODS } from "@/lib/pos/cash";
import { costSchema, idempotencyKeySchema, quantitySchema } from "./inventory";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");

/** Monto de dinero positivo con hasta 2 decimales. */
export const moneySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine(
    (value) => /^\d{1,10}(\.\d{1,2})?$/.test(value) && Number(value) > 0,
    "Monto inválido (mayor que 0, hasta 2 decimales)",
  );

export const methodSchema = z.enum(PAYMENT_METHODS);

export const saleLineSchema = z
  .object({
    productId: z.uuid().optional(),
    /** Obligatoria si no hay producto (servicio o mano de obra libre). */
    description: text(200).optional(),
    quantity: quantitySchema,
    /** Solo para líneas sin producto: el precio de un producto siempre sale del catálogo. */
    unitPrice: costSchema.optional(),
    /** Descuento en monto sobre la línea (limitado por el tope del rol). */
    discount: costSchema.default("0"),
    lotId: z.uuid().optional(),
    serials: z.array(text(60).min(3)).min(1).max(200).optional(),
  })
  .superRefine((line, ctx) => {
    if (!line.productId) {
      if (!line.description || line.description.length < 3)
        ctx.addIssue({ code: "custom", path: ["description"], message: "Describe el servicio" });
      if (line.unitPrice === undefined)
        ctx.addIssue({
          code: "custom",
          path: ["unitPrice"],
          message: "Indica el precio del servicio",
        });
      if (line.serials || line.lotId)
        ctx.addIssue({
          code: "custom",
          path: ["serials"],
          message: "Solo los productos llevan lote o serie",
        });
    } else if (line.unitPrice !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unitPrice"],
        message: "El precio de un producto sale del catálogo; usa el descuento",
      });
    }
  });
export type SaleLineInput = z.input<typeof saleLineSchema>;

export const paymentSchema = z.object({
  method: methodSchema,
  amount: moneySchema,
  reference: text(80).optional(),
});

const saleBase = z.object({
  idempotencyKey: idempotencyKeySchema,
  documentType: z.enum(["BOLETA", "FACTURA", "NOTA_VENTA"]).default("BOLETA"),
  customerId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  warehouseId: z.uuid().optional(),
  payments: z.array(paymentSchema).max(6).default([]),
  isCredit: z.boolean().default(false),
  creditDays: z.coerce.number().int().min(1).max(365).optional(),
  notes: text(300).optional(),
});

function paymentRules(
  sale: { isCredit: boolean; customerId?: string | undefined; payments: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (sale.isCredit && !sale.customerId)
    ctx.addIssue({
      code: "custom",
      path: ["customerId"],
      message: "Una venta a crédito exige un cliente",
    });
  if (!sale.isCredit && sale.payments.length === 0)
    ctx.addIssue({ code: "custom", path: ["payments"], message: "Registra al menos un pago" });
}

export const saleSchema = saleBase
  .extend({ items: z.array(saleLineSchema).min(1, "Agrega al menos un ítem").max(100) })
  .superRefine(paymentRules);
/** Facturar una OT: los ítems salen de la propia orden y el cliente es el de la OT. */
export const workOrderSaleSchema = saleBase
  .omit({ customerId: true, vehicleId: true })
  .extend({ workOrderId: z.uuid() })
  .superRefine((sale, ctx) => paymentRules({ ...sale, customerId: "from-work-order" }, ctx));
export type WorkOrderSaleInput = z.input<typeof workOrderSaleSchema>;
export type SaleInput = z.input<typeof saleSchema>;

export const voidSaleSchema = z.object({
  saleId: z.uuid(),
  reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
  /** Medio con el que se devuelve el dinero cobrado (por defecto, el original de cada pago). */
  refundMethod: methodSchema.optional(),
});

export const returnSchema = z.object({
  saleId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  reason: text(300).min(5, "Indica el motivo (mínimo 5 caracteres)"),
  resolution: z.enum(["REFUND", "CREDIT_NOTE"]),
  refundMethod: methodSchema.default("CASH"),
  items: z
    .array(
      z.object({
        saleItemId: z.uuid(),
        quantity: quantitySchema,
        restock: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(100),
});
export type ReturnInput = z.input<typeof returnSchema>;

export const openCashSchema = z.object({
  branchId: z.uuid().optional(),
  openingAmount: z
    .union([z.string(), z.number()])
    .transform((value) => String(value).trim())
    .refine((value) => /^\d{1,10}(\.\d{1,2})?$/.test(value), "Monto inválido"),
});

export const cashMovementSchema = z.object({
  type: z.enum(["INCOME", "EXPENSE"]),
  amount: moneySchema,
  reason: text(200).min(3, "Indica el motivo"),
});

export const closeCashSchema = z.object({
  sessionId: z.uuid(),
  /** Conteo físico por medio de pago; el efectivo es obligatorio. */
  counted: z.object({
    CASH: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .refine((v) => /^\d{1,10}(\.\d{1,2})?$/.test(v), "Efectivo contado inválido"),
    CARD: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
    TRANSFER: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
    YAPE: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
    PLIN: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
    OTHER: z
      .string()
      .trim()
      .regex(/^\d{1,10}(\.\d{1,2})?$/)
      .optional(),
  }),
  notes: text(300).optional(),
});

export type CloseCashInput = z.input<typeof closeCashSchema>;

export const quoteLineSchema = z
  .object({
    productId: z.uuid().optional(),
    description: text(200).optional(),
    quantity: quantitySchema,
    unitPrice: costSchema.optional(),
    discount: costSchema.default("0"),
    isLabor: z.boolean().default(false),
  })
  .superRefine((line, ctx) => {
    if (!line.productId && (!line.description || line.description.length < 3))
      ctx.addIssue({ code: "custom", path: ["description"], message: "Describe el ítem" });
    if (!line.productId && line.unitPrice === undefined)
      ctx.addIssue({ code: "custom", path: ["unitPrice"], message: "Indica el precio" });
  });

export const quoteSchema = z.object({
  customerId: z.uuid().optional(),
  vehicleId: z.uuid().optional(),
  validDays: z.coerce.number().int().min(1).max(90).default(7),
  notes: text(500).optional(),
  items: z.array(quoteLineSchema).min(1, "Agrega al menos un ítem").max(100),
});
export type QuoteInput = z.input<typeof quoteSchema>;

export const collectSchema = z.object({
  receivableId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  method: methodSchema,
  amount: moneySchema,
  reference: text(80).optional(),
});
export type CollectInput = z.input<typeof collectSchema>;

export const debitNoteSchema = z.object({
  documentId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  reasonCode: z.enum(["01", "02", "03"]),
  description: text(200).min(3),
  amount: moneySchema,
});
export type DebitNoteInput = z.input<typeof debitNoteSchema>;

const seriesSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{4}$/, "La serie tiene 4 caracteres (letras o números)");

export const invoiceSettingsSchema = z
  .object({
    provider: z.enum(["NONE", "SIMULATED", "HTTP"]),
    baseUrl: z.string().trim().max(300).optional(),
    token: z.string().trim().max(500).optional(),
    clearToken: z.boolean().default(false),
    boletaSeries: seriesSchema,
    facturaSeries: seriesSchema,
    creditNoteBoletaSeries: seriesSchema,
    creditNoteFacturaSeries: seriesSchema,
    debitNoteBoletaSeries: seriesSchema,
    debitNoteFacturaSeries: seriesSchema,
    saleNoteSeries: seriesSchema,
    defaultCreditDays: z.coerce.number().int().min(1).max(365),
    cashTolerance: z.coerce.number().min(0).max(1000),
  })
  .superRefine((value, ctx) => {
    if (value.provider === "HTTP" && !value.baseUrl)
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "Indica la URL del proveedor (HTTPS)",
      });
  });
export type InvoiceSettingsInput = z.input<typeof invoiceSettingsSchema>;
