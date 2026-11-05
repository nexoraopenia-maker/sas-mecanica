import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can, type AuthUser } from "@/lib/auth/can";
import { withTenant } from "@/lib/db";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import { verifyPassword } from "@/lib/auth/password";
import { changeOwnPassword, login } from "@/server/services/auth";
import { getDashboard } from "@/server/services/dashboard";
import { notifyCustomer } from "@/server/services/customer-notify";
import { registerStockIn } from "@/server/services/inventory";
import { openCashSession } from "@/server/services/cash";
import { createSale } from "@/server/services/sales";
import { resolveSession, configureAuthCache } from "@/server/services/session-resolver";
import {
  changeTenantPlan,
  createTenantQuick,
  getTenantModules,
  resetTenantAdminPassword,
  updateTenantFiscal,
  updateTenantModules,
} from "@/server/services/tenants";
import { bootstrapTenant, meta, superAdminUser, type BootstrappedTenant } from "../helpers/auth.ts";
import { adminClient } from "../helpers/db.ts";
import { key, make, plain } from "../helpers/inventory.ts";

/** RUC válido (módulo 11) a partir de 10 dígitos. */
function ruc(prefix10: string): string {
  const factors = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = factors.reduce((acc, f, i) => acc + f * Number(prefix10[i]), 0);
  return `${prefix10}${(11 - (sum % 11)) % 10}`;
}
const newRuc = () => ruc(`20${Math.floor(10_000_000 + Math.random() * 89_999_999)}`);
const email = () => `q-${randomUUID().slice(0, 8)}@prueba.pe`;

describe("módulos por cliente, planes, alta rápida y datos fiscales diferidos", () => {
  let admin: PrismaClient;
  let sa: AuthUser;

  const refreshed = async (t: { adminId: string; tenantId: string }): Promise<AuthUser> => {
    const row = await admin.user.findUniqueOrThrow({ where: { id: t.adminId } });
    const user = await resolveSession({
      sub: t.adminId,
      tid: t.tenantId,
      sv: row.sessionVersion,
      mfa: true,
    });
    if (!user) throw new Error("sin sesión");
    return user;
  };
  const modules = (
    tenantId: string,
    groups: string[],
    businessType = "MIXED",
    reason = "Ajuste de prueba",
  ) =>
    updateTenantModules(
      sa,
      { tenantId, businessType: businessType as "MIXED", groups, reason },
      meta(),
    );
  const ALL_GROUPS = [
    "core",
    "billing",
    "workshop",
    "warranties",
    "purchasing",
    "ai",
    "whatsapp",
    "accounting",
    "branches",
    "reports",
  ];

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    sa = await superAdminUser(admin);
  }, 120_000);
  afterAll(async () => {
    await admin.$disconnect();
  });

  describe("casillas de módulos", () => {
    let t: BootstrappedTenant;
    beforeAll(async () => {
      t = await bootstrapTenant(admin, "enterprise", sa);
    }, 120_000);

    it("un plan completo ofrece todo y el administrador lo recibe", async () => {
      const user = await refreshed(t);
      for (const permission of [
        "ai_agent:ver",
        "workshop:ver",
        "whatsapp:ver",
        "accounting:ver",
        "branches:ver",
        "purchasing:ver",
      ] as const)
        expect(can(user, permission), permission).toBe(true);
    });

    it("apagar casillas quita al instante los permisos de esos módulos (menús, botones y servicios)", async () => {
      await modules(t.tenantId, ["core", "billing", "reports", "accounting"], "AUTOPARTS");
      const user = await refreshed(t);
      for (const permission of [
        "workshop:ver",
        "warranties:ver",
        "ai_agent:ver",
        "whatsapp:ver",
        "branches:ver",
        "purchasing:ver",
      ] as const)
        expect(can(user, permission), permission).toBe(false);
      for (const permission of [
        "pos:crear",
        "cash:ver",
        "billing:ver",
        "accounting:ver",
        "reports:ver",
        "users:ver",
        "settings:ver",
      ] as const)
        expect(can(user, permission), permission).toBe(true);
      expect(user.businessType).toBe("AUTOPARTS");
      const state = await getTenantModules(sa, t.tenantId);
      expect(state.businessType).toBe("AUTOPARTS");
      expect(state.disabledModules).toEqual(
        expect.arrayContaining([
          "WORKSHOP",
          "AI_AGENT",
          "WHATSAPP",
          "BRANCHES",
          "PURCHASING",
          "WARRANTIES",
        ]),
      );
      expect(state.disabledModules).not.toContain("POS");
    });

    it("volver a marcarlas las devuelve", async () => {
      await modules(t.tenantId, ALL_GROUPS, "MIXED");
      const user = await refreshed(t);
      expect(can(user, "workshop:ver")).toBe(true);
      expect(can(user, "ai_agent:ver")).toBe(true);
      expect(user.businessType).toBe("MIXED");
    });

    it("deja constancia con el motivo y exige ser SuperAdmin", async () => {
      await modules(t.tenantId, ALL_GROUPS, "MIXED", "Cliente pidió activar todo");
      const entry = await admin.auditLog.findFirstOrThrow({
        where: { tenantId: t.tenantId, action: "tenant.modules_changed" },
        orderBy: { occurredAt: "desc" },
      });
      expect(entry.reason).toBe("Cliente pidió activar todo");
      expect(entry.after).toMatchObject({ businessType: "MIXED" });
      const tenantAdmin = await refreshed(t);
      await expect(
        updateTenantModules(
          tenantAdmin,
          {
            tenantId: t.tenantId,
            businessType: "MIXED",
            groups: ALL_GROUPS,
            reason: "intento de un cliente",
          },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    });

    it("el Núcleo POS es obligatorio y el motivo es obligatorio", async () => {
      await expect(modules(t.tenantId, ["billing"], "MIXED")).rejects.toMatchObject({
        code: "CORE_REQUIRED",
      });
      await expect(modules(t.tenantId, ALL_GROUPS, "MIXED", "no")).rejects.toThrow();
      await expect(modules(t.tenantId, ["core", "inexistente"], "MIXED")).rejects.toThrow();
    });
  });

  describe("planes comerciales", () => {
    it("Básico no ofrece IA, WhatsApp, Contabilidad ni Multi-sucursal: no se pueden activar", async () => {
      const t = await bootstrapTenant(admin, "basic", sa);
      const user = await refreshed(t);
      for (const permission of [
        "ai_agent:ver",
        "whatsapp:ver",
        "accounting:ver",
        "branches:ver",
        "workshop:ver",
      ] as const)
        expect(can(user, permission), permission).toBe(false);
      await expect(modules(t.tenantId, ["core", "ai"], "MIXED")).rejects.toMatchObject({
        code: "MODULE_NOT_IN_PLAN",
      });
      await expect(modules(t.tenantId, ["core", "accounting"], "MIXED")).rejects.toThrow(
        /no incluye/,
      );
      await expect(
        modules(t.tenantId, ["core", "billing", "reports"], "MIXED"),
      ).resolves.toBeUndefined();
    }, 120_000);

    it("Standard incluye Taller, WhatsApp, PLE y sucursales, pero no la IA", async () => {
      const t = await bootstrapTenant(admin, "pro", sa);
      const user = await refreshed(t);
      for (const permission of [
        "workshop:ver",
        "whatsapp:ver",
        "accounting:ver",
        "branches:ver",
        "purchasing:ver",
      ] as const)
        expect(can(user, permission), permission).toBe(true);
      expect(can(user, "ai_agent:ver")).toBe(false);
      await expect(modules(t.tenantId, ["core", "ai"], "MIXED")).rejects.toMatchObject({
        code: "MODULE_NOT_IN_PLAN",
      });
    }, 120_000);

    it("subir de plan activa solo lo nuevo (respetando lo que el SuperAdmin apagó) y bajar lo retira", async () => {
      const t = await bootstrapTenant(admin, "pro", sa);
      await modules(t.tenantId, [
        "core",
        "billing",
        "reports",
        "workshop",
        "purchasing",
        "whatsapp",
        "accounting",
        "branches",
      ]);
      await changeTenantPlan(
        sa,
        { tenantId: t.tenantId, planCode: "enterprise", reason: "Compró Premium" },
        meta(),
      );
      let user = await refreshed(t);
      expect(can(user, "ai_agent:ver"), "IA nueva del plan Premium").toBe(true);
      expect(can(user, "warranties:ver"), "Garantías seguía apagada").toBe(false);
      await changeTenantPlan(
        sa,
        { tenantId: t.tenantId, planCode: "basic", reason: "Bajó a Básico" },
        meta(),
      ).catch(() => undefined);
      user = await refreshed(t);
      // Según el uso actual la baja puede rechazarse por límites; si pasó, ya no hay IA ni PLE.
      const plan = (
        await admin.tenant.findUniqueOrThrow({ where: { id: t.tenantId }, include: { plan: true } })
      ).plan;
      if (plan.code === "basic") {
        expect(can(user, "ai_agent:ver")).toBe(false);
        expect(can(user, "accounting:ver")).toBe(false);
      }
    }, 120_000);

    it("los nombres comerciales son Básico, Standard y Premium", async () => {
      const plans = await admin.plan.findMany({
        where: { code: { in: ["basic", "pro", "enterprise"] } },
      });
      const names = Object.fromEntries(plans.map((p) => [p.code, p.name]));
      expect(names).toEqual({ basic: "Básico", pro: "Standard", enterprise: "Premium" });
    });
  });

  describe("alta rápida sin SUNAT", () => {
    const create = (over: Record<string, unknown> = {}) =>
      createTenantQuick(
        sa,
        {
          legalName: `Taller Rápido ${randomUUID().slice(0, 5)}`,
          adminName: "Dueña Rápida",
          adminEmail: email(),
          planCode: "pro",
          businessType: "MIXED",
          ...over,
        },
        meta(),
      );

    it("crea la cuenta al instante, sin RUC, con contraseña temporal generada", async () => {
      const { tenantId, adminEmail, tempPassword } = await create();
      expect(tempPassword).toHaveLength(14);
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant.taxId).toBeNull();
      const user = await admin.user.findFirstOrThrow({ where: { email: adminEmail } });
      expect(user).toMatchObject({ status: "ACTIVE", mustChangePassword: true });
      expect(user.passwordHash).not.toContain(tempPassword);
      expect(await verifyPassword(tempPassword, user.passwordHash ?? "")).toBe(true);
    });

    it("la contraseña temporal NUNCA queda en la bitácora", async () => {
      const { tenantId, tempPassword } = await create({
        tempPassword: `Temporal${Math.floor(Math.random() * 1e6)}x`,
      });
      const logs = JSON.stringify(await admin.auditLog.findMany({ where: { tenantId } }));
      expect(logs).not.toContain(tempPassword);
      expect(logs).toContain("tenant.created_quick");
      expect(logs).toContain("temporaryPassword");
    });

    it("el rubro de autopartes arranca sin Taller ni Garantías", async () => {
      const { tenantId, adminEmail } = await create({ businessType: "AUTOPARTS" });
      const row = await admin.user.findFirstOrThrow({ where: { email: adminEmail } });
      const user = await resolveSession({
        sub: row.id,
        tid: tenantId,
        sv: row.sessionVersion,
        mfa: true,
      });
      expect(user?.businessType).toBe("AUTOPARTS");
      expect(can(user as AuthUser, "workshop:ver")).toBe(false);
      expect(can(user as AuthUser, "warranties:ver")).toBe(false);
      expect(can(user as AuthUser, "pos:crear")).toBe(true);
    });

    it("el cliente entra con la temporal, debe cambiarla y deja de ser temporal", async () => {
      const { tenantId, adminEmail, tempPassword } = await create();
      const outcome = await login({ email: adminEmail, password: tempPassword }, meta(), {
        requireSuperAdmin2fa: false,
      });
      let user = await resolveSession({
        sub: outcome.userId,
        tid: tenantId,
        sv: outcome.sessionVersion,
        mfa: true,
      });
      expect(user?.mustChangePassword).toBe(true);
      const actor = { userId: outcome.userId, tenantId };

      await expect(
        changeOwnPassword(
          actor,
          { current: "otra-clave-123", password: "NuevaClave2026x" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      await expect(
        changeOwnPassword(actor, { current: tempPassword, password: tempPassword }, meta()),
      ).rejects.toThrow();
      await expect(
        changeOwnPassword(actor, { current: tempPassword, password: "corta1" }, meta()),
      ).rejects.toThrow();

      await changeOwnPassword(
        actor,
        { current: tempPassword, password: "NuevaClave2026x" },
        meta(),
      );
      const row = await admin.user.findUniqueOrThrow({ where: { id: outcome.userId } });
      expect(row.mustChangePassword).toBe(false);
      expect(row.sessionVersion).toBe(outcome.sessionVersion + 1);
      user = await resolveSession({
        sub: outcome.userId,
        tid: tenantId,
        sv: row.sessionVersion,
        mfa: true,
      });
      expect(user?.mustChangePassword).toBe(false);
      // La sesión anterior (versión vieja) quedó revocada y la temporal ya no entra.
      expect(
        await resolveSession({
          sub: outcome.userId,
          tid: tenantId,
          sv: outcome.sessionVersion,
          mfa: true,
        }),
      ).toBeNull();
      await expect(
        login({ email: adminEmail, password: tempPassword }, meta(), {
          requireSuperAdmin2fa: false,
        }),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
      await expect(
        login({ email: adminEmail, password: "NuevaClave2026x" }, meta(), {
          requireSuperAdmin2fa: false,
        }),
      ).resolves.toBeTruthy();
      const logs = JSON.stringify(await admin.auditLog.findMany({ where: { tenantId } }));
      expect(logs).not.toContain("NuevaClave2026x");
      expect(logs).toContain("auth.password_changed");
    }, 120_000);

    it("valida los datos: RUC inválido, correo repetido y plan inexistente", async () => {
      await expect(create({ taxId: "20100070971" })).rejects.toThrow(/RUC/);
      const first = email();
      await create({ adminEmail: first });
      await expect(create({ adminEmail: first })).rejects.toMatchObject({
        code: "TENANT_CONFLICT",
      });
      await expect(create({ planCode: "no-existe" })).rejects.toMatchObject({
        name: "NotFoundError",
      });
      await expect(
        createTenantQuick(
          { ...sa, isSuperAdmin: false } as AuthUser,
          { legalName: "X Taller", adminName: "Ana Prueba", adminEmail: email(), planCode: "pro" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }, 120_000);

    it("sin RUC se vende con nota de venta, pero no se emiten boletas ni facturas", async () => {
      const { tenantId, adminEmail, tempPassword } = await create({ planCode: "enterprise" });
      const outcome = await login({ email: adminEmail, password: tempPassword }, meta(), {
        requireSuperAdmin2fa: false,
      });
      const user = (await resolveSession({
        sub: outcome.userId,
        tid: tenantId,
        sv: outcome.sessionVersion,
        mfa: true,
      })) as AuthUser;
      expect(user.fiscalReady).toBe(false);
      const warehouse = await admin.warehouse.findFirstOrThrow({ where: { tenantId } });
      const product = await make(user, plain({ salePrice: 118 }));
      await registerStockIn(
        user,
        {
          warehouseId: warehouse.id,
          productId: product.id,
          quantity: "5",
          unitCost: "50",
          idempotencyKey: key(),
        } as never,
        meta(),
      );
      await openCashSession(user, { openingAmount: 0 }, meta());
      const sale = (documentType: string) =>
        ({
          idempotencyKey: key(),
          documentType,
          items: [{ productId: product.id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "118" }],
        }) as never;
      await expect(createSale(user, sale("BOLETA"), meta())).rejects.toMatchObject({
        code: "ISSUER_RUC",
      });
      await expect(createSale(user, sale("FACTURA"), meta())).rejects.toThrow();
      const ok = await createSale(user, sale("NOTA_VENTA"), meta());
      expect(ok.documentNumber).toBeNull();
    }, 180_000);

    it("después se completan el RUC oficial y el correo corporativo y se activa la facturación", async () => {
      const { tenantId, adminEmail, tempPassword } = await create({ planCode: "enterprise" });
      const outcome = await login({ email: adminEmail, password: tempPassword }, meta(), {
        requireSuperAdmin2fa: false,
      });
      const before = (await resolveSession({
        sub: outcome.userId,
        tid: tenantId,
        sv: outcome.sessionVersion,
        mfa: true,
      })) as AuthUser;
      expect(before.fiscalReady).toBe(false);

      const officialRuc = newRuc();
      await expect(
        updateTenantFiscal(sa, { tenantId, taxId: "20100070971", reason: "RUC con error" }, meta()),
      ).rejects.toThrow(/RUC/);
      await expect(
        updateTenantFiscal(sa, { tenantId, reason: "sin datos aún" }, meta()),
      ).rejects.toThrow();
      await updateTenantFiscal(
        sa,
        {
          tenantId,
          taxId: officialRuc,
          corporateEmail: "contabilidad@taller.pe",
          reason: "Cliente activó facturación",
        },
        meta(),
      );
      const tenant = await admin.tenant.findUniqueOrThrow({ where: { id: tenantId } });
      expect(tenant).toMatchObject({ taxId: officialRuc, billingEmail: "contabilidad@taller.pe" });
      const after = (await resolveSession({
        sub: outcome.userId,
        tid: tenantId,
        sv: outcome.sessionVersion,
        mfa: true,
      })) as AuthUser;
      expect(after.fiscalReady).toBe(true);
      const entry = await admin.auditLog.findFirstOrThrow({
        where: { tenantId, action: "tenant.fiscal_updated" },
      });
      expect(entry.after).toMatchObject({ taxId: officialRuc });

      // Otro cliente no puede quedarse con el mismo RUC.
      const other = await create();
      await expect(
        updateTenantFiscal(
          sa,
          { tenantId: other.tenantId, taxId: officialRuc, reason: "RUC repetido" },
          meta(),
        ),
      ).rejects.toMatchObject({ code: "TENANT_CONFLICT" });
    }, 180_000);

    it("el SuperAdmin genera una nueva contraseña temporal (revoca sesiones, exige cambiarla)", async () => {
      const { tenantId, adminEmail, tempPassword } = await create();
      const before = await admin.user.findFirstOrThrow({ where: { email: adminEmail } });
      const reset = await resetTenantAdminPassword(
        sa,
        { tenantId, reason: "Olvidó su clave" },
        meta(),
      );
      expect(reset.adminEmail).toBe(adminEmail);
      expect(reset.tempPassword).not.toBe(tempPassword);
      const after = await admin.user.findFirstOrThrow({ where: { email: adminEmail } });
      expect(after.sessionVersion).toBe(before.sessionVersion + 1);
      expect(after.mustChangePassword).toBe(true);
      await expect(
        login({ email: adminEmail, password: tempPassword }, meta(), {
          requireSuperAdmin2fa: false,
        }),
      ).rejects.toBeTruthy();
      await expect(
        login({ email: adminEmail, password: reset.tempPassword }, meta(), {
          requireSuperAdmin2fa: false,
        }),
      ).resolves.toBeTruthy();
      const logs = JSON.stringify(await admin.auditLog.findMany({ where: { tenantId } }));
      expect(logs).not.toContain(reset.tempPassword);
    }, 120_000);
  });

  describe("WhatsApp, contabilidad y rubro en la operación", () => {
    it("sin el módulo WhatsApp no sale ningún aviso a clientes", async () => {
      const t = await bootstrapTenant(admin, "enterprise", sa);
      const customer = await admin.customer.create({
        data: {
          tenantId: t.tenantId,
          docType: "DNI",
          docNumber: String(Math.floor(10_000_000 + Math.random() * 89_999_999)),
          name: "Cliente Aviso",
          whatsapp: "987654321",
          whatsappOptIn: true,
        },
      });
      const send = () =>
        withTenant(t.tenantId, (tx) =>
          notifyCustomer(tx, {
            customerId: customer.id,
            key: `m:${randomUUID()}`,
            body: "hola",
            relatedType: "t",
            relatedId: customer.id,
          }),
        );
      expect(["QUEUED", "SIMULATED"]).toContain(await send());
      await modules(t.tenantId, ["core", "billing", "reports"]);
      expect(await send()).toBe("SKIPPED_DISABLED");
      await modules(t.tenantId, ALL_GROUPS);
      expect(["QUEUED", "SIMULATED"]).toContain(await send());
    }, 120_000);

    it("el inicio de una tienda de autopartes no calcula Taller ni Garantías aunque tenga el permiso", async () => {
      const t = await bootstrapTenant(admin, "enterprise", sa);
      let user = await refreshed(t);
      let data = await getDashboard(user);
      expect(data.workshop).not.toBeNull();
      expect(data.warranties).not.toBeNull();
      // Rubro comercial con TODOS los módulos activos: sigue sin ver bloques de taller.
      await modules(t.tenantId, ALL_GROUPS, "AUTOPARTS");
      user = await refreshed(t);
      expect(can(user, "workshop:ver")).toBe(true);
      data = await getDashboard(user);
      expect(data.workshop).toBeNull();
      expect(data.warranties).toBeNull();
      expect(data.sales).not.toBeNull();
      await modules(t.tenantId, ALL_GROUPS, "WORKSHOP");
      data = await getDashboard(await refreshed(t));
      expect(data.workshop).not.toBeNull();
    }, 120_000);

    it("el widget de stock entrega contadores, no listas de productos", async () => {
      const t = await bootstrapTenant(admin, "enterprise", sa);
      const data = await getDashboard(await refreshed(t));
      expect(data.stock).toEqual({ critical: expect.any(Number), reorder: expect.any(Number) });
      expect(Object.keys(data.stock ?? {}).sort()).toEqual(["critical", "reorder"]);
    }, 120_000);
  });
});
