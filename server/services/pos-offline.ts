import { z } from "zod";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { saleSchema } from "@/lib/validation/sales";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { createSale } from "./sales";

/** Venta guardada en el dispositivo mientras no había conexión, lista para registrarse en el servidor. */
export const offlineSaleSchema = z.object({
  /** Identificador local de la venta en la cola del dispositivo. */
  localId: z.uuid(),
  /** Cuándo se cobró en el mostrador (hora del dispositivo). Solo informativo: la venta nace al sincronizar. */
  occurredAt: z.iso.datetime(),
  sale: z.unknown(),
});
export type OfflineSaleInput = z.input<typeof offlineSaleSchema>;

export interface OfflineSyncResult {
  saleId: string;
  number: number;
  documentNumber: string | null;
  replayed: boolean;
}

/**
 * Registra una venta hecha sin conexión usando EXACTAMENTE el mismo servicio de venta en línea
 * (permisos, caja abierta, stock por kardex, series y correlativos, IGV). La clave de idempotencia de la
 * venta hace que reintentar no duplique nada. Reglas propias del modo sin conexión (defensa en profundidad:
 * el navegador ya las aplica): sin facturas (no se pudo validar el RUC) y sin ventas a crédito.
 */
export async function syncOfflineSale(
  actor: AuthUser,
  input: unknown,
  meta: RequestMeta = {},
): Promise<OfflineSyncResult> {
  requirePermission(actor, "pos:crear");
  const tenantId = requireTenantId(actor);
  const data = offlineSaleSchema.parse(input);
  // Primero las reglas propias del modo sin conexión (con el mensaje claro), luego la validación completa.
  const rules = z
    .object({ documentType: z.string(), isCredit: z.boolean().optional() })
    .parse(data.sale);
  if (rules.documentType === "FACTURA")
    throw new ConflictError(
      "OFFLINE_FACTURA",
      "Una factura no se registra desde el modo sin conexión: emítela con conexión para validar el RUC",
    );
  if (rules.isCredit)
    throw new ConflictError(
      "OFFLINE_CREDIT",
      "Una venta a crédito no se registra desde el modo sin conexión",
    );
  if (Date.parse(data.occurredAt) > Date.now() + 5 * 60_000)
    throw new ConflictError(
      "OFFLINE_CLOCK",
      "La fecha de la venta es futura: revisa el reloj del dispositivo",
    );

  const sale = saleSchema.parse(data.sale);
  const result = await createSale(actor, sale, meta);
  if (!result.replayed) {
    await withTenant(tenantId, (tx) =>
      recordAudit(tx, auditContextOf(actor, meta), {
        action: "pos.offline_sale_synced",
        entityType: "sale",
        entityId: result.id,
        after: {
          localId: data.localId,
          occurredAt: data.occurredAt,
          syncedAt: new Date().toISOString(),
          documentType: sale.documentType,
        },
      }),
    );
  }
  return {
    saleId: result.id,
    number: result.number,
    documentNumber: result.documentNumber,
    replayed: result.replayed,
  };
}
