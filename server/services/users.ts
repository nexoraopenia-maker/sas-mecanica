import { generateToken } from "@/lib/auth/secure-token";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { z } from "zod";
import { Prisma, withTenant, type UserStatus } from "@/lib/db";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { inviteUserSchema } from "@/lib/validation/auth";
import { getEmailSender } from "@/server/integrations/email";
import { inviteEmail } from "@/server/integrations/email-templates";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { assertWithinPlan, loadPlan } from "./limits";
import { invalidateAuthCache } from "./session-resolver";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function sendInvite(to: string, name: string, company: string, token: string): Promise<void> {
  try {
    await getEmailSender().send(inviteEmail({ to, name, company, token }));
  } catch (error) {
    // La invitación existe; el administrador puede reenviarla.
    logger.error({ err: error }, "no se pudo enviar el correo de invitación");
  }
}

type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

export async function listUsers(actor: AuthUser) {
  requirePermission(actor, "users:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        lastLoginAt: true,
        defaultBranchId: true,
        defaultBranch: { select: { name: true } },
        role: { select: { id: true, name: true, key: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  );
}

/** Usuarios, sucursales activas y uso del plan: lo que necesita la pestaña Usuarios. */
export async function getUsersOverview(actor: AuthUser) {
  requirePermission(actor, "users:ver");
  const tenantId = requireTenantId(actor);
  const users = await listUsers(actor);
  return withTenant(tenantId, async (tx) => {
    const [branches, { plan }, used] = await Promise.all([
      tx.branch.findMany({
        where: { isActive: true },
        select: { id: true, name: true, isMain: true },
        orderBy: [{ isMain: "desc" }, { name: "asc" }],
      }),
      loadPlan(tx),
      tx.user.count({ where: { status: { not: "DISABLED" } } }),
    ]);
    return {
      users,
      branches,
      usage: { used, max: plan.maxUsers, reached: plan.maxUsers !== null && used >= plan.maxUsers },
    };
  });
}

/** Solo un administrador puede otorgar el rol Administrador (evita que alguien se promueva a sí mismo). */
function assertCanGrantRole(actor: AuthUser, role: { key: string | null }): void {
  if (role.key === "admin" && actor.roleKey !== "admin" && !actor.impersonation)
    throw new PermissionDeniedError("solo un administrador puede asignar el rol Administrador");
}

/** Sucursal válida del tenant; con una sola sucursal activa se usa por defecto. */
async function resolveBranch(tx: Tx, branchId: string | undefined): Promise<string | null> {
  if (branchId) {
    const branch = await tx.branch.findFirst({ where: { id: branchId, isActive: true } });
    if (!branch) throw new NotFoundError("Sucursal");
    return branch.id;
  }
  const active = await tx.branch.findMany({
    where: { isActive: true },
    select: { id: true },
    take: 2,
  });
  return active.length === 1 ? (active[0]?.id ?? null) : null;
}

/** Invita a un usuario. El límite de usuarios del plan se valida aquí, en el backend. */
export async function inviteUser(
  actor: AuthUser,
  input: { email: string; name: string; roleId: string; branchId?: string },
  meta: RequestMeta = {},
) {
  requirePermission(actor, "users:crear");
  const tenantId = requireTenantId(actor);
  const data = inviteUserSchema.parse(input);
  const { token, hash } = generateToken();

  try {
    const created = await withTenant(tenantId, async (tx) => {
      await assertWithinPlan(tx, "users");
      const role = await tx.role.findFirst({ where: { id: data.roleId } });
      if (!role) throw new NotFoundError("Rol");
      assertCanGrantRole(actor, role);
      const branchId = await resolveBranch(tx, data.branchId);
      const tenant = await tx.tenant.findFirstOrThrow({
        select: { legalName: true, tradeName: true },
      });
      const user = await tx.user.create({
        data: {
          email: data.email,
          name: data.name,
          status: "INVITED",
          roleId: role.id,
          defaultBranchId: branchId,
        },
      });
      await tx.authToken.create({
        data: {
          userId: user.id,
          type: "INVITE",
          tokenHash: hash,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "user.invited",
        entityType: "user",
        entityId: user.id,
        after: { email: data.email, roleId: role.id, branchId },
      });
      return { userId: user.id, company: tenant.tradeName ?? tenant.legalName };
    });
    await sendInvite(data.email, data.name, created.company, token);
    return { userId: created.userId };
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("EMAIL_TAKEN", "Ese correo ya está registrado");
    throw error;
  }
}

export async function resendInvite(
  actor: AuthUser,
  userId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:crear");
  const tenantId = requireTenantId(actor);
  const { token, hash } = generateToken();
  const target = await withTenant(tenantId, async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, status: "INVITED" } });
    if (!user) throw new NotFoundError("Invitación");
    const tenant = await tx.tenant.findFirstOrThrow({
      select: { legalName: true, tradeName: true },
    });
    await tx.authToken.updateMany({
      where: { userId, type: "INVITE", usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.authToken.create({
      data: {
        userId,
        type: "INVITE",
        tokenHash: hash,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "user.invite_resent",
      entityType: "user",
      entityId: userId,
    });
    return { email: user.email, name: user.name, company: tenant.tradeName ?? tenant.legalName };
  });
  await sendInvite(target.email, target.name, target.company, token);
}

/** Evita dejar el tenant sin ningún administrador activo. */
async function assertNotLastAdmin(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  userId: string,
): Promise<void> {
  const target = await tx.user.findFirst({ where: { id: userId }, include: { role: true } });
  if (target?.role?.key !== "admin" || target.status !== "ACTIVE") return;
  const others = await tx.user.count({
    where: { id: { not: userId }, status: "ACTIVE", role: { key: "admin" } },
  });
  if (others === 0)
    throw new ConflictError("LAST_ADMIN", "Debe quedar al menos un administrador activo");
}

export async function setUserStatus(
  actor: AuthUser,
  userId: string,
  status: Extract<UserStatus, "ACTIVE" | "DISABLED">,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:editar");
  if (userId === actor.userId)
    throw new ConflictError("SELF_DISABLE", "No puedes desactivar tu propia cuenta");
  await withTenant(requireTenantId(actor), async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId } });
    if (!user || user.status === "INVITED") throw new NotFoundError("Usuario");
    if (status === "DISABLED") await assertNotLastAdmin(tx, userId);
    // Reactivar a alguien ocupa un cupo del plan igual que invitarlo.
    if (status === "ACTIVE" && user.status === "DISABLED") await assertWithinPlan(tx, "users");
    await tx.user.update({
      where: { id: userId },
      // Deshabilitar revoca sus sesiones al instante.
      data: { status, ...(status === "DISABLED" ? { sessionVersion: { increment: 1 } } : {}) },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: status === "DISABLED" ? "user.disabled" : "user.enabled",
      entityType: "user",
      entityId: userId,
      before: { status: user.status },
      after: { status },
    });
  });
  invalidateAuthCache();
}

export async function changeUserRole(
  actor: AuthUser,
  userId: string,
  roleId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const [user, role] = await Promise.all([
      tx.user.findFirst({ where: { id: userId } }),
      tx.role.findFirst({ where: { id: roleId } }),
    ]);
    if (!user) throw new NotFoundError("Usuario");
    if (!role) throw new NotFoundError("Rol");
    assertCanGrantRole(actor, role);
    if (role.key !== "admin") await assertNotLastAdmin(tx, userId);
    await tx.user.update({ where: { id: userId }, data: { roleId } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "user.role_changed",
      entityType: "user",
      entityId: userId,
      before: { roleId: user.roleId },
      after: { roleId },
    });
  });
  invalidateAuthCache();
}

const branchChangeSchema = z.object({ userId: z.uuid(), branchId: z.uuid().nullable() });

/** Cambia la sucursal base de un usuario (null = sin sucursal fija). */
export async function changeUserBranch(
  actor: AuthUser,
  input: { userId: string; branchId: string | null },
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "users:editar");
  const data = branchChangeSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const user = await tx.user.findFirst({ where: { id: data.userId } });
    if (!user) throw new NotFoundError("Usuario");
    const branchId = data.branchId ? await resolveBranch(tx, data.branchId) : null;
    await tx.user.update({ where: { id: data.userId }, data: { defaultBranchId: branchId } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "user.branch_changed",
      entityType: "user",
      entityId: data.userId,
      before: { branchId: user.defaultBranchId },
      after: { branchId },
    });
  });
}
