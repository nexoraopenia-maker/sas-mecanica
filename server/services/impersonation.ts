import { z } from "zod";
import { requireSuperAdmin, type AuthUser } from "@/lib/auth/can";
import { withAdmin } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import type { RequestMeta } from "./audit";

const startSchema = z.object({
  tenantId: z.uuid(),
  reason: z
    .string()
    .trim()
    .min(10, "Describe el motivo del soporte (mínimo 10 caracteres)")
    .max(300),
});

/**
 * Inicia una sesión de soporte dentro de un tenant. Queda registrada en la
 * auditoría DEL TENANT (visible para su administrador) y la UI muestra un banner permanente.
 */
export async function startImpersonation(
  actor: AuthUser,
  input: { tenantId: string; reason: string },
  meta: RequestMeta = {},
): Promise<{ sessionId: string }> {
  requireSuperAdmin(actor);
  const { tenantId, reason } = startSchema.parse(input);
  return withAdmin(
    {
      userId: actor.userId,
      reason: `Impersonación: ${reason}`,
      tenantId,
      ip: meta.ip,
      requestId: meta.requestId,
    },
    (db) =>
      db.$transaction(async (tx) => {
        const tenant = await tx.tenant.findFirst({ where: { id: tenantId, deletedAt: null } });
        if (!tenant) throw new NotFoundError("Empresa");
        const session = await tx.impersonationSession.create({
          data: { tenantId, superAdminUserId: actor.userId, reason, ip: meta.ip ?? null },
        });
        await tx.auditLog.create({
          data: {
            tenantId,
            actorType: "SUPERADMIN",
            actorUserId: actor.userId,
            impersonatorUserId: actor.userId,
            action: "impersonation.started",
            entityType: "impersonation_session",
            entityId: session.id,
            reason,
            ip: meta.ip ?? null,
          },
        });
        return { sessionId: session.id };
      }),
  );
}

/** Termina la sesión de soporte. `actor` es el SuperAdmin (con o sin impersonación activa). */
export async function endImpersonation(
  actor: AuthUser,
  sessionId: string,
  meta: RequestMeta = {},
): Promise<void> {
  if (!actor.isSuperAdmin || !actor.mfaVerified) throw new NotFoundError("Sesión de soporte");
  await withAdmin({ userId: actor.userId, reason: "Fin de impersonación", ip: meta.ip }, (db) =>
    db.$transaction(async (tx) => {
      const session = await tx.impersonationSession.findFirst({
        where: { id: sessionId, superAdminUserId: actor.userId, endedAt: null },
      });
      if (!session) throw new NotFoundError("Sesión de soporte");
      await tx.impersonationSession.update({
        where: { id: sessionId },
        data: { endedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          tenantId: session.tenantId,
          actorType: "SUPERADMIN",
          actorUserId: actor.userId,
          impersonatorUserId: actor.userId,
          action: "impersonation.ended",
          entityType: "impersonation_session",
          entityId: sessionId,
          ip: meta.ip ?? null,
        },
      });
    }),
  );
}
