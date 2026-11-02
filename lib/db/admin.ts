import { logger } from "@/lib/logger";
import { getAdminClient } from "./raw.ts";
import type { PrismaClient } from "./generated/client.ts";

export interface AdminActor {
  /** SuperAdmin que opera (null = tarea de sistema, p. ej. un job). */
  userId: string | null;
  /** Motivo obligatorio: queda en auditoría. */
  reason: string;
  /** Tenant afectado, si aplica. */
  tenantId?: string | null;
  ip?: string;
  requestId?: string;
}

export type AdminClient = PrismaClient;

/**
 * Cliente PRIVILEGIADO (dueño de las tablas, sin RLS) para SuperAdmin y tareas
 * de plataforma. Cada uso escribe primero un registro de auditoría; si la
 * auditoría falla, la operación no se ejecuta.
 */
export async function withAdmin<T>(
  actor: AdminActor,
  fn: (db: AdminClient) => Promise<T>,
): Promise<T> {
  const reason = actor.reason.trim();
  if (reason.length < 3) throw new Error("withAdmin exige un motivo explícito");

  const db = getAdminClient();
  await db.auditLog.create({
    data: {
      tenantId: actor.tenantId ?? null,
      actorType: actor.userId ? "SUPERADMIN" : "SYSTEM",
      actorUserId: actor.userId,
      action: "admin.client_used",
      entityType: "admin_client",
      reason,
      ip: actor.ip ?? null,
      requestId: actor.requestId ?? null,
    },
  });
  logger.warn(
    { tenantId: actor.tenantId ?? null, userId: actor.userId, reason },
    "cliente privilegiado en uso",
  );
  return fn(db);
}
