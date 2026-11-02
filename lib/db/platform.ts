import { getAdminClient } from "./raw.ts";
import type { AdminClient } from "./admin.ts";

/**
 * Lecturas de PLATAFORMA sin auditoría por llamada (validar la sesión del
 * SuperAdmin, métricas, listados). Solo para SELECT: cualquier escritura debe
 * usar `withAdmin()`, que exige motivo y deja registro.
 */
export async function withPlatform<T>(fn: (db: AdminClient) => Promise<T>): Promise<T> {
  return fn(getAdminClient());
}
