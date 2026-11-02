import { z } from "zod";
import { dotSchema } from "./catalog";

/** Cantidad positiva con hasta 4 decimales. Se maneja como string para no perder precisión. */
export const quantitySchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine(
    (value) => /^\d{1,10}(\.\d{1,4})?$/.test(value) && Number(value) > 0,
    "Cantidad inválida (mayor que 0, hasta 4 decimales)",
  );

export const costSchema = z
  .union([z.string(), z.number()])
  .transform((value) => String(value).trim())
  .refine((value) => /^\d{1,10}(\.\d{1,4})?$/.test(value), "Costo inválido");

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8, "La clave de idempotencia debe tener al menos 8 caracteres")
  .max(100);

const lotSchema = z.object({
  code: z.string().trim().min(1).max(60),
  dotCode: dotSchema.optional(),
});
const serialsSchema = z.array(z.string().trim().min(3).max(60)).min(1).max(500);

const target = {
  warehouseId: z.uuid(),
  productId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  reference: z.string().trim().max(120).optional(),
};

/** Entrada de mercadería / inventario inicial. El costo es obligatorio: alimenta el costo promedio. */
export const stockInSchema = z.object({
  ...target,
  type: z.enum(["PURCHASE", "INITIAL"]).default("PURCHASE"),
  quantity: quantitySchema.optional(),
  unitCost: costSchema,
  lot: lotSchema.optional(),
  serials: serialsSchema.optional(),
  reason: z.string().trim().max(300).optional(),
});
export type StockInInput = z.input<typeof stockInSchema>;

/** Ajuste manual: exige motivo (regla 16) y queda en auditoría. */
export const adjustmentSchema = z.object({
  ...target,
  direction: z.enum(["IN", "OUT"]),
  quantity: quantitySchema.optional(),
  unitCost: costSchema.optional(),
  reason: z.string().trim().min(5, "Indica el motivo del ajuste (mínimo 5 caracteres)").max(300),
  lot: lotSchema.optional(),
  lotId: z.uuid().optional(),
  serials: serialsSchema.optional(),
  allowNegative: z.boolean().default(false),
});
export type AdjustmentInput = z.input<typeof adjustmentSchema>;

export const reorderPolicySchema = z
  .object({
    warehouseId: z.uuid(),
    productId: z.uuid(),
    mode: z.enum(["AUTO", "MANUAL"]),
    manualMinStock: z.coerce.number().min(0).max(10_000_000).optional(),
    manualReorderPoint: z.coerce.number().min(0).max(10_000_000).optional(),
    seasonalityFactor: z.coerce.number().min(0.25).max(4).optional(),
  })
  .refine(
    (p) =>
      p.mode === "AUTO" || p.manualMinStock !== undefined || p.manualReorderPoint !== undefined,
    {
      message: "En modo manual indica el stock mínimo o el punto de reorden",
      path: ["manualMinStock"],
    },
  )
  .refine(
    (p) =>
      p.manualMinStock === undefined ||
      p.manualReorderPoint === undefined ||
      p.manualReorderPoint >= p.manualMinStock,
    {
      message: "El punto de reorden no puede ser menor que el stock mínimo",
      path: ["manualReorderPoint"],
    },
  );
export type ReorderPolicyInput = z.input<typeof reorderPolicySchema>;

export const transferRequestSchema = z
  .object({
    fromWarehouseId: z.uuid(),
    toWarehouseId: z.uuid(),
    notes: z.string().trim().max(300).optional(),
    items: z
      .array(
        z.object({
          productId: z.uuid(),
          quantity: quantitySchema.optional(),
          lotId: z.uuid().optional(),
          serials: serialsSchema.optional(),
        }),
      )
      .min(1, "Agrega al menos un producto")
      .max(100),
  })
  .refine((t) => t.fromWarehouseId !== t.toWarehouseId, {
    message: "El almacén de origen y destino deben ser distintos",
    path: ["toWarehouseId"],
  });
export type TransferRequestInput = z.input<typeof transferRequestSchema>;

export const transferReceiveSchema = z.object({
  transferId: z.uuid(),
  received: z
    .array(
      z.object({
        itemId: z.uuid(),
        quantity: z
          .union([z.string(), z.number()])
          .transform((v) => String(v).trim())
          .refine((v) => /^\d{1,10}(\.\d{1,4})?$/.test(v), "Cantidad inválida"),
      }),
    )
    .optional(),
});

export const openCountSchema = z.object({
  warehouseId: z.uuid(),
  cyclic: z.boolean().default(true),
  productIds: z.array(z.uuid()).max(500).optional(),
  notes: z.string().trim().max(300).optional(),
});
export type OpenCountInput = z.input<typeof openCountSchema>;

export const countEntrySchema = z.object({
  countId: z.uuid(),
  itemId: z.uuid(),
  countedQty: z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((v) => /^\d{1,10}(\.\d{1,4})?$/.test(v), "Cantidad contada inválida"),
});

export const stockListSchema = z.object({
  warehouseId: z.uuid().optional(),
  status: z.enum(["OPTIMAL", "REORDER", "CRITICAL"]).optional(),
  kind: z.enum(["TIRE", "BATTERY", "LUBRICANT", "PART", "ACCESSORY", "SERVICE"]).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export type StockListInput = z.input<typeof stockListSchema>;
