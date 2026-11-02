import type { PrismaClient } from "@/lib/db/generated/client.ts";

/**
 * Habilita LOGIN en el rol `sas_app` (creado sin contraseña por la migración)
 * y le asigna la contraseña. `format('%L')` escapa el literal en el servidor.
 */
export async function enableAppRole(client: PrismaClient, password: string): Promise<void> {
  if (password.length < 8) throw new Error("APP_DB_PASSWORD debe tener al menos 8 caracteres");
  const rows = await client.$queryRaw<{ statement: string }[]>`
    SELECT format('ALTER ROLE sas_app WITH LOGIN PASSWORD %L', ${password}::text) AS statement`;
  const statement = rows[0]?.statement;
  if (!statement) throw new Error("No se pudo preparar ALTER ROLE");
  await client.$executeRawUnsafe(statement);
}
