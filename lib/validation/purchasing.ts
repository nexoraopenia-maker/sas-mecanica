import { z } from "zod";
import { dotSchema } from "./catalog";
import { costSchema, idempotencyKeySchema, quantitySchema } from "./inventory";

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !value.includes("\u0000"), "El texto contiene caracteres no válidos");

export const supplierSchema = z.object({
  name: text(200).min(2, "Ingresa el nombre del proveedor"),
  taxId: text(20).optional(),
  contactName: text(120).optional(),
  email: z.string().trim().toLowerCase().max(254).pipe(z.email("Correo inválido")).optional(),
  phone: text(30).optional(),
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+?[\d\s()-]{7,20}$/, "WhatsApp inválido (ej.: +51 987 000 001)")
    .optional(),
  address: text(300).optional(),
  defaultLeadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
  paymentTerms: text(120).optional(),
  currency: z.string().trim().length(3).toUpperCase().default("PEN"),
  /** Lista blanca del agente de compras. */
  aiWhitelisted: z.boolean().optional(),
  notes: text(500).optional(),
});
export type SupplierInput = z.input<typeof supplierSchema>;

export const supplierProductSchema = z.object({
  supplierId: z.uuid(),
  productId: z.uuid(),
  supplierSku: text(60).optional(),
  price: costSchema.optional(),
  leadTimeDays: z.coerce.number().int().min(0).max(365).optional(),
  minOrderQty: quantitySchema.optional(),
  isPreferred: z.boolean().default(false),
});
export type SupplierProductInput = z.input<typeof supplierProductSchema>;

export const purchaseOrderSchema = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  conditions: text(500).optional(),
  expectedAt: z.coerce.date().optional(),
  items: z
    .array(z.object({ productId: z.uuid(), quantity: quantitySchema, unitCost: costSchema }))
    .min(1, "Agrega al menos un producto")
    .max(100),
});
export type PurchaseOrderInput = z.input<typeof purchaseOrderSchema>;

export const receiveSchema = z.object({
  orderId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  supplierDocRef: text(60).optional(),
  notes: text(300).optional(),
  lines: z
    .array(
      z.object({
        orderItemId: z.uuid(),
        quantity: quantitySchema.optional(),
        lot: z
          .object({ code: z.string().trim().min(1).max(60), dotCode: dotSchema.optional() })
          .optional(),
        serials: z.array(z.string().trim().min(3).max(60)).min(1).max(500).optional(),
        notes: text(200).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type ReceiveInput = z.input<typeof receiveSchema>;

export const supplierReturnSchema = z.object({
  supplierId: z.uuid(),
  warehouseId: z.uuid(),
  orderId: z.uuid().optional(),
  reason: text(300).min(5, "Indica el motivo de la devolución"),
  idempotencyKey: idempotencyKeySchema,
  items: z
    .array(
      z.object({
        productId: z.uuid(),
        quantity: quantitySchema.optional(),
        lotId: z.uuid().optional(),
        serials: z.array(z.string().trim().min(3).max(60)).min(1).optional(),
      }),
    )
    .min(1)
    .max(100),
});
export type SupplierReturnInput = z.input<typeof supplierReturnSchema>;

export const approveDraftSchema = z.object({
  draftId: z.uuid(),
  /** Reconocimiento explícito de los guardrails excedidos (confirmación humana). */
  confirmViolations: z.boolean().default(false),
});

export const webhookPayloadSchema = z.object({
  externalId: z.string().trim().min(1).max(120),
  from: z.string().trim().min(5).max(40),
  text: z.string().max(5_000),
  orderNumber: z.coerce.number().int().positive().optional(),
  event: z.enum(["quote", "shipped"]).optional(),
  etaDate: z.string().trim().max(40).optional(),
  quote: z
    .object({
      items: z
        .array(
          z.object({
            sku: z.string().trim().min(1).max(60),
            unitPrice: z.coerce.number().min(0).max(10_000_000),
          }),
        )
        .max(100),
    })
    .optional(),
});
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
