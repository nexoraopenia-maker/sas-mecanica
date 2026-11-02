import { getAppClient } from "./raw.ts";

/** Comprueba la conexión con el rol de la app (sin contexto de tenant, no lee datos de negocio). */
export async function checkDatabase(): Promise<boolean> {
  try {
    await getAppClient().$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
