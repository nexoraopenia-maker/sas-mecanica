/**
 * Convierte en índices PARCIALES (WHERE "deletedAt" IS NULL) los índices únicos
 * cuyo nombre termina en `_active`. Prisma no sabe expresar índices parciales,
 * así que se declaran en schema.prisma con `map: "..._active"` y este script
 * ajusta el SQL recién generado.
 *
 * Uso: npm run db:partialize [-- prisma/migrations/<carpeta>/migration.sql]
 * Sin argumento procesa la migración más reciente. Es idempotente.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = "prisma/migrations";

function latestMigrationFile(): string {
  const dirs = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const last = dirs.at(-1);
  if (!last) throw new Error("No hay migraciones en prisma/migrations");
  return join(MIGRATIONS_DIR, last, "migration.sql");
}

const target = process.argv[2] ?? latestMigrationFile();
const sql = readFileSync(target, "utf8");

const pattern = /^(CREATE UNIQUE INDEX "[^"]+_active" ON "[^"]+"\([^)]*\))(;)$/gm;
let count = 0;
const result = sql.replace(pattern, (_match, head: string, semi: string) => {
  count += 1;
  return `${head} WHERE "deletedAt" IS NULL${semi}`;
});

writeFileSync(target, result);
console.log(`${target}: ${count} índice(s) único(s) convertidos a parciales`);
