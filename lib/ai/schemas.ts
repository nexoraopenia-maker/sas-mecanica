import { z } from "zod";

/**
 * Esquemas de lo que el MODELO puede devolver. Se usan dos veces: para generar el
 * JSON Schema del function calling / Structured Outputs y para validar la respuesta.
 * Todo lo que salga de aquí se vuelve a validar contra la BD (ids, precios, topes).
 */
export const proposeOrdersSchema = z.object({
  orders: z
    .array(
      z.object({
        supplierId: z.string(),
        items: z.array(
          z.object({ productId: z.string(), quantity: z.number(), rationale: z.string() }),
        ),
        message: z.string(),
      }),
    )
    .max(20),
});
export type ProposeOrders = z.infer<typeof proposeOrdersSchema>;

/** Extracción de datos de la respuesta de un proveedor. Sin herramientas: solo texto → datos. */
export const supplierReplySchema = z.object({
  intent: z.enum(["quote", "shipped", "other"]),
  items: z.array(z.object({ sku: z.string(), unitPrice: z.number().nullable() })),
  etaDate: z.string().nullable(),
  summary: z.string(),
});
export type SupplierReply = z.infer<typeof supplierReplySchema>;

/** JSON Schema para la API (estricto: sin `$schema`). */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}
