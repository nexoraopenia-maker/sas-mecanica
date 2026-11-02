import { requireSuperAdmin, type AuthUser } from "@/lib/auth/can";
import { generateToken } from "@/lib/auth/secure-token";
import { Prisma, withAdmin, withPlatform } from "@/lib/db";
import { ConflictError, NotFoundError, PlanLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  createTenantSchema,
  tenantReasonSchema,
  type CreateTenantInput,
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
