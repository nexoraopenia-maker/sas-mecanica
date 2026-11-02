import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@/lib/env";
import { PrismaClient } from "./generated/client.ts";

/**
 * ÚNICO lugar donde se instancian clientes Prisma crudos. Nadie fuera de
 * lib/db debe importarlo (lo impide ESLint).
 */
export function createClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

const globalCache = globalThis as unknown as {
  __sasAppClient?: PrismaClient;
  __sasAdminClient?: PrismaClient;
};

/** Cliente con el rol `sas_app` (sin BYPASSRLS). Es la base del cliente acotado por tenant. */
export function getAppClient(): PrismaClient {
  globalCache.__sasAppClient ??= createClient(getEnv().DATABASE_URL);
  return globalCache.__sasAppClient;
}

/** Cliente privilegiado: solo `withAdmin()` lo usa. */
export function getAdminClient(): PrismaClient {
  globalCache.__sasAdminClient ??= createClient(getEnv().ADMIN_DATABASE_URL);
  return globalCache.__sasAdminClient;
}
