import { requireSuperAdmin, type AuthUser } from "@/lib/auth/can";
import { hashPassword } from "@/lib/auth/password";
import { generateToken } from "@/lib/auth/secure-token";
import { generateTempPassword } from "@/lib/auth/temp-password";
import { BUSINESS_PRESETS, MODULE_GROUPS, disabledFromGroups, LOCKED_MODULES } from "@/lib/modules";
import { Prisma, withAdmin, withPlatform } from "@/lib/db";
import { ConflictError, NotFoundError, PlanLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  createTenantQuickSchema,
  createTenantSchema,
  resetTenantAdminPasswordSchema,
  tenantReasonSchema,
  updateTenantFiscalSchema,
  updateTenantModulesSchema,
  type CreateTenantInput,
  type CreateTenantQuickInput,
  type ResetTenantAdminPasswordInput,
  type UpdateTenantFiscalInput,
  type UpdateTenantModulesInput,
} from "@/lib/validation/tenants";
import { getEmailSender } from "@/server/integrations/email";
import { inviteEmail } from "@/server/integrations/email-templates";
import type { RequestMeta } from "./audit";
import { provisionTenantBase } from "./provisioning";
import { invalidateAuthCache } from "./session-resolver";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function actorFor(user: AuthUser, reason: string, tenantId: string | null, meta: RequestMeta) {
  return { userId: user.userId, reason, tenantId, ip: meta.ip, requestId: meta.requestId };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Alta de empresa: crea tenant + roles + sucursal/almacén + administrador invitado por correo. */
export async function createTenant(
  actor: AuthUser,
  input: CreateTenantInput,
  meta: RequestMeta = {},
) {
  requireSuperAdmin(actor);
  const data = createTenantSchema.parse(input);
  const invite = generateToken();

  try {
    const created = await withAdmin(
      actorFor(actor, `Alta de tenant ${data.legalName}`, null, meta),
      (db) =>
        db.$transaction(async (tx) => {
          const base = await provisionTenantBase(tx, { ...data, planCode: data.planCode });
          const admin = await tx.user.create({
            data: {
              tenantId: base.tenantId,
              email: data.adminEmail,
              name: data.adminName,
              status: "INVITED",
              roleId: base.roleIds.admin,
            },
          });
          await tx.authToken.create({
            data: {
              tenantId: base.tenantId,
              userId: admin.id,
              type: "INVITE",
              tokenHash: invite.hash,
              expiresAt: new Date(Date.now() + INVITE_TTL_MS),
            },
          });
          await tx.auditLog.create({
            data: {
              tenantId: base.tenantId,
              actorType: "SUPERADMIN",
              actorUserId: actor.userId,
              action: "tenant.created",
              entityType: "tenant",
              entityId: base.tenantId,
              after: { legalName: data.legalName, taxId: data.taxId, planCode: data.planCode },
              ip: meta.ip ?? null,
            },
          });
          return base;
        }),
    );
    try {
      await getEmailSender().send(
        inviteEmail({
          to: data.adminEmail,
          name: data.adminName,
          company: data.tradeName ?? data.legalName,
          token: invite.token,
        }),
      );
    } catch (error) {
      logger.error(
        { err: error, tenantId: created.tenantId },
        "no se pudo enviar la invitación del administrador",
      );
    }
    return { tenantId: created.tenantId };
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(
        "TENANT_CONFLICT",
        "Ya existe una empresa con ese RUC/NIT o un usuario con ese correo",
      );
    throw error;
  }
}

type TenantStatusChange = {
  action: string;
  from: Array<"ACTIVE" | "SUSPENDED" | "CANCELLED">;
  data: (tenant: { retentionDays: number }) => Prisma.TenantUpdateInput;
  subscription: "SUSPENDED" | "ACTIVE" | "CANCELED";
};

async function changeTenantStatus(
  actor: AuthUser,
  input: { tenantId: string; reason: string },
  change: TenantStatusChange,
  meta: RequestMeta,
) {
  requireSuperAdmin(actor);
  const { tenantId, reason } = tenantReasonSchema.parse(input);
  await withAdmin(actorFor(actor, `${change.action}: ${reason}`, tenantId, meta), (db) =>
    db.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
      if (!tenant) throw new NotFoundError("Empresa");
      if (!change.from.includes(tenant.status))
        throw new ConflictError(
          "INVALID_TRANSITION",
          `No se puede aplicar "${change.action}" a una empresa ${tenant.status}`,
        );
      const updated = await tx.tenant.update({
        where: { id: tenantId },
        data: change.data(tenant),
      });
      await tx.subscription.updateMany({
        where: { tenantId },
        data: { status: change.subscription },
      });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorType: "SUPERADMIN",
          actorUserId: actor.userId,
          action: change.action,
          entityType: "tenant",
          entityId: tenantId,
          before: { status: tenant.status },
          after: { status: updated.status },
          reason,
          ip: meta.ip ?? null,
        },
      });
    }),
  );
  invalidateAuthCache();
}

/** Bloquea el acceso (login y sesiones vigentes) conservando todos los datos. */
export function suspendTenant(
  actor: AuthUser,
  input: { tenantId: string; reason: string },
  meta: RequestMeta = {},
) {
  return changeTenantStatus(
    actor,
    input,
    {
      action: "tenant.suspended",
      from: ["ACTIVE"],
      subscription: "SUSPENDED",
      data: () => ({ status: "SUSPENDED", suspendedAt: new Date(), suspendedReason: input.reason }),
    },
    meta,
  );
}

export function reactivateTenant(
  actor: AuthUser,
  input: { tenantId: string; reason: string },
  meta: RequestMeta = {},
) {
  return changeTenantStatus(
    actor,
    input,
    {
      action: "tenant.reactivated",
      from: ["SUSPENDED"],
      subscription: "ACTIVE",
      data: () => ({ status: "ACTIVE", suspendedAt: null, suspendedReason: null }),
    },
    meta,
  );
}

/** Borrado lógico: cancela, oculta y programa la purga según la retención configurada del tenant. */
export function deleteTenant(
  actor: AuthUser,
  input: { tenantId: string; reason: string },
  meta: RequestMeta = {},
) {
  return changeTenantStatus(
    actor,
    input,
    {
      action: "tenant.deleted",
      from: ["ACTIVE", "SUSPENDED"],
      subscription: "CANCELED",
      data: (tenant) => {
        const now = new Date();
        return {
          status: "CANCELLED",
          cancelledAt: now,
          deletedAt: now,
          purgeAfter: new Date(now.getTime() + tenant.retentionDays * 86_400_000),
        };
      },
    },
    meta,
  );
}

/** Cambio de plan. Si el uso actual excede los límites del plan nuevo, se rechaza. */
export async function changeTenantPlan(
  actor: AuthUser,
  input: { tenantId: string; planCode: string; reason: string },
  meta: RequestMeta = {},
) {
  requireSuperAdmin(actor);
  const { tenantId, reason } = tenantReasonSchema.parse(input);
  await withAdmin(actorFor(actor, `Cambio de plan: ${reason}`, tenantId, meta), (db) =>
    db.$transaction(async (tx) => {
      const [tenant, plan] = await Promise.all([
        tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } }),
        tx.plan.findFirst({ where: { code: input.planCode, deletedAt: null, isActive: true } }),
      ]);
      if (!tenant) throw new NotFoundError("Empresa");
      if (!plan) throw new NotFoundError("Plan");
      const [users, branches, warehouses] = await Promise.all([
        tx.user.count({ where: { tenantId, deletedAt: null, status: { not: "DISABLED" } } }),
        tx.branch.count({ where: { tenantId, deletedAt: null } }),
        tx.warehouse.count({ where: { tenantId, deletedAt: null } }),
      ]);
      if (plan.maxUsers !== null && users > plan.maxUsers)
        throw new PlanLimitError("usuarios", plan.maxUsers);
      if (plan.maxBranches !== null && branches > plan.maxBranches)
        throw new PlanLimitError("sucursales", plan.maxBranches);
      const warehouseMax = plan.multiWarehouse ? plan.maxWarehouses : 1;
      if (warehouseMax !== null && warehouses > warehouseMax)
        throw new PlanLimitError("almacenes", warehouseMax);

      await tx.tenant.update({ where: { id: tenantId }, data: { planId: plan.id } });
      await tx.subscription.updateMany({ where: { tenantId }, data: { planId: plan.id } });
      await tx.auditLog.create({
        data: {
          tenantId,
          actorType: "SUPERADMIN",
          actorUserId: actor.userId,
          action: "tenant.plan_changed",
          entityType: "tenant",
          entityId: tenantId,
          before: { planId: tenant.planId },
          after: { planId: plan.id, planCode: plan.code },
          reason,
          ip: meta.ip ?? null,
        },
      });
    }),
  );
  invalidateAuthCache();
}

export async function listTenants(
  actor: AuthUser,
  filter: { includeDemo?: boolean; includeDeleted?: boolean } = {},
) {
  requireSuperAdmin(actor);
  return withPlatform((db) =>
    db.tenant.findMany({
      where: {
        ...(filter.includeDemo ? {} : { isDemo: false }),
        ...(filter.includeDeleted ? {} : { deletedAt: null }),
      },
      include: {
        plan: { select: { code: true, name: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  );
}

export async function getTenantDetail(actor: AuthUser, tenantId: string) {
  requireSuperAdmin(actor);
  const tenant = await withPlatform((db) =>
    db.tenant.findFirst({
      where: { id: tenantId },
      include: {
        plan: true,
        settings: {
          select: {
            taxName: true,
            taxRate: true,
            aiModel: true,
            aiMode: true,
            aiMonthlyTokenCap: true,
          },
        },
        subscriptions: { orderBy: { createdAt: "desc" }, take: 1 },
        _count: { select: { users: true, branches: true } },
      },
    }),
  );
  if (!tenant) throw new NotFoundError("Empresa");
  return tenant;
}

// ---------------------------------------------------------------------------
// Alta rápida, módulos por cliente, datos fiscales diferidos y claves temporales
// ---------------------------------------------------------------------------

/** Casillas que un plan puede ofrecer (algún módulo del grupo está incluido en el plan). */
function groupsOfferedBy(included: readonly string[]): string[] {
  return MODULE_GROUPS.filter((g) => g.modules.some((m) => included.includes(m))).map((g) => g.id);
}

/**
 * Alta inmediata de una cuenta: empresa, roles, sucursal y almacén base y un administrador ACTIVO con contraseña
 * temporal (la devuelve UNA vez; no se guarda en claro ni en la bitácora). No exige RUC ni SUNAT: el cliente (o el
 * SuperAdmin) completa después el RUC oficial y el correo corporativo para activar la facturación electrónica.
 */
export async function createTenantQuick(
  actor: AuthUser,
  input: CreateTenantQuickInput,
  meta: RequestMeta = {},
): Promise<{ tenantId: string; adminEmail: string; tempPassword: string }> {
  requireSuperAdmin(actor);
  const data = createTenantQuickSchema.parse(input);
  const tempPassword = data.tempPassword ?? generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  try {
    const tenantId = await withAdmin(
      actorFor(actor, `Alta rápida de tenant ${data.legalName}`, null, meta),
      (db) =>
        db.$transaction(async (tx) => {
          const plan = await tx.plan.findFirst({
            where: { code: data.planCode, deletedAt: null, isActive: true },
          });
          if (!plan) throw new NotFoundError("Plan");
          const groups = (data.groups ?? BUSINESS_PRESETS[data.businessType]).filter((id) =>
            groupsOfferedBy(plan.includedModules).includes(id),
          );
          const base = await provisionTenantBase(tx, {
            planCode: data.planCode,
            legalName: data.legalName,
            tradeName: data.tradeName,
            taxId: data.taxId ?? null,
            contactEmail: data.contactEmail,
            businessType: data.businessType,
            disabledModules: disabledFromGroups(plan.includedModules, groups),
          });
          if (data.contactEmail)
            await tx.tenant.update({
              where: { id: base.tenantId },
              data: { billingEmail: data.contactEmail },
            });
          const admin = await tx.user.create({
            data: {
              tenantId: base.tenantId,
              email: data.adminEmail,
              name: data.adminName,
              status: "ACTIVE",
              passwordHash,
              mustChangePassword: true,
              roleId: base.roleIds.admin,
            },
          });
          await tx.auditLog.create({
            data: {
              tenantId: base.tenantId,
              actorType: "SUPERADMIN",
              actorUserId: actor.userId,
              action: "tenant.created_quick",
              entityType: "tenant",
              entityId: base.tenantId,
              // La contraseña temporal NUNCA se audita; solo queda constancia de que se entregó una.
              after: {
                legalName: data.legalName,
                planCode: data.planCode,
                businessType: data.businessType,
                groups,
                fiscalPending: !data.taxId,
                adminUserId: admin.id,
                temporaryPassword: true,
              },
              ip: meta.ip ?? null,
            },
          });
          return base.tenantId;
        }),
    );
    return { tenantId, adminEmail: data.adminEmail, tempPassword };
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError(
        "TENANT_CONFLICT",
        "Ya existe una empresa con ese RUC o un usuario con ese correo",
      );
    throw error;
  }
}

/**
 * Casillas de módulos y rubro de un cliente. Solo se pueden activar los módulos que el plan incluye (el plan
 * es el techo comercial); apagar una casilla quita sus permisos de menús, botones y servicios. El Núcleo POS
 * es obligatorio y Usuarios/Configuración/Auditoría no se pueden apagar.
 */
export async function updateTenantModules(
  actor: AuthUser,
  input: UpdateTenantModulesInput,
  meta: RequestMeta = {},
) {
  requireSuperAdmin(actor);
  const data = updateTenantModulesSchema.parse(input);
  await withAdmin(actorFor(actor, `Módulos: ${data.reason}`, data.tenantId, meta), (db) =>
    db.$transaction(async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: data.tenantId, deletedAt: null },
        include: { plan: true, settings: true },
      });
      if (!tenant?.settings) throw new NotFoundError("Empresa");
      const included = tenant.plan.includedModules;
      if (!data.groups.includes("core"))
        throw new ConflictError("CORE_REQUIRED", "El Núcleo POS es obligatorio para operar");
      const offered = groupsOfferedBy(included);
      const outside = data.groups.filter((id) => !offered.includes(id));
      if (outside.length > 0) {
        const labels = MODULE_GROUPS.filter((g) => outside.includes(g.id)).map((g) => g.label);
        throw new ConflictError(
          "MODULE_NOT_IN_PLAN",
          `El plan ${tenant.plan.name} no incluye: ${labels.join(", ")}. Cambia el plan para activarlos`,
        );
      }
      const disabled = disabledFromGroups(included, data.groups);
      await tx.tenantSettings.update({
        where: { tenantId: data.tenantId },
        // La lista blanca heredada se limpia: desde ahora manda solo `disabledModules`.
        data: { disabledModules: disabled, enabledModules: [] },
      });
      await tx.tenant.update({
        where: { id: data.tenantId },
        data: { businessType: data.businessType },
      });
      await tx.auditLog.create({
        data: {
          tenantId: data.tenantId,
          actorType: "SUPERADMIN",
          actorUserId: actor.userId,
          action: "tenant.modules_changed",
          entityType: "tenant",
          entityId: data.tenantId,
          before: {
            businessType: tenant.businessType,
            disabledModules: tenant.settings.disabledModules,
          },
          after: {
            businessType: data.businessType,
            disabledModules: disabled,
            groups: data.groups,
          },
          reason: data.reason,
          ip: meta.ip ?? null,
        },
      });
    }),
  );
  invalidateAuthCache();
}

/**
 * Completa o corrige el RUC oficial y el correo corporativo (ambos opcionales por separado). Con comprobantes ya
 * emitidos el RUC no se puede cambiar (el emisor de esos documentos no puede variar).
 */
export async function updateTenantFiscal(
  actor: AuthUser,
  input: UpdateTenantFiscalInput,
  meta: RequestMeta = {},
) {
  requireSuperAdmin(actor);
  const data = updateTenantFiscalSchema.parse(input);
  try {
    await withAdmin(actorFor(actor, `Datos fiscales: ${data.reason}`, data.tenantId, meta), (db) =>
      db.$transaction(async (tx) => {
        const tenant = await tx.tenant.findFirst({ where: { id: data.tenantId, deletedAt: null } });
        if (!tenant) throw new NotFoundError("Empresa");
        if (data.taxId && data.taxId !== tenant.taxId) {
          const issued = await tx.fiscalDocument.count({ where: { tenantId: data.tenantId } });
          if (issued > 0 && tenant.taxId)
            throw new ConflictError(
              "TAXID_LOCKED",
              "No se puede cambiar el RUC: ya hay comprobantes emitidos con el actual",
            );
        }
        await tx.tenant.update({
          where: { id: data.tenantId },
          data: {
            ...(data.taxId ? { taxId: data.taxId, taxIdType: "RUC" } : {}),
            ...(data.corporateEmail
              ? { billingEmail: data.corporateEmail, contactEmail: data.corporateEmail }
              : {}),
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: data.tenantId,
            actorType: "SUPERADMIN",
            actorUserId: actor.userId,
            action: "tenant.fiscal_updated",
            entityType: "tenant",
            entityId: data.tenantId,
            before: { taxId: tenant.taxId, billingEmail: tenant.billingEmail },
            after: {
              taxId: data.taxId ?? tenant.taxId,
              billingEmail: data.corporateEmail ?? tenant.billingEmail,
            },
            reason: data.reason,
            ip: meta.ip ?? null,
          },
        });
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("TENANT_CONFLICT", "Ya existe otra empresa con ese RUC");
    throw error;
  }
  invalidateAuthCache();
}

/** Nueva contraseña temporal para el administrador de la empresa (la devuelve una vez; revoca sus sesiones). */
export async function resetTenantAdminPassword(
  actor: AuthUser,
  input: ResetTenantAdminPasswordInput,
  meta: RequestMeta = {},
): Promise<{ adminEmail: string; tempPassword: string }> {
  requireSuperAdmin(actor);
  const data = resetTenantAdminPasswordSchema.parse(input);
  const tempPassword = data.tempPassword ?? generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);
  const adminEmail = await withAdmin(
    actorFor(actor, `Contraseña temporal: ${data.reason}`, data.tenantId, meta),
    (db) =>
      db.$transaction(async (tx) => {
        const admin = await tx.user.findFirst({
          where: {
            tenantId: data.tenantId,
            deletedAt: null,
            status: { not: "DISABLED" },
            role: { key: "admin" },
          },
          orderBy: { createdAt: "asc" },
        });
        if (!admin) throw new NotFoundError("Administrador de la empresa");
        await tx.user.update({
          where: { id: admin.id },
          data: {
            passwordHash,
            mustChangePassword: true,
            status: "ACTIVE",
            failedLoginCount: 0,
            lockedUntil: null,
            sessionVersion: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: data.tenantId,
            actorType: "SUPERADMIN",
            actorUserId: actor.userId,
            action: "tenant.admin_password_reset",
            entityType: "user",
            entityId: admin.id,
            reason: data.reason,
            ip: meta.ip ?? null,
          },
        });
        return admin.email;
      }),
  );
  invalidateAuthCache();
  return { adminEmail, tempPassword };
}

/** Lo que muestra la tarjeta «Rubros y módulos activos» de /admin/tenants/[id]. */
export async function getTenantModules(actor: AuthUser, tenantId: string) {
  requireSuperAdmin(actor);
  const tenant = await withPlatform((db) =>
    db.tenant.findFirst({
      where: { id: tenantId },
      select: {
        businessType: true,
        taxId: true,
        billingEmail: true,
        isDemo: true,
        plan: { select: { code: true, name: true, includedModules: true } },
        settings: { select: { enabledModules: true, disabledModules: true } },
      },
    }),
  );
  if (!tenant) throw new NotFoundError("Empresa");
  return {
    businessType: tenant.businessType,
    plan: tenant.plan,
    enabledModules: tenant.settings?.enabledModules ?? [],
    disabledModules: tenant.settings?.disabledModules ?? [],
    fiscal: {
      taxId: tenant.taxId,
      billingEmail: tenant.billingEmail,
      ready: tenant.isDemo || Boolean(tenant.taxId),
    },
    locked: [...LOCKED_MODULES],
  };
}
