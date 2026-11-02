import type { TenantTx } from "./tenant.ts";

/**
 * Siguiente correlativo (OT, ventas, comprobantes...) seguro ante concurrencia:
 * el UPSERT toma el lock de la fila, así dos transacciones nunca reciben el
 * mismo número. Un rollback devuelve el número (sin huecos).
 */
export async function nextSequence(tx: TenantTx, docType: string, series = ""): Promise<number> {
  const rows = await tx.$queryRaw<{ current: number }[]>`
    INSERT INTO document_sequences (id, "tenantId", "docType", series, current)
    VALUES (gen_random_uuid(), app_current_tenant(), ${docType}, ${series}, 1)
    ON CONFLICT ("tenantId", "docType", series)
    DO UPDATE SET current = document_sequences.current + 1
    RETURNING current`;
  const row = rows[0];
  if (!row) throw new Error("No se pudo obtener el correlativo");
  return row.current;
}
