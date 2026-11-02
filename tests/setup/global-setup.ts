import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@/lib/db/raw.ts";
import { enableAppRole } from "../../scripts/lib/app-role.ts";
import { seedPlatform } from "@/server/services/platform-seed";

const APP_PASSWORD = "sas_app_test_pw";

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

/**
 * Crea una base nueva por ejecución, aplica las migraciones REALES (las mismas
 * que producción) y habilita el rol `sas_app`. Las pruebas corren contra esa
 * base con el rol sin BYPASSRLS.
 */
export default async function setup() {
  const maintenanceUrl =
    process.env.TEST_ADMIN_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/postgres";
  const dbName = `sas_test_${randomBytes(4).toString("hex")}`;
  const adminUrl = withDatabase(maintenanceUrl, dbName);

  const maintenance = createClient(maintenanceUrl);
  await maintenance.$executeRawUnsafe(`CREATE DATABASE ${dbName}`);

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DIRECT_URL: adminUrl },
    stdio: "pipe",
  });

  const owner = createClient(adminUrl);
  await enableAppRole(owner, APP_PASSWORD);
  await seedPlatform(owner);
  await owner.$disconnect();

  process.env.ADMIN_DATABASE_URL = adminUrl;
  process.env.DATABASE_URL = withCredentials(adminUrl, "sas_app", APP_PASSWORD);
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.SESSION_SECRET = randomBytes(32).toString("base64url");
  process.env.APP_URL = "http://localhost:3000";
  process.env.LOG_LEVEL = "silent";

  return async () => {
    await maintenance.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await maintenance.$disconnect();
  };
}
