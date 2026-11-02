import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { adminClient, appRawClient, seedTenant, type SeededTenant } from "../helpers/db.ts";

/** El login resuelve el tenant desde el email ANTES de tener contexto; RLS lo impediría sin esta función. */
describe("auth_find_user_by_email", () => {
  let admin: PrismaClient;
  let raw: PrismaClient;
  let a: SeededTenant;

  beforeAll(async () => {
    admin = adminClient();
    raw = appRawClient();
    a = await seedTenant(admin, "LOGIN");
  });
  afterAll(async () => {
    await admin.$disconnect();
    await raw.$disconnect();
  });

  const find = (email: string) =>
    raw.$queryRaw<{ id: string; tenantId: string | null; isSuperAdmin: boolean }[]>`
      SELECT id, "tenantId", "isSuperAdmin" FROM auth_find_user_by_email(${email})`;

  it("encuentra al usuario sin contexto de tenant, sin distinguir mayúsculas", async () => {
    const email = `dueno-${randomUUID()}@taller.pe`;
    const user = await admin.user.create({
      data: { tenantId: a.tenantId, email, name: "Dueño", passwordHash: "hash", status: "ACTIVE" },
    });
    // Mientras tanto, la tabla directa sigue siendo invisible para la app sin contexto.
    expect(await raw.$queryRaw`SELECT id FROM users`).toEqual([]);
    const rows = await find(email.toUpperCase());
    expect(rows).toEqual([{ id: user.id, tenantId: a.tenantId, isSuperAdmin: false }]);
  });

  it("encuentra SuperAdmin (sin tenant) y oculta usuarios con borrado lógico", async () => {
    const email = `root-${randomUUID()}@saas.pe`;
    const root = await admin.user.create({
      data: { tenantId: null, isSuperAdmin: true, email, name: "Root", status: "ACTIVE" },
    });
    expect(await find(email)).toEqual([{ id: root.id, tenantId: null, isSuperAdmin: true }]);

    await admin.user.update({ where: { id: root.id }, data: { deletedAt: new Date() } });
    expect(await find(email)).toEqual([]);
    expect(await find("no-existe@x.pe")).toEqual([]);
  });

  it("el email es único entre usuarios activos de cualquier tenant", async () => {
    const email = `dup-${randomUUID()}@taller.pe`;
    await admin.user.create({ data: { tenantId: a.tenantId, email, name: "Uno" } });
    await expect(
      admin.user.create({ data: { tenantId: a.tenantId, email, name: "Dos" } }),
    ).rejects.toThrow();
  });

  it("la restricción exige: SuperAdmin <=> sin tenant", async () => {
    await expect(
      admin.user.create({
        data: {
          tenantId: a.tenantId,
          isSuperAdmin: true,
          email: `x-${randomUUID()}@a.pe`,
          name: "x",
        },
      }),
    ).rejects.toThrow();
    await expect(
      admin.user.create({
        data: { tenantId: null, isSuperAdmin: false, email: `y-${randomUUID()}@a.pe`, name: "y" },
      }),
    ).rejects.toThrow();
  });
});
