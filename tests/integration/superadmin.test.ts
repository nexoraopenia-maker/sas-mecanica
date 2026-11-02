import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { can } from "@/lib/auth/can";
import { ALL_PERMISSION_KEYS } from "@/lib/auth/permissions";
import type { PrismaClient } from "@/lib/db/generated/client.ts";
import {
  ConflictError,
  ModuleDisabledError,
  NotFoundError,
  PermissionDeniedError,
  PlanLimitError,
} from "@/lib/errors";
import { endImpersonation, startImpersonation } from "@/server/services/impersonation";
import { assertModuleEnabled } from "@/server/services/limits";
import { getPlatformMetrics } from "@/server/services/metrics";
import { updatePlanLimits } from "@/server/services/plans";
import { createBranch, createWarehouse } from "@/server/services/branches";
import { configureAuthCache, resolveSession } from "@/server/services/session-resolver";
import {
  changeTenantPlan,
  createTenant,
  deleteTenant,
  getTenantDetail,
  listTenants,
  reactivateTenant,
  suspendTenant,
} from "@/server/services/tenants";
import { inviteUser } from "@/server/services/users";
import { withTenant } from "@/lib/db";
import { adminClient } from "../helpers/db.ts";
import {
  addUser,
  bootstrapTenant,
  captureEmails,
  meta,
  tokenIn,
  uniqueEmail,
  type BootstrappedTenant,
} from "../helpers/auth.ts";

describe("SuperAdmin: tenants, planes y límites", () => {
  let admin: PrismaClient;
  let t: BootstrappedTenant; // plan Pro; su .superAdmin se reutiliza

  beforeAll(async () => {
    configureAuthCache(0);
    admin = adminClient();
    t = await bootstrapTenant(admin, "pro");
  });
  afterAll(async () => {
    await admin.$disconnect();
  });

  const roleId = async (tenantId: string, key: "admin" | "cashier" | "mechanic") =>
    (await admin.role.findFirstOrThrow({ where: { tenantId, key } })).id;
  const newTenantInput = (planCode: string, over: Record<string, unknown> = {}) => ({
    legalName: `Empresa ${randomUUID().slice(0, 6)} SAC`,
    taxId: `20${Math.floor(Math.random() * 1e9)}`,
    planCode,
    adminName: "Admin Nuevo",
    adminEmail: uniqueEmail("admin"),
    ...over,
  });

  describe("acceso", () => {
    it("solo un SuperAdmin con 2FA puede administrar tenants", async () => {
      await expect(createTenant(t.admin, newTenantInput("basic"), meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(listTenants(t.admin)).rejects.toBeInstanceOf(PermissionDeniedError);
      const noMfa = await resolveSession({
        sub: t.superAdmin.userId,
        tid: null,
        sv: 1,
        mfa: false,
      });
      if (!noMfa) throw new Error("sesión pendiente esperada");
      await expect(createTenant(noMfa, newTenantInput("basic"), meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(getPlatformMetrics(t.admin)).rejects.toBeInstanceOf(PermissionDeniedError);
    });
  });

  describe("alta de tenant", () => {
    it("crea empresa, ajustes, suscripción, 4 roles con permisos, sucursal, almacén e invita al administrador", async () => {
      const emails = captureEmails();
      const input = newTenantInput("pro", {
        tradeName: "Autos Norte",
        contactEmail: "contacto@norte.pe",
      });
      const { tenantId } = await createTenant(t.superAdmin, input, meta());

      const tenant = await getTenantDetail(t.superAdmin, tenantId);
      expect(tenant).toMatchObject({
        status: "ACTIVE",
        tradeName: "Autos Norte",
        country: "PE",
        currency: "PEN",
        isDemo: false,
      });
      expect(tenant.plan.code).toBe("pro");
      expect(tenant.subscriptions[0]?.status).toBe("ACTIVE");
      expect(tenant.settings?.taxName).toBe("IGV");

      const roles = await admin.role.findMany({
        where: { tenantId },
        include: { _count: { select: { permissions: true } } },
      });
      expect(roles.map((r) => r.key).sort()).toEqual([
        "admin",
        "cashier",
        "mechanic",
        "warehouse_manager",
      ]);
      expect(roles.find((r) => r.key === "admin")?._count.permissions).toBe(
        ALL_PERMISSION_KEYS.size,
      );
      expect(await admin.branch.count({ where: { tenantId, isMain: true } })).toBe(1);
      expect(await admin.warehouse.count({ where: { tenantId, isDefault: true } })).toBe(1);

      expect(emails).toHaveLength(1);
      expect(emails[0]?.to).toBe(input.adminEmail);
      const invited = await admin.user.findFirstOrThrow({ where: { email: input.adminEmail } });
      expect(invited).toMatchObject({ tenantId, status: "INVITED", passwordHash: null });
      expect(
        await admin.auditLog.count({
          where: { tenantId, action: "tenant.created", actorUserId: t.superAdmin.userId },
        }),
      ).toBe(1);
    });

    it("rechaza RUC duplicado, correo ya usado, plan inexistente, plan oculto y datos inválidos", async () => {
      const first = newTenantInput("basic");
      await createTenant(t.superAdmin, first, meta());
      await expect(
        createTenant(t.superAdmin, newTenantInput("basic", { taxId: first.taxId }), meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        createTenant(
          t.superAdmin,
          newTenantInput("basic", { adminEmail: first.adminEmail }),
          meta(),
        ),
      ).rejects.toBeInstanceOf(ConflictError);
      await expect(
        createTenant(t.superAdmin, newTenantInput("no-existe"), meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createTenant(t.superAdmin, newTenantInput("demo"), meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createTenant(t.superAdmin, newTenantInput("basic", { taxId: "!!" }), meta()),
      ).rejects.toThrow();
      await expect(
        createTenant(t.superAdmin, newTenantInput("basic", { adminEmail: "no-correo" }), meta()),
      ).rejects.toThrow();
    });
  });

  describe("límites de plan aplicados en el backend", () => {
    it("Básico: 3 usuarios, 1 sucursal, 1 almacén y sin módulos de taller/compras", async () => {
      const b = await bootstrapTenant(admin, "basic", t.superAdmin);
      const invite = (input: { email: string; name: string; roleId: string }) =>
        inviteUser(b.admin, input, meta());
      const cashier = await roleId(b.tenantId, "cashier");
      await addUser(invite, admin, b.tenantId, cashier);
      await addUser(invite, admin, b.tenantId, cashier);
      const failure = await inviteUser(
        b.admin,
        { email: uniqueEmail("cuarto"), name: "Cuarto Usuario", roleId: cashier },
        meta(),
      ).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(PlanLimitError);
      expect((failure as PlanLimitError).details).toMatchObject({ limit: "usuarios", max: 3 });
      expect(await admin.user.count({ where: { tenantId: b.tenantId } })).toBe(3);

      await expect(
        createBranch(b.admin, { code: "SUR", name: "Sede Sur" }, meta()),
      ).rejects.toBeInstanceOf(PlanLimitError);
      const branch = await admin.branch.findFirstOrThrow({ where: { tenantId: b.tenantId } });
      await expect(
        createWarehouse(
          b.admin,
          { branchId: branch.id, code: "ALM-2", name: "Segundo almacén" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PlanLimitError);

      await expect(
        withTenant(b.tenantId, (tx) => assertModuleEnabled(tx, "WORKSHOP")),
      ).rejects.toBeInstanceOf(ModuleDisabledError);
      await expect(
        withTenant(b.tenantId, (tx) => assertModuleEnabled(tx, "POS")),
      ).resolves.toBeUndefined();
    });

    it("Pro: multialmacén y hasta 3 sucursales", async () => {
      const p = await bootstrapTenant(admin, "pro", t.superAdmin);
      const branch = await admin.branch.findFirstOrThrow({ where: { tenantId: p.tenantId } });
      await createWarehouse(
        p.admin,
        { branchId: branch.id, code: "ALM-2", name: "Almacén 2" },
        meta(),
      );
      await createBranch(p.admin, { code: "SUR", name: "Sede Sur" }, meta());
      await createBranch(p.admin, { code: "NORTE", name: "Sede Norte" }, meta());
      await expect(
        createBranch(p.admin, { code: "ESTE", name: "Sede Este" }, meta()),
      ).rejects.toBeInstanceOf(PlanLimitError);
      expect(can(p.admin, "workshop:crear")).toBe(true);
    });

    it("Enterprise: usuarios ilimitados y agente IA", async () => {
      const e = await bootstrapTenant(admin, "enterprise", t.superAdmin);
      const invite = (input: { email: string; name: string; roleId: string }) =>
        inviteUser(e.admin, input, meta());
      const mechanic = await roleId(e.tenantId, "mechanic");
      for (let i = 0; i < 5; i += 1) await addUser(invite, admin, e.tenantId, mechanic);
      expect(can(e.admin, "ai_agent:autorizar_pedidos_ia")).toBe(true);
    });

    it("un tenant puede restringir módulos dentro de su plan", async () => {
      const p = await bootstrapTenant(admin, "pro", t.superAdmin);
      await admin.tenantSettings.update({
        where: { tenantId: p.tenantId },
        data: { enabledModules: ["USERS", "POS"] },
      });
      const user = await resolveSession({ sub: p.adminId, tid: p.tenantId, sv: 1, mfa: true });
      expect(user && can(user, "pos:crear")).toBe(true);
      expect(user && can(user, "workshop:ver")).toBe(false);
    });

    it("editar el plan cambia el límite en la siguiente operación", async () => {
      const plan = await admin.plan.create({
        data: {
          code: `custom-${randomUUID().slice(0, 6)}`,
          name: "Personalizado",
          priceMonthly: "50",
          maxUsers: 1,
          maxBranches: 1,
          maxWarehouses: 1,
          includedModules: ["USERS", "POS", "SETTINGS"],
        },
      });
      const c = await bootstrapTenant(admin, plan.code as "basic", t.superAdmin);
      const cashier = await roleId(c.tenantId, "cashier");
      await expect(
        inviteUser(
          c.admin,
          { email: uniqueEmail("a"), name: "Ana Pérez", roleId: cashier },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PlanLimitError);
      await updatePlanLimits(
        t.superAdmin,
        {
          planId: plan.id,
          priceMonthly: 50,
          maxUsers: 2,
          maxBranches: 1,
          maxWarehouses: 1,
          monthlyAiTokens: 0,
        },
        meta(),
      );
      await expect(
        inviteUser(
          c.admin,
          { email: uniqueEmail("b"), name: "Beto Ruiz", roleId: cashier },
          meta(),
        ),
      ).resolves.toBeDefined();
      const audit = await admin.auditLog.findFirstOrThrow({
        where: { action: "plan.limits_changed", entityId: plan.id },
      });
      expect((audit.before as { maxUsers: number }).maxUsers).toBe(1);
      expect((audit.after as { maxUsers: number }).maxUsers).toBe(2);
      await expect(
        updatePlanLimits(
          t.admin,
          {
            planId: plan.id,
            priceMonthly: 1,
            maxUsers: null,
            maxBranches: null,
            maxWarehouses: null,
            monthlyAiTokens: null,
          },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    });

    it("cambiar a un plan menor falla si el uso actual excede sus límites", async () => {
      const p = await bootstrapTenant(admin, "pro", t.superAdmin);
      const invite = (input: { email: string; name: string; roleId: string }) =>
        inviteUser(p.admin, input, meta());
      const mechanic = await roleId(p.tenantId, "mechanic");
      for (let i = 0; i < 3; i += 1) await addUser(invite, admin, p.tenantId, mechanic);
      await expect(
        changeTenantPlan(
          t.superAdmin,
          { tenantId: p.tenantId, planCode: "basic", reason: "Downgrade" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PlanLimitError);
      await changeTenantPlan(
        t.superAdmin,
        { tenantId: p.tenantId, planCode: "enterprise", reason: "Upgrade comercial" },
        meta(),
      );
      expect((await getTenantDetail(t.superAdmin, p.tenantId)).plan.code).toBe("enterprise");
      expect(
        await admin.auditLog.count({
          where: { tenantId: p.tenantId, action: "tenant.plan_changed" },
        }),
      ).toBe(1);
    });
  });

  describe("ciclo de vida", () => {
    it("suspende, reactiva y elimina lógicamente con retención y auditoría", async () => {
      const x = await bootstrapTenant(admin, "basic", t.superAdmin);
      await expect(
        suspendTenant(t.superAdmin, { tenantId: x.tenantId, reason: "x" }, meta()),
      ).rejects.toThrow(); // motivo obligatorio
      await suspendTenant(
        t.superAdmin,
        { tenantId: x.tenantId, reason: "Factura vencida 30 días" },
        meta(),
      );
      expect(await admin.tenant.findUniqueOrThrow({ where: { id: x.tenantId } })).toMatchObject({
        status: "SUSPENDED",
        suspendedReason: "Factura vencida 30 días",
      });
      await expect(
        suspendTenant(t.superAdmin, { tenantId: x.tenantId, reason: "Otra vez" }, meta()),
      ).rejects.toBeInstanceOf(ConflictError);
      await reactivateTenant(
        t.superAdmin,
        { tenantId: x.tenantId, reason: "Pago regularizado" },
        meta(),
      );
      expect((await admin.tenant.findUniqueOrThrow({ where: { id: x.tenantId } })).status).toBe(
        "ACTIVE",
      );

      await admin.tenant.update({ where: { id: x.tenantId }, data: { retentionDays: 30 } });
      await deleteTenant(
        t.superAdmin,
        { tenantId: x.tenantId, reason: "Cliente canceló el servicio" },
        meta(),
      );
      const gone = await admin.tenant.findUniqueOrThrow({ where: { id: x.tenantId } });
      expect(gone).toMatchObject({ status: "CANCELLED" });
      expect(gone.deletedAt).not.toBeNull();
      const days = ((gone.purgeAfter?.getTime() ?? 0) - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThan(30.1);
      // Datos conservados, pero oculto del listado y sin acceso.
      expect(await admin.user.count({ where: { tenantId: x.tenantId } })).toBe(1);
      expect((await listTenants(t.superAdmin)).some((row) => row.id === x.tenantId)).toBe(false);
      expect(
        (await listTenants(t.superAdmin, { includeDeleted: true })).some(
          (row) => row.id === x.tenantId,
        ),
      ).toBe(true);
      expect(
        await resolveSession({ sub: x.adminId, tid: x.tenantId, sv: 1, mfa: true }),
      ).toBeNull();

      const actions = (
        await admin.auditLog.findMany({ where: { tenantId: x.tenantId }, select: { action: true } })
      ).map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining(["tenant.suspended", "tenant.reactivated", "tenant.deleted"]),
      );
      await expect(
        deleteTenant(t.superAdmin, { tenantId: x.tenantId, reason: "De nuevo" }, meta()),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("impersonación de soporte", () => {
    it("exige motivo, deja banner/auditoría visibles para el tenant y marca cada acción", async () => {
      const x = await bootstrapTenant(admin, "pro", t.superAdmin);
      await expect(
        startImpersonation(t.superAdmin, { tenantId: x.tenantId, reason: "corto" }, meta()),
      ).rejects.toThrow();
      await expect(
        startImpersonation(
          t.admin,
          { tenantId: x.tenantId, reason: "Intento no autorizado" },
          meta(),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);

      const { sessionId } = await startImpersonation(
        t.superAdmin,
        { tenantId: x.tenantId, reason: "Ticket #482: no puede cerrar caja" },
        meta(),
      );
      const claims = {
        sub: t.superAdmin.userId,
        tid: x.tenantId,
        sv: 1,
        mfa: true,
        imp: sessionId,
      };
      const support = await resolveSession(claims);
      expect(support).toMatchObject({ isSuperAdmin: true, tenantId: x.tenantId, roleKey: "admin" });
      expect(support?.impersonation).toEqual({
        sessionId,
        reason: "Ticket #482: no puede cerrar caja",
      });
      expect(support && can(support, "users:crear")).toBe(true);

      // Una acción durante el soporte queda atribuida al SuperAdmin como impersonador.
      if (!support) throw new Error("sesión de soporte esperada");
      await inviteUser(
        support,
        {
          email: uniqueEmail("soporte"),
          name: "Creado en soporte",
          roleId: await roleId(x.tenantId, "cashier"),
        },
        meta(),
      );
      const invited = await admin.auditLog.findFirstOrThrow({
        where: { tenantId: x.tenantId, action: "user.invited" },
        orderBy: { occurredAt: "desc" },
      });
      expect(invited).toMatchObject({
        actorType: "SUPERADMIN",
        actorUserId: t.superAdmin.userId,
        impersonatorUserId: t.superAdmin.userId,
      });

      // El administrador del tenant puede ver que hubo soporte.
      const visible = await withTenant(x.tenantId, (tx) =>
        tx.auditLog.findMany({ where: { action: "impersonation.started" } }),
      );
      expect(visible).toHaveLength(1);
      expect(visible[0]?.reason).toContain("Ticket #482");

      // Durante la impersonación no se pueden usar las funciones de plataforma.
      await expect(createTenant(support, newTenantInput("basic"), meta())).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );

      await endImpersonation(support, sessionId, meta());
      expect(await resolveSession(claims)).toBeNull();
      expect(
        await admin.auditLog.count({
          where: { tenantId: x.tenantId, action: "impersonation.ended" },
        }),
      ).toBe(1);
      await expect(endImpersonation(t.superAdmin, sessionId, meta())).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("un token de impersonación no sirve para otro tenant ni para otro SuperAdmin", async () => {
      const x = await bootstrapTenant(admin, "basic", t.superAdmin);
      const y = await bootstrapTenant(admin, "basic", t.superAdmin);
      const { sessionId } = await startImpersonation(
        t.superAdmin,
        { tenantId: x.tenantId, reason: "Revisión de configuración" },
        meta(),
      );
      expect(
        await resolveSession({
          sub: t.superAdmin.userId,
          tid: y.tenantId,
          sv: 1,
          mfa: true,
          imp: sessionId,
        }),
      ).toBeNull();
      const other = await bootstrapTenant(admin, "basic");
      expect(
        await resolveSession({
          sub: other.superAdmin.userId,
          tid: x.tenantId,
          sv: 1,
          mfa: true,
          imp: sessionId,
        }),
      ).toBeNull();
    });
  });

  describe("métricas", () => {
    it("MRR, cuentas activas, churn y consumo de IA por tenant", async () => {
      const before = await getPlatformMetrics(t.superAdmin);
      const e = await bootstrapTenant(admin, "enterprise", t.superAdmin);
      const p = await bootstrapTenant(admin, "pro", t.superAdmin);
      const after = await getPlatformMetrics(t.superAdmin);
      expect(Number(after.mrr) - Number(before.mrr)).toBe(599 + 249);
      expect(after.activeAccounts - before.activeAccounts).toBe(2);

      await deleteTenant(
        t.superAdmin,
        { tenantId: p.tenantId, reason: "Cancelación para métricas" },
        meta(),
      );
      const churned = await getPlatformMetrics(t.superAdmin);
      expect(Number(churned.mrr) - Number(after.mrr)).toBe(-249);
      expect(churned.churn30d).toBeGreaterThan(0);

      await admin.aiRun.create({
        data: {
          tenantId: e.tenantId,
          kind: "PURCHASING",
          status: "SUCCEEDED",
          model: "gpt-4o-mini",
          prompt: {},
          promptTokens: 1200,
          completionTokens: 300,
          costUsd: "0.0123",
          idempotencyKey: randomUUID(),
        },
      });
      await admin.aiRun.create({
        data: {
          tenantId: e.tenantId,
          kind: "PURCHASING",
          status: "SUCCEEDED",
          model: "gpt-4o-mini",
          prompt: {},
          promptTokens: 9999,
          completionTokens: 1,
          costUsd: "9",
          simulated: true,
          idempotencyKey: randomUUID(),
        },
      });
      const usage = (await getPlatformMetrics(t.superAdmin)).aiUsage.find(
        (row) => row.tenantId === e.tenantId,
      );
      expect(usage).toMatchObject({ tokens: 1500 }); // las corridas simuladas no cuentan
      expect(Number(usage?.costUsd)).toBeCloseTo(0.0123, 4);
      expect(churned.accountsByPlan.length).toBeGreaterThan(0);
      void tokenIn;
    });
  });
});
