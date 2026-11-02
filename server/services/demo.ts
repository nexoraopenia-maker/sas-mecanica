import { BUCKETS, getStorage } from "@/server/integrations/storage";
import { randomBytes } from "node:crypto";
import type { AuthUser } from "@/lib/auth/can";
import { consumeRateLimit, pruneRateLimits, withAdmin, withPlatform, withTenant } from "@/lib/db";
import { NotFoundError, PermissionDeniedError, RateLimitError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { RequestMeta } from "./audit";
import { seedDemoData } from "./demo-seed";
import { provisionTenantBase } from "./provisioning";
import { DEMO_AI_TOKEN_CAP } from "./platform-seed";

export const DEMO_TTL_HOURS = 24;

export interface DemoSession {
  tenantId: string;
  userId: string;
  expiresAt: Date;
}

/**
 * Crea un tenant sandbox POR SESIÓN: plan "demo" (límites estrictos, tokens de
 * IA topados), usuario administrador sin contraseña (solo entra por esta vía),
 * seed realista y expiración a las 24 h. Protegido por rate limit (el captcha
 * se verifica en la Server Action).
 */
export async function provisionDemo(meta: RequestMeta = {}): Promise<DemoSession> {
  const perIp = await consumeRateLimit("demo:ip", meta.ip ?? "unknown", 3, 3600);
  if (!perIp.allowed) throw new RateLimitError(perIp.retryAfterSeconds);
  const global = await consumeRateLimit("demo:global", "all", 100, 3600);
  if (!global.allowed) throw new RateLimitError(global.retryAfterSeconds);

  const key = randomBytes(9).toString("base64url");
  const expiresAt = new Date(Date.now() + DEMO_TTL_HOURS * 3_600_000);

  const base = await withAdmin(
    {
      userId: null,
      reason: "Aprovisionamiento de cuenta demo",
      ip: meta.ip,
      requestId: meta.requestId,
    },
    (db) =>
      db.$transaction(async (tx) => {
        const provisioned = await provisionTenantBase(tx, {
          planCode: "demo",
          allowHiddenPlan: true,
          legalName: "Taller Demo Autopartes SAC",
          tradeName: "Taller Demo",
          taxId: null,
          address: "Av. Los Talleres 123, Lima",
          phone: "+51 1 555 0100",
          contactEmail: `demo-${key}@demo.invalid`,
          isDemo: true,
          demoExpiresAt: expiresAt,
          demoSessionKey: key,
          aiMonthlyTokenCap: DEMO_AI_TOKEN_CAP,
        });
        const admin = await tx.user.create({
          data: {
            tenantId: provisioned.tenantId,
            email: `demo-${key}@demo.invalid`,
            name: "Dueño Demo",
            status: "ACTIVE",
            roleId: provisioned.roleIds.admin,
          },
        });
        const mechanic = await tx.user.create({
          data: {
            tenantId: provisioned.tenantId,
            email: `mecanico-${key}@demo.invalid`,
            name: "Mecánico Demo",
            status: "ACTIVE",
            roleId: provisioned.roleIds.mechanic,
          },
        });
        await tx.auditLog.create({
          data: {
            tenantId: provisioned.tenantId,
            actorType: "SYSTEM",
            action: "demo.provisioned",
            entityType: "tenant",
            entityId: provisioned.tenantId,
            after: { expiresAt: expiresAt.toISOString() },
            ip: meta.ip ?? null,
          },
        });
        return { ...provisioned, adminId: admin.id, mechanicId: mechanic.id };
      }),
  );

  // El seed corre con el rol de la app (RLS activo): demuestra que la demo se comporta como un tenant real.
  await withTenant(
    base.tenantId,
    (tx) =>
      seedDemoData(tx, {
        warehouseId: base.warehouseId,
        branchId: base.branchId,
        adminId: base.adminId,
        mechanicId: base.mechanicId,
      }),
    {
      timeoutMs: 120_000,
    },
  );
  return { tenantId: base.tenantId, userId: base.adminId, expiresAt };
}

/** "Restaurar demo": entrega un sandbox nuevo y expira el actual (la purga lo elimina después). */
export async function restoreDemo(actor: AuthUser, meta: RequestMeta = {}): Promise<DemoSession> {
  if (!actor.isDemo || !actor.tenantId || actor.impersonation)
    throw new PermissionDeniedError("demo:restaurar");
  const limit = await consumeRateLimit("demo:restore", actor.tenantId, 5, 3600);
  if (!limit.allowed) throw new RateLimitError(limit.retryAfterSeconds);

  const fresh = await provisionDemo(meta);
  await withAdmin(
    {
      userId: null,
      reason: "Restauración de demo: expira el sandbox anterior",
      tenantId: null,
      ip: meta.ip,
    },
    async (db) => {
      const result = await db.tenant.updateMany({
        where: { id: actor.tenantId ?? "", isDemo: true },
        data: { demoExpiresAt: new Date() },
      });
      if (result.count !== 1) throw new NotFoundError("Demo");
    },
  );
  return fresh;
}

/**
 * Job de limpieza: elimina por completo los sandbox vencidos (incluye kardex y
 * auditoría, vía purge_tenant) y los contadores de rate limit antiguos.
 */
export async function purgeExpiredDemos(now: Date = new Date()): Promise<{ purged: number }> {
  const expired = await withPlatform((db) =>
    db.tenant.findMany({
      where: { isDemo: true, demoExpiresAt: { lte: now } },
      select: { id: true },
      take: 50,
    }),
  );
  let purged = 0;
  for (const { id } of expired) {
    try {
      await withAdmin(
        { userId: null, reason: "Purga de demo vencida", tenantId: null },
        async (db) => {
          await db.$queryRaw`SELECT purge_tenant(${id}::uuid)`;
          await db.auditLog.create({
            data: {
              actorType: "SYSTEM",
              action: "demo.purged",
              entityType: "tenant",
              entityId: id,
            },
          });
        },
      );
      purged += 1;
      // Fotos y firmas de la demo: no deben quedar huérfanas en el bucket. Si falla, no revierte la purga.
      for (const bucket of Object.values(BUCKETS)) {
        await getStorage()
          .deletePrefix(bucket, `${id}/`)
          .catch((error: unknown) =>
            logger.error(
              { err: error, tenantId: id, bucket },
              "no se pudieron borrar los archivos de la demo",
            ),
          );
      }
    } catch (error) {
      logger.error({ err: error, tenantId: id }, "no se pudo purgar la demo");
    }
  }
  await pruneRateLimits();
  return { purged };
}
