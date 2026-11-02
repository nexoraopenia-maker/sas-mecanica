import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { adminClient, appRawClient } from "../helpers/db.ts";

/** Catálogos globales: sin `tenantId` por diseño (solo lectura para la app). */
const GLOBAL_TABLES = new Set([
  "plans",
  "permissions",
  "tenants",
  "rate_limit_buckets",
  "_prisma_migrations",
]);

/** FK simples permitidas hacia tablas con `tenantId` NULLABLE (users): el SuperAdmin no tiene tenant. */
/** Su tenantId es el tenant OBJETIVO y lo escribe el cliente privilegiado: no hay DEFAULT de contexto. */
const NO_CONTEXT_DEFAULT = new Set(["impersonation_sessions"]);

const ALLOWED_SIMPLE_FKS = new Set([
  "auth_tokens.userId->users",
  "impersonation_sessions.superAdminUserId->users",
]);

describe("cobertura de RLS, privilegios y esquema", () => {
  let admin: PrismaClient;

  beforeAll(() => {
    admin = adminClient();
  });
  afterAll(async () => {
    await admin.$disconnect();
  });

  async function tables() {
    return admin.$queryRaw<
      {
        name: string;
        rls: boolean;
        forced: boolean;
        has_tenant: boolean;
        tenant_nullable: boolean;
        tenant_default: string | null;
      }[]
    >`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (a.attname IS NOT NULL) AS has_tenant,
             COALESCE(NOT a.attnotnull, false) AS tenant_nullable,
             pg_get_expr(d.adbin, d.adrelid) AS tenant_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.relkind = 'r'
      ORDER BY c.relname`;
  }

  it("toda tabla es global (lista explícita) o lleva tenantId", async () => {
    const unclassified = (await tables())
      .filter((t) => !t.has_tenant && !GLOBAL_TABLES.has(t.name))
      .map((t) => t.name);
    expect(unclassified).toEqual([]);
  });

  it("toda tabla con tenantId tiene RLS habilitado, FORZADO y la política tenant_isolation", async () => {
    const scoped = (await tables()).filter((t) => t.has_tenant);
    expect(scoped.length).toBeGreaterThan(50);
    expect(scoped.filter((t) => !t.rls || !t.forced).map((t) => t.name)).toEqual([]);

    const policies = await admin.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname = 'tenant_isolation'`;
    const withPolicy = new Set(policies.map((p) => p.tablename));
    expect(scoped.filter((t) => !withPolicy.has(t.name)).map((t) => t.name)).toEqual([]);
    expect(withPolicy.has("tenants")).toBe(true);
  });

  it("tenantId obligatorio => DEFAULT app_current_tenant()", async () => {
    const missing = (await tables())
      .filter(
        (t) =>
          t.has_tenant &&
          !t.tenant_nullable &&
          !NO_CONTEXT_DEFAULT.has(t.name) &&
          t.tenant_default !== "app_current_tenant()",
      )
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("catálogos globales también tienen RLS (plans, permissions, tenants)", async () => {
    const all = await tables();
    for (const name of ["plans", "permissions", "tenants"]) {
      expect(all.find((t) => t.name === name)?.rls, name).toBe(true);
    }
  });

  it("toda FK entre tablas de tenant es compuesta e incluye tenantId", async () => {
    const fks = await admin.$queryRaw<
      {
        source: string;
        target: string;
        col_names: string;
        includes_tenant: boolean;
        target_has_tenant: boolean;
      }[]
    >`
      SELECT s.relname AS source, t.relname AS target,
             (SELECT string_agg(a.attname, ',') FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey)) AS col_names,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.conrelid AND a.attnum = ANY (con.conkey) AND a.attname = 'tenantId') AS includes_tenant,
             EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = con.confrelid AND a.attname = 'tenantId' AND NOT a.attisdropped) AS target_has_tenant
      FROM pg_constraint con
      JOIN pg_class s ON s.oid = con.conrelid
      JOIN pg_class t ON t.oid = con.confrelid
      WHERE con.contype = 'f' AND s.relnamespace = 'public'::regnamespace`;
    const offenders = fks
      .filter((fk) => fk.target_has_tenant && !fk.includes_tenant)
      .map((fk) => `${fk.source}.${fk.col_names}->${fk.target}`)
      .filter((label) => !ALLOWED_SIMPLE_FKS.has(label));
    expect(offenders).toEqual([]);
  });

  it("los índices únicos *_active son parciales (borrado lógico)", async () => {
    const indexes = await admin.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE '%\\_active'`;
    expect(indexes.length).toBeGreaterThanOrEqual(11);
    expect(
      indexes
        .filter((i) => !/WHERE \(?"deletedAt" IS NULL\)?/.test(i.indexdef))
        .map((i) => i.indexname),
    ).toEqual([]);
  });

  describe("rol de la aplicación (sas_app)", () => {
    it("no es superusuario, no tiene BYPASSRLS y no es dueño de ninguna tabla", async () => {
      const [role] = await admin.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]
      >`
        SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'sas_app'`;
      expect(role).toEqual({
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
      });
      const owned = await admin.$queryRaw<
        { tablename: string }[]
      >`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'sas_app'`;
      expect(owned).toEqual([]);
    });

    it("privilegios mínimos: append-only, saldos de solo lectura, sin DELETE en soft delete", async () => {
      const privilege = async (table: string, op: string) => {
        const rows = await admin.$queryRawUnsafe<{ ok: boolean }[]>(
          `SELECT has_table_privilege('sas_app', 'public.${table}', '${op}') AS ok`,
        );
        return rows[0]?.ok;
      };
      for (const table of ["kardex_movements", "audit_logs"]) {
        expect(await privilege(table, "INSERT"), `${table} INSERT`).toBe(true);
        expect(await privilege(table, "UPDATE"), `${table} UPDATE`).toBe(false);
        expect(await privilege(table, "DELETE"), `${table} DELETE`).toBe(false);
      }
      for (const table of [
        "stock_balances",
        "stock_lot_balances",
        "plans",
        "permissions",
        "subscriptions",
        "tenants",
        "impersonation_sessions",
      ]) {
        expect(await privilege(table, "INSERT"), `${table} INSERT`).toBe(false);
        expect(await privilege(table, "DELETE"), `${table} DELETE`).toBe(false);
        expect(await privilege(table, "SELECT"), `${table} SELECT`).toBe(true);
      }
      const softDeleteTables = await admin.$queryRaw<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'deletedAt'`;
      expect(softDeleteTables.length).toBeGreaterThan(10);
      for (const { table_name } of softDeleteTables) {
        expect(await privilege(table_name, "DELETE"), `${table_name} DELETE`).toBe(false);
      }
      expect(await privilege("_prisma_migrations", "SELECT")).toBe(false);
    });
  });
});

describe("zona horaria", () => {
  it("la base y el rol de la app operan en UTC (el adaptador de Prisma lo asume)", async () => {
    const admin = adminClient();
    try {
      const [db] = await admin.$queryRaw<
        { tz: string }[]
      >`SELECT current_setting('TimeZone') AS tz`;
      expect(db?.tz).toBe("UTC");
      const app = appRawClient();
      const [role] = await app.$queryRaw<
        { tz: string }[]
      >`SELECT current_setting('TimeZone') AS tz`;
      expect(role?.tz).toBe("UTC");
      await app.$disconnect();
    } finally {
      await admin.$disconnect();
    }
  });
});
