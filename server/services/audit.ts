import type { AuthUser } from "@/lib/auth/can";
import type { ActorType, Prisma, TenantTx } from "@/lib/db";

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
}

export interface AuditContext extends RequestMeta {
  actorType: ActorType;
  actorUserId: string | null;
  impersonatorUserId?: string | null;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  reason?: string;
}

/** Quién actúa: un usuario del tenant, o un SuperAdmin que está impersonando (queda marcado). */
export function auditContextOf(user: AuthUser, meta: RequestMeta = {}): AuditContext {
  return user.impersonation
    ? {
        actorType: "SUPERADMIN",
        actorUserId: user.userId,
        impersonatorUserId: user.userId,
        ...meta,
      }
    : { actorType: "USER", actorUserId: user.userId, impersonatorUserId: null, ...meta };
}

/** Registro inmutable dentro de la misma transacción del cambio auditado. */
export async function recordAudit(
  tx: TenantTx,
  context: AuditContext,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorType: context.actorType,
      actorUserId: context.actorUserId,
      impersonatorUserId: context.impersonatorUserId ?? null,
      ip: context.ip ?? null,
      userAgent: context.userAgent ?? null,
      requestId: context.requestId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? undefined,
      after: entry.after ?? undefined,
      reason: entry.reason ?? null,
    },
  });
}
