/**
 * Habilita el rol de aplicación `sas_app` con la contraseña de APP_DB_PASSWORD.
 * Ejecutar con el rol dueño (DIRECT_URL) después de `prisma migrate deploy`.
 *
 *   npm run db:app-role
 */
import { z } from "zod";
import { createClient } from "@/lib/db/raw.ts";
import { enableAppRole } from "./lib/app-role.ts";

try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: se usa el entorno del proceso.
}

const env = z
  .object({ DIRECT_URL: z.url(), APP_DB_PASSWORD: z.string().min(8) })
  .parse(process.env);

const client = createClient(env.DIRECT_URL);
try {
  await enableAppRole(client, env.APP_DB_PASSWORD);
  console.log("Rol sas_app habilitado (LOGIN, NOBYPASSRLS).");
} finally {
  await client.$disconnect();
}
