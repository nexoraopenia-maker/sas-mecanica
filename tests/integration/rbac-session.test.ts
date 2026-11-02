import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@/lib/auth/can";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { ConflictError, PermissionDeniedError } from "@/lib/errors";
import { withTenant } from "@/lib/db";
import { createRole, deleteRole, listRoles, setRolePermissions } from "@/server/services/roles";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import { suspendTenant, reactivateTenant } from "@/server/services/tenants";
import { changeUserRole, inviteUser, listUsers, setUserStatus } from "@/server/services/users";
import { adminClient } from "../helpers/db.ts";
import { addUser, bootstrapTenant, meta, type BootstrappedTenant } from "../helpers/auth.ts";

describe("sesión, RBAC y revocación inmediata", () => {
  let admin: PrismaClient;
  let pro: BootstrappedTenant;
  let basic: BootstrappedTenant;

  const roleId = async (
    tenantId: string,
    key: "admin" | "cashier" | "mechanic" | "warehouse_manager",
  ) => (await admin.role.findFirstOrThrow({ where: { tenantId, key } })).id;

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    pro = await bootstrapTenant(admin, "pro");
    basic = await bootstrapTenant(admin, "basic", pro.superAdmin);
  });
  afterAll(async () => {
    await admin.$disconnect();
  });

  const invite =
    (t: BootstrappedTenant) => (input: { email: string; name: string; roleId: string }) =>
      inviteUser(t.admin, input, meta());

  it("el administrador recibe los permisos de los módulos de su plan, y solo esos", async () => {
    expect(can(pro.admin, "workshop:crear")).toBe(true);
    expect(can(pro.admin, "purchasing:ver_costos_compra")).toBe(true);
    expect(can(pro.admin, "ai_agent:autorizar_pedidos_ia")).toBe(false); // Pro no incluye el agente IA
    expect(can(basic.admin, "pos:anular_venta")).toBe(true);
    expect(can(basic.admin, "workshop:ver")).toBe(false); // Básico no incluye taller
    expect(can(basic.admin, "purchasing:ver")).toBe(false);
  });

  it("los permisos se leen de la BD en cada resolución, no del token", async () => {
    const cashier = await addUser(
      invite(pro),
      admin,
      pro.tenantId,
      await roleId(pro.tenantId, "cashier"),
      "Cajera Rosa",
    );
    expect(can(cashier, "pos:crear")).toBe(true);
    expect(can(cashier, "purchasing:ver_costos_compra")).toBe(false);
    expect(cashier.roleKey).toBe("cashier");

    // El mismo "token" (claims) refleja de inmediato el cambio de permisos.
    const claims = { sub: cashier.userId, tid: pro.tenantId, sv: 1, mfa: true };
    await setRolePermissions(
      pro.admin,
      await roleId(pro.tenantId, "cashier"),
      ["customers:ver"],
      meta(),
    );
    const after = await resolveSession(claims);
    expect(after && can(after, "pos:crear")).toBe(false);
    expect(after && can(after, "customers:ver")).toBe(true);

    const audit = await admin.auditLog.findFirstOrThrow({
      where: { tenantId: pro.tenantId, action: "role.permissions_changed" },
      orderBy: { occurredAt: "desc" },
    });
    expect(audit.actorUserId).toBe(pro.adminId);
    expect((audit.before as { permissions: string[] }).permissions).toContain("pos:crear");
    expect((audit.after as { permissions: string[] }).permissions).toEqual(["customers:ver"]);
  });

  it("el cajero no puede gestionar usuarios ni ver su lista", async () => {
    const cashier = await addUser(
      invite(basic),
      admin,
      basic.tenantId,
      await roleId(basic.tenantId, "cashier"),
    );
    await expect(
      inviteUser(
        cashier,
        { email: "x@y.pe", name: "X Y", roleId: await roleId(basic.tenantId, "admin") },
        meta(),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(listUsers(cashier)).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      setRolePermissions(cashier, await roleId(basic.tenantId, "mechanic"), [], meta()),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("deshabilitar a un usuario revoca su sesión al instante (sessionVersion)", async () => {
    const worker = await addUser(
      invite(pro),
      admin,
      pro.tenantId,
      await roleId(pro.tenantId, "mechanic"),
      "Mecánico Pedro",
    );
    const claims = { sub: worker.userId, tid: pro.tenantId, sv: 1, mfa: true };
    expect(await resolveSession(claims)).not.toBeNull();
    await setUserStatus(pro.admin, worker.userId, "DISABLED", meta());
    expect(await resolveSession(claims)).toBeNull();
    await setUserStatus(pro.admin, worker.userId, "ACTIVE", meta());
    expect(await resolveSession({ ...claims, sv: 2 })).not.toBeNull(); // la versión subió: el token viejo (sv 1) sigue muerto
    expect(await resolveSession(claims)).toBeNull();
  });

  it("claims con otra sessionVersion, otro tenant o un id ajeno no autentican", async () => {
    expect(
      await resolveSession({ sub: pro.adminId, tid: pro.tenantId, sv: 999, mfa: true }),
    ).toBeNull();
    expect(
      await resolveSession({ sub: pro.adminId, tid: basic.tenantId, sv: 1, mfa: true }),
    ).toBeNull(); // usuario de A con tenant de B
    expect(
      await resolveSession({ sub: basic.adminId, tid: pro.tenantId, sv: 1, mfa: true }),
    ).toBeNull();
  });

  it("suspender un tenant invalida sus sesiones vigentes y reactivarlo las restablece", async () => {
    const victim = await bootstrapTenant(admin, "basic", pro.superAdmin);
    const claims = { sub: victim.adminId, tid: victim.tenantId, sv: 1, mfa: true };
    expect(await resolveSession(claims)).not.toBeNull();
    await suspendTenant(
      pro.superAdmin,
      { tenantId: victim.tenantId, reason: "Falta de pago" },
      meta(),
    );
    expect(await resolveSession(claims)).toBeNull();
    // Los datos se conservan.
    expect(await admin.branch.count({ where: { tenantId: victim.tenantId } })).toBe(1);
    await reactivateTenant(
      pro.superAdmin,
      { tenantId: victim.tenantId, reason: "Pago regularizado" },
      meta(),
    );
    expect(await resolveSession(claims)).not.toBeNull();
  });

  it("un SuperAdmin sin 2FA completado no tiene acceso ni a impersonar", async () => {
    const claimsNoMfa = { sub: pro.superAdmin.userId, tid: null, sv: 1, mfa: false };
    const pending = await resolveSession(claimsNoMfa);
    expect(pending?.mfaVerified).toBe(false);
    expect(pending?.permissions.size).toBe(0);
    expect(
      await resolveSession({ ...claimsNoMfa, tid: pro.tenantId, imp: crypto.randomUUID() }),
    ).toBeNull();
  });

  describe("roles personalizados", () => {
    it("crea un rol con permisos propios y lo asigna", async () => {
      const { id } = await createRole(
        pro.admin,
        {
          name: "Supervisor de piso",
          permissions: ["workshop:ver", "workshop:editar", "inventory:ver"],
        },
        meta(),
      );
      const user = await addUser(invite(pro), admin, pro.tenantId, id, "Supervisor Luis");
      expect([...user.permissions].sort()).toEqual([
        "inventory:ver",
        "workshop:editar",
        "workshop:ver",
      ]);
      expect(user.roleKey).toBeNull();
      await expect(
        createRole(pro.admin, { name: "Supervisor de piso", permissions: [] }, meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        createRole(pro.admin, { name: "Invento", permissions: ["pos:volar"] }, meta()),
      ).rejects.toThrow();
      await expect(deleteRole(pro.admin, id, meta())).rejects.toBeInstanceOf(ConflictError); // tiene usuarios
    });

    it("el rol Administrador es inmutable y los roles base no se eliminan", async () => {
      await expect(
        setRolePermissions(pro.admin, await roleId(pro.tenantId, "admin"), [], meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        deleteRole(pro.admin, await roleId(pro.tenantId, "mechanic"), meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      const roles = await listRoles(pro.admin);
      expect(
        roles
          .filter((r) => r.isSystem)
          .map((r) => r.key)
          .sort(),
      ).toEqual(["admin", "cashier", "mechanic", "warehouse_manager"]);
    });

    it("se elimina (borrado lógico) un rol sin usuarios y el usuario con rol eliminado queda sin permisos", async () => {
      const { id } = await createRole(
        pro.admin,
        { name: "Temporal", permissions: ["pos:ver"] },
        meta(),
      );
      await deleteRole(pro.admin, id, meta());
      expect((await admin.role.findUniqueOrThrow({ where: { id } })).deletedAt).not.toBeNull();
      expect((await listRoles(pro.admin)).some((r) => r.id === id)).toBe(false);
    });
  });

  describe("protecciones del último administrador", () => {
    it("no se puede deshabilitar ni degradar al único administrador activo", async () => {
      const solo = await bootstrapTenant(admin, "basic", pro.superAdmin);
      const second = await addUser(
        invite(solo),
        admin,
        solo.tenantId,
        await roleId(solo.tenantId, "admin"),
        "Segundo Admin",
      );
      // Con dos administradores, uno puede ser degradado...
      await changeUserRole(
        solo.admin,
        second.userId,
        await roleId(solo.tenantId, "cashier"),
        meta(),
      );
      // ...pero el último no.
      await expect(
        changeUserRole(solo.admin, solo.adminId, await roleId(solo.tenantId, "cashier"), meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        setUserStatus(solo.admin, solo.adminId, "DISABLED", meta()),
      ).rejects.toBeInstanceOf(PermissionDeniedError); // ni a sí mismo
    });
  });

  it("los datos de un tenant no son visibles desde servicios de otro", async () => {
    const mine = await listUsers(pro.admin);
    expect(mine.every((u) => u.id !== basic.adminId)).toBe(true);
    const seen = await withTenant(pro.tenantId, (tx) =>
      tx.user.findFirst({ where: { id: basic.adminId } }),
    );
    expect(seen).toBeNull();
  });
});
