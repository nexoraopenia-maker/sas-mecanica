import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { MemoryStorage, setStorageForTests } from "@/server/integrations/storage";
import {
  getAutomationSwitches,
  getAiSettings,
  updateAiSettings,
  updateAutomationSwitches,
} from "@/server/services/ai-settings";
import { getInvoiceSettings, updateInvoiceSettings } from "@/server/services/billing";
import { getTenantLogoUrl, removeTenantLogo, setTenantLogo } from "@/server/services/branding";
import { notifyCustomer } from "@/server/services/customer-notify";
import { getPlanOverview } from "@/server/services/plan-overview";
import { runAgentNow } from "@/server/services/purchasing-agent";
import {
  createRole,
  createRoleFromTemplate,
  listRoles,
  setRoleCapabilities,
} from "@/server/services/roles";
import { createSale } from "@/server/services/sales";
import { configureAuthCache } from "@/server/services/session-resolver";
import {
  changeUserBranch,
  changeUserRole,
  getUsersOverview,
  inviteUser,
  setUserStatus,
} from "@/server/services/users";
import { addUser, meta } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import { jpeg, png, SVG } from "../helpers/images.ts";
import { make, plain, type InventoryWorld } from "../helpers/inventory.ts";
import { openCash, posWorld, saleKey, stockUp, type PosWorld } from "../helpers/pos.ts";

const email = () => `u-${randomUUID().slice(0, 8)}@prueba.pe`;

describe("Configuración (fase 3)", () => {
  let admin: PrismaClient;
  let w: PosWorld;
  let other: PosWorld;
  let storage: MemoryStorage;

  const roleId = async (
    world: InventoryWorld,
    k: "admin" | "cashier" | "mechanic" | "warehouse_manager",
  ) => (await admin.role.findFirstOrThrow({ where: { tenantId: world.tenantId, key: k } })).id;
  const invite =
    (world: InventoryWorld, actor: AuthUser) =>
    (input: { email: string; name: string; roleId: string }) =>
      inviteUser(actor, input, meta());
  const audit = (tenantId: string, action: string) =>
    admin.auditLog.findMany({ where: { tenantId, action }, orderBy: { occurredAt: "desc" } });

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    storage = new MemoryStorage();
    setStorageForTests(storage);
    w = await posWorld(admin);
    other = await posWorld(admin);
  }, 240_000);
  afterAll(async () => {
    setStorageForTests(null);
    await admin.$disconnect();
  });

  describe("usuarios", () => {
    it("con una sola sucursal activa la asigna sola y la audita", async () => {
      const branches = await admin.branch.findMany({
        where: { tenantId: w.tenantId, isActive: true },
      });
      expect(branches).toHaveLength(1);
      const { userId } = await inviteUser(
        w.admin,
        { email: email(), name: "Ana Sucursal", roleId: await roleId(w, "cashier") },
        meta(),
      );
      const row = await admin.user.findUniqueOrThrow({ where: { id: userId } });
      expect(row.defaultBranchId).toBe(branches[0]?.id);
      const entry = (await audit(w.tenantId, "user.invited")).find((a) => a.entityId === userId);
      expect(entry?.after).toMatchObject({ branchId: branches[0]?.id });
    });

    it("con varias sucursales usa la elegida y rechaza una sucursal ajena o inexistente", async () => {
      const second = await admin.branch.create({
        data: { tenantId: w.tenantId, code: "S2", name: "Sucursal Sur", isActive: true },
      });
      const { userId } = await inviteUser(
        w.admin,
        {
          email: email(),
          name: "Beto Sur",
          roleId: await roleId(w, "cashier"),
          branchId: second.id,
        },
        meta(),
      );
      expect((await admin.user.findUniqueOrThrow({ where: { id: userId } })).defaultBranchId).toBe(
        second.id,
      );
      const foreign = await admin.branch.findFirstOrThrow({ where: { tenantId: other.tenantId } });
      await expect(
        inviteUser(
          w.admin,
          {
            email: email(),
            name: "X Ajena",
            roleId: await roleId(w, "cashier"),
            branchId: foreign.id,
          },
          meta(),
        ),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      const overview = await getUsersOverview(w.admin);
      expect(overview.branches.map((b) => b.id)).toContain(second.id);
      expect(overview.branches.map((b) => b.id)).not.toContain(foreign.id);
    });

    it("cambia la sucursal de un usuario (auditado) y no toca usuarios de otro negocio", async () => {
      const branch = await admin.branch.findFirstOrThrow({
        where: { tenantId: w.tenantId, code: "S2" },
      });
      await changeUserBranch(w.admin, { userId: w.cashier.userId, branchId: branch.id }, meta());
      expect(
        (await admin.user.findUniqueOrThrow({ where: { id: w.cashier.userId } })).defaultBranchId,
      ).toBe(branch.id);
      expect((await audit(w.tenantId, "user.branch_changed"))[0]?.after).toMatchObject({
        branchId: branch.id,
      });
      await expect(
        changeUserBranch(other.admin, { userId: w.cashier.userId, branchId: null }, meta()),
      ).rejects.toMatchObject({ name: "NotFoundError" });
      await expect(
        changeUserBranch(w.cashier, { userId: w.cashier.userId, branchId: null }, meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });

    it("respeta el límite de usuarios del plan, incluida la reactivación", async () => {
      const world = await posWorld(admin);
      const plan = await admin.plan.create({
        data: {
          code: `tope-${randomUUID().slice(0, 6)}`,
          name: "Tope",
          priceMonthly: 0,
          maxUsers: 3,
          includedModules: [],
        },
      });
      await admin.tenant.update({ where: { id: world.tenantId }, data: { planId: plan.id } });
      const used = (await getUsersOverview(world.admin)).usage;
      expect(used.max).toBe(3);
      // posWorld ya tiene admin, jefe, cajero, mecánico y cajero 2: hay que bajar a 2 activos para probar.
      const others = [world.manager, world.mechanic, world.cashier2];
      for (const user of others) await setUserStatus(world.admin, user.userId, "DISABLED", meta());
      await admin.user.update({
        where: { id: world.cashier.userId },
        data: { status: "DISABLED" },
      });
      expect((await getUsersOverview(world.admin)).usage).toMatchObject({
        used: 1,
        reached: false,
      });
      await inviteUser(
        world.admin,
        { email: email(), name: "Uno", roleId: await roleId(world, "cashier") },
        meta(),
      );
      await inviteUser(
        world.admin,
        { email: email(), name: "Dos", roleId: await roleId(world, "cashier") },
        meta(),
      );
      const full = await getUsersOverview(world.admin);
      expect(full.usage).toMatchObject({ used: 3, max: 3, reached: true });
      await expect(
        inviteUser(
          world.admin,
          { email: email(), name: "Tres", roleId: await roleId(world, "cashier") },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "PLAN_LIMIT" });
      // Reactivar a alguien ocupa un cupo igual que invitarlo.
      await expect(
        setUserStatus(world.admin, world.manager.userId, "ACTIVE", meta()),
      ).rejects.toMatchObject({
        code: "PLAN_LIMIT",
      });
    }, 120_000);

    it("un administrador no puede desactivarse a sí mismo ni quitar al último administrador", async () => {
      await expect(
        setUserStatus(w.admin, w.admin.userId, "DISABLED", meta()),
      ).rejects.toMatchObject({
        code: "SELF_DISABLE",
      });
      // Un segundo administrador puede desactivar al primero… hasta que quede uno solo.
      const second = await addUser(
        invite(w, w.admin),
        admin,
        w.tenantId,
        await roleId(w, "admin"),
        "Admin Dos",
      );
      await setUserStatus(second, w.admin.userId, "DISABLED", meta());
      await expect(setUserStatus(w.admin, second.userId, "DISABLED", meta())).rejects.toMatchObject(
        {
          code: "LAST_ADMIN",
        },
      );
      // Reactivado el primero, quitar el rol de administrador al otro dejaría a uno; al último no se le puede.
      await setUserStatus(second, w.admin.userId, "ACTIVE", meta());
      await changeUserRole(w.admin, second.userId, await roleId(w, "cashier"), meta());
      await expect(
        changeUserRole(second, w.admin.userId, await roleId(w, "cashier"), meta()),
      ).rejects.toBeTruthy();
      await expect(
        changeUserRole(w.admin, w.admin.userId, await roleId(w, "cashier"), meta()),
      ).rejects.toMatchObject({
        code: "LAST_ADMIN",
      });
      expect((await admin.user.findUniqueOrThrow({ where: { id: w.admin.userId } })).status).toBe(
        "ACTIVE",
      );
    }, 120_000);

    it("nadie sin ser administrador puede otorgar el rol Administrador", async () => {
      const role = await createRole(
        w.admin,
        {
          name: "Gestor de usuarios",
          permissions: ["users:ver", "users:crear", "users:editar"],
          maxDiscountPercent: 0,
        },
        meta(),
      );
      const manager = await addUser(invite(w, w.admin), admin, w.tenantId, role.id, "Gestor");
      const adminRole = await roleId(w, "admin");
      await expect(
        inviteUser(manager, { email: email(), name: "Falso Admin", roleId: adminRole }, meta()),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
      await expect(
        changeUserRole(manager, manager.userId, adminRole, meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      // Sí puede invitar con roles no administrativos.
      await expect(
        inviteUser(
          manager,
          { email: email(), name: "Cajero Nuevo", roleId: await roleId(w, "cashier") },
          meta(),
        ),
      ).resolves.toBeTruthy();
    }, 120_000);

    it("el listado y el uso solo incluyen al propio negocio", async () => {
      const mine = await getUsersOverview(w.admin);
      const theirs = await getUsersOverview(other.admin);
      expect(mine.users.map((u) => u.id)).not.toContain(other.admin.userId);
      expect(theirs.users.map((u) => u.id)).not.toContain(w.admin.userId);
    });
  });

  describe("roles", () => {
    it("crea «Asesor de servicio» con un clic, sin costos ni ajuste de stock, y no repite", async () => {
      const created = await createRoleFromTemplate(w.admin, "asesor_servicio", meta());
      const role = (await listRoles(w.admin)).find((r) => r.id === created.id);
      expect(role).toMatchObject({ name: "Asesor de servicio", key: null, isSystem: false });
      expect(role?.permissions).toEqual(
        expect.arrayContaining([
          "pos:crear",
          "cash:crear",
          "workshop:crear",
          "customers:editar",
          "pos:ver",
        ]),
      );
      expect(role?.permissions).not.toContain("purchasing:ver_costos_compra");
      expect(role?.permissions).not.toContain("inventory:editar");
      expect(role?.permissions).not.toContain("inventory:crear");
      expect(role?.permissions).not.toContain("settings:editar");
      await expect(
        createRoleFromTemplate(w.admin, "asesor_servicio", meta()),
      ).rejects.toMatchObject({
        code: "ROLE_NAME_TAKEN",
      });
      await expect(createRoleFromTemplate(w.admin, "no-existe", meta())).rejects.toMatchObject({
        name: "NotFoundError",
      });
      expect((await audit(w.tenantId, "role.created")).some((a) => a.entityId === created.id)).toBe(
        true,
      );
    });

    it("la plantilla exige permiso en el servidor", async () => {
      await expect(
        createRoleFromTemplate(w.cashier, "asesor_servicio", meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });

    it("la matriz de capacidades cambia solo sus permisos y deja el resto intacto", async () => {
      const role = (await listRoles(w.admin)).find((r) => r.name === "Cajero/Vendedor");
      if (!role) throw new Error("falta el rol");
      const before = role.permissions;
      await setRoleCapabilities(
        w.admin,
        { roleId: role.id, enabled: ["vender", "costos", "anular"] },
        meta(),
      );
      const after = (await listRoles(w.admin)).find((r) => r.id === role.id)?.permissions ?? [];
      expect(after).toEqual(
        expect.arrayContaining(["purchasing:ver_costos_compra", "pos:anular_venta", "pos:crear"]),
      );
      expect(after).not.toContain("inventory:editar");
      // Todo lo que no es capacidad de la matriz sigue igual (p. ej. clientes, caja, garantías).
      for (const keep of before.filter(
        (k) =>
          ![
            "pos:crear",
            "purchasing:ver_costos_compra",
            "pos:anular_venta",
            "workshop:ver",
            "inventory:editar",
            "settings:editar",
          ].includes(k),
      ))
        expect(after).toContain(keep);
      expect(after).not.toContain("workshop:ver");
      const entry = (await audit(w.tenantId, "role.permissions_changed"))[0];
      expect(entry?.after).toMatchObject({
        permissions: expect.arrayContaining(["pos:anular_venta"]),
      });
      // El Administrador es inmutable y exige permiso.
      const adminRole = (await listRoles(w.admin)).find((r) => r.key === "admin");
      await expect(
        setRoleCapabilities(w.admin, { roleId: adminRole?.id ?? "", enabled: [] }, meta()),
      ).rejects.toMatchObject({
        code: "ROLE_IMMUTABLE",
      });
      await expect(
        setRoleCapabilities(w.cashier, { roleId: role.id, enabled: [] }, meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      // Otro negocio no puede tocar un rol ajeno.
      await expect(
        setRoleCapabilities(other.admin, { roleId: role.id, enabled: [] }, meta()),
      ).rejects.toMatchObject({
        name: "NotFoundError",
      });
    });
  });

  describe("logo", () => {
    it("sube, guarda bajo el prefijo del tenant, audita y entrega una URL temporal", async () => {
      expect(await getTenantLogoUrl(w.admin)).toBeNull();
      await setTenantLogo(w.admin, png(400, 150), meta());
      const row = await admin.tenant.findUniqueOrThrow({ where: { id: w.tenantId } });
      expect(row.logoUrl).toMatch(
        new RegExp(`^${w.tenantId}/branding/logo-\\d+-[0-9a-f]{16}\\.png$`),
      );
      expect([...storage.objects.keys()].some((k) => k.includes(`${w.tenantId}/branding/`))).toBe(
        true,
      );
      const url = await getTenantLogoUrl(w.admin);
      expect(url).toContain(`${w.tenantId}/branding/`);
      expect((await audit(w.tenantId, "tenant.logo_changed"))[0]?.after).toMatchObject({
        hasLogo: true,
        type: "image/png",
        width: 400,
        height: 150,
      });
      // Otro negocio ni lo ve ni recibe su ruta.
      expect(await getTenantLogoUrl(other.admin)).toBeNull();
    });

    it("rechaza SVG, archivos pesados y dimensiones inválidas sin guardar nada", async () => {
      const keysBefore = storage.objects.size;
      for (const bytes of [SVG, png(40, 40), png(3000, 1000), png(400, 150, 1_048_576)])
        await expect(setTenantLogo(w.admin, bytes, meta())).rejects.toMatchObject({
          code: "LOGO_INVALID",
        });
      expect(storage.objects.size).toBe(keysBefore);
    });

    it("acepta JPG, exige permiso y se puede quitar", async () => {
      await setTenantLogo(w.admin, jpeg(300, 100), meta());
      expect((await admin.tenant.findUniqueOrThrow({ where: { id: w.tenantId } })).logoUrl).toMatch(
        /\.jpg$/,
      );
      await expect(setTenantLogo(w.cashier, png(400, 150), meta())).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await expect(removeTenantLogo(w.cashier, meta())).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      await removeTenantLogo(w.admin, meta());
      expect(await getTenantLogoUrl(w.admin)).toBeNull();
      expect((await audit(w.tenantId, "tenant.logo_removed")).length).toBe(1);
    });

    it("una ruta de logo de otro tenant nunca se firma", async () => {
      await admin.tenant.update({
        where: { id: w.tenantId },
        data: { logoUrl: `${other.tenantId}/branding/logo-1-abc.png` },
      });
      await expect(getTenantLogoUrl(w.admin)).rejects.toThrow(/no pertenece al tenant/);
      await admin.tenant.update({ where: { id: w.tenantId }, data: { logoUrl: null } });
    });
  });

  describe("series de facturación", () => {
    const settings = (over: Record<string, unknown> = {}) => ({
      provider: "SIMULATED",
      boletaSeries: "B001",
      facturaSeries: "F001",
      creditNoteBoletaSeries: "BC01",
      creditNoteFacturaSeries: "FC01",
      debitNoteBoletaSeries: "BD01",
      debitNoteFacturaSeries: "FD01",
      saleNoteSeries: "NV01",
      defaultCreditDays: 30,
      cashTolerance: 1,
      ...over,
    });

    it("sin comprobantes emitidos se cambia libremente y queda auditado con todas las series", async () => {
      await updateInvoiceSettings(
        w.admin,
        settings({ boletaSeries: "B002", ticketWidthMm: 58 }) as never,
        meta(),
      );
      const view = await getInvoiceSettings(w.admin);
      expect(view).toMatchObject({ boletaSeries: "B002", ticketWidthMm: 58, seriesInUse: {} });
      const entry = (await audit(w.tenantId, "billing.settings_changed"))[0];
      expect(entry?.before).toMatchObject({ boletaSeries: "B001", ticketWidthMm: 80 });
      expect(entry?.after).toMatchObject({ boletaSeries: "B002", ticketWidthMm: 58 });
      await updateInvoiceSettings(
        w.admin,
        settings({ boletaSeries: "B001", ticketWidthMm: 80 }) as never,
        meta(),
      );
    });

    it("rechaza formatos inválidos y series repetidas", async () => {
      for (const bad of [
        { boletaSeries: "B1" },
        { boletaSeries: "F001" },
        { facturaSeries: "B001" },
        { facturaSeries: "FA01" },
      ])
        await expect(
          updateInvoiceSettings(w.admin, settings(bad) as never, meta()),
        ).rejects.toBeTruthy();
      await expect(
        updateInvoiceSettings(w.admin, settings({ saleNoteSeries: "BC01" }) as never, meta()),
      ).rejects.toThrow(/ya se usa en otro comprobante/);
    });

    it("la base de datos también impide formatos inválidos y series repetidas", async () => {
      await expect(
        admin.$executeRawUnsafe(
          `UPDATE tenant_settings SET "boletaSeries" = 'X001' WHERE "tenantId" = '${w.tenantId}'`,
        ),
      ).rejects.toThrow(/boleta_series_format/);
      await expect(
        admin.$executeRawUnsafe(
          `UPDATE tenant_settings SET "saleNoteSeries" = 'F001' WHERE "tenantId" = '${w.tenantId}'`,
        ),
      ).rejects.toThrow(/series_distinct/);
    });

    it("con comprobantes emitidos, cambiar la serie exige confirmación explícita", async () => {
      await openCash(w.cashier);
      const p = await make(w.admin, plain({ salePrice: 59 }));
      await stockUp(w, p.id, "5");
      await createSale(
        w.cashier,
        {
          idempotencyKey: saleKey(),
          documentType: "BOLETA",
          items: [{ productId: p.id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "59" }],
        } as never,
        meta(),
      );
      const view = await getInvoiceSettings(w.admin);
      expect(view.seriesInUse.B001).toBe(1);
      await expect(
        updateInvoiceSettings(w.admin, settings({ boletaSeries: "B003" }) as never, meta()),
      ).rejects.toMatchObject({
        code: "SERIES_IN_USE",
      });
      expect((await getInvoiceSettings(w.admin)).boletaSeries).toBe("B001");
      await updateInvoiceSettings(
        w.admin,
        settings({ boletaSeries: "B003", confirmSeriesChange: true }) as never,
        meta(),
      );
      expect((await getInvoiceSettings(w.admin)).boletaSeries).toBe("B003");
      const entry = (await audit(w.tenantId, "billing.settings_changed"))[0];
      expect(entry?.after).toMatchObject({ boletaSeries: "B003", seriesChangeConfirmed: true });
      // Cambiar otra serie sin uso no pide confirmación.
      await updateInvoiceSettings(
        w.admin,
        settings({ boletaSeries: "B003", facturaSeries: "F002" }) as never,
        meta(),
      );
    });

    it("exige permiso de edición y no cruza negocios", async () => {
      await expect(
        updateInvoiceSettings(w.cashier, settings() as never, meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect((await getInvoiceSettings(other.admin)).boletaSeries).toBe("B001");
    });
  });

  describe("IA y canales", () => {
    it("el agente apagado no corre (manual ni programado) y se audita", async () => {
      await updateAutomationSwitches(w.admin, { aiAgentEnabled: false }, meta());
      expect((await getAutomationSwitches(w.admin)).aiAgentEnabled).toBe(false);
      await expect(runAgentNow(w.admin, meta())).rejects.toMatchObject({ code: "AI_SWITCHED_OFF" });
      const { listAgentTenantIds } = await import("@/server/services/purchasing-agent");
      expect(await listAgentTenantIds()).not.toContain(w.tenantId);
      const entry = (await audit(w.tenantId, "ai.switches_changed"))[0];
      expect(entry?.before).toMatchObject({ aiAgentEnabled: true });
      expect(entry?.after).toMatchObject({ aiAgentEnabled: false });
      await updateAutomationSwitches(w.admin, { aiAgentEnabled: true }, meta());
    });

    it("sin avisos por WhatsApp no se encola ningún mensaje al cliente", async () => {
      const customer = await admin.customer.create({
        data: {
          tenantId: w.tenantId,
          docType: "DNI",
          docNumber: "12345678",
          name: "Cliente Aviso",
          whatsapp: "987654321",
          whatsappOptIn: true,
        },
      });
      const send = () =>
        withTenant(w.tenantId, (tx) =>
          notifyCustomer(tx, {
            customerId: customer.id,
            key: `t:${randomUUID()}`,
            body: "hola",
            relatedType: "test",
            relatedId: customer.id,
          }),
        );
      expect(["QUEUED", "SIMULATED"]).toContain(await send());
      await updateAutomationSwitches(w.admin, { whatsappNoticesEnabled: false }, meta());
      expect(await send()).toBe("SKIPPED_DISABLED");
      await updateAutomationSwitches(w.admin, { whatsappNoticesEnabled: true }, meta());
      expect(["QUEUED", "SIMULATED"]).toContain(await send());
    });

    it("la aprobación humana se cambia con permiso; sin él, nada cambia", async () => {
      expect((await getAutomationSwitches(w.admin)).humanApproval).toBe(true);
      await updateAutomationSwitches(w.admin, { humanApproval: false }, meta());
      expect((await getAiSettings(w.admin)).mode).toBe("AUTOMATIC");
      await updateAutomationSwitches(w.admin, { humanApproval: true }, meta());
      for (const input of [
        { aiAgentEnabled: false },
        { whatsappNoticesEnabled: false },
        { humanApproval: false },
      ])
        await expect(updateAutomationSwitches(w.cashier, input, meta())).rejects.toMatchObject({
          code: "PERMISSION_DENIED",
        });
      // El jefe de almacén no puede autorizar el envío automático.
      await expect(
        updateAutomationSwitches(w.manager, { humanApproval: false }, meta()),
      ).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
      expect((await getAutomationSwitches(w.admin)).humanApproval).toBe(true);
    });

    it("la clave de OpenAI se guarda cifrada, se muestra enmascarada y nunca llega a la bitácora ni al cliente", async () => {
      const apiKey = `sk-prueba${randomUUID().replace(/-/g, "")}`;
      await updateAiSettings(w.admin, { apiKey }, meta());
      const stored = await admin.tenantSettings.findFirstOrThrow({
        where: { tenantId: w.tenantId },
      });
      expect(stored.openaiApiKeyEncrypted).toBeTruthy();
      expect(stored.openaiApiKeyEncrypted).not.toContain(apiKey);
      const view = await getAiSettings(w.admin);
      expect(view.apiKeyMasked).toBe(`••••••••${apiKey.slice(-4)}`);
      expect(JSON.stringify(view)).not.toContain(apiKey);
      const logs = JSON.stringify(
        await admin.auditLog.findMany({ where: { tenantId: w.tenantId } }),
      );
      expect(logs).not.toContain(apiKey);
      expect(logs).not.toContain(apiKey.slice(0, 20));
      await expect(updateAiSettings(w.cashier, { apiKey }, meta())).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });

  describe("plan", () => {
    it("muestra el plan con sus límites y el uso actual", async () => {
      const overview = await getPlanOverview(w.admin);
      const users = overview.limits.find((l) => l.id === "users");
      expect(users?.used).toBeGreaterThan(0);
      expect(overview.limits.map((l) => l.id)).toEqual(["users", "branches", "warehouses"]);
      expect(overview.features.length).toBeGreaterThan(0);
      await expect(getPlanOverview(w.mechanic)).rejects.toMatchObject({
        code: "PERMISSION_DENIED",
      });
    });
  });

  it("los permisos de lectura de Configuración se validan en el servidor", async () => {
    await expect(getUsersOverview(w.cashier)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(getInvoiceSettings(w.mechanic)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
    await expect(getAutomationSwitches(w.mechanic))
      .resolves.toBeTruthy()
      .catch(() => undefined);
  });

  it("ningún servicio de Configuración deja pasar a un usuario sin sesión de negocio", async () => {
    const platformUser = { ...w.admin, tenantId: null } as AuthUser;
    await expect(getUsersOverview(platformUser)).rejects.toBeTruthy();
    await expect(setTenantLogo(platformUser, png(400, 150), meta())).rejects.toBeTruthy();
    await expect(
      updateAutomationSwitches(platformUser, { aiAgentEnabled: true }, meta()),
    ).rejects.toBeTruthy();
  });
});
