import { requireSuperAdmin, type AuthUser } from "@/lib/auth/can";
import { withAdmin, withPlatform } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { planLimitsSchema } from "@/lib/validation/tenants";
import type { RequestMeta } from "./audit";
import { invalidateAuthCache } from "./session-resolver";

export async function listPlans(actor: AuthUser) {
  requireSuperAdmin(actor);
  return withPlatform((db) =>
    db.plan.findMany({
      where: { deletedAt: null },
      orderBy: { sortOrder: "asc" },
      include: { _count: { select: { tenants: true } } },
    }),
  );
}

/** Edita precio y límites. Los límites se aplican en el backend en la siguiente operación. */
export async function updatePlanLimits(actor: AuthUser, input: unknown, meta: RequestMeta = {}) {
  requireSuperAdmin(actor);
  const data = planLimitsSchema.parse(input);
  await withAdmin(
    { userId: actor.userId, reason: `Edición de plan ${data.planId}`, ip: meta.ip },
    (db) =>
      db.$transaction(async (tx) => {
        const before = await tx.plan.findFirst({ where: { id: data.planId, deletedAt: null } });
        if (!before) throw new NotFoundError("Plan");
        await tx.plan.update({
          where: { id: data.planId },
          data: {
            priceMonthly: data.priceMonthly.toFixed(2),
            maxBranches: data.maxBranches,
            maxUsers: data.maxUsers,
            maxWarehouses: data.maxWarehouses,
            monthlyAiTokens: data.monthlyAiTokens,
          },
        });
        await tx.auditLog.create({
          data: {
            actorType: "SUPERADMIN",
            actorUserId: actor.userId,
            action: "plan.limits_changed",
            entityType: "plan",
            entityId: data.planId,
            before: {
              priceMonthly: before.priceMonthly.toString(),
              maxBranches: before.maxBranches,
              maxUsers: before.maxUsers,
              maxWarehouses: before.maxWarehouses,
              monthlyAiTokens: before.monthlyAiTokens,
            },
            after: {
              priceMonthly: data.priceMonthly,
              maxBranches: data.maxBranches,
              maxUsers: data.maxUsers,
              maxWarehouses: data.maxWarehouses,
              monthlyAiTokens: data.monthlyAiTokens,
            },
            ip: meta.ip ?? null,
          },
        });
      }),
  );
  invalidateAuthCache();
}
