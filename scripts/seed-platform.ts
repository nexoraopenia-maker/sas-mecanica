/**
 * Siembra los planes por defecto (Básico, Pro, Enterprise/IA, Demo) y el
 * catálogo global de permisos. Idempotente: se puede ejecutar en cada despliegue.
 *
 *   npm run db:seed
 */
import { z } from "zod";
import { createClient } from "@/lib/db/raw.ts";
import { seedPlatform } from "@/server/services/platform-seed";

try {
  process.loadEnvFile(".env");
} catch {
  // Sin .env: se usa el entorno del proceso.
}

const env = z.object({ DIRECT_URL: z.url() }).parse(process.env);
const client = createClient(env.DIRECT_URL);
try {
  await seedPlatform(client);
  console.log("Planes y permisos sembrados.");
} finally {
  await client.$disconnect();
}
