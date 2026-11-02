import { requireSuperAdmin, type AuthUser } from "@/lib/auth/can";
import { withPlatform } from "@/lib/db";

export interface PlatformMetrics {
  mrr: string;
  activeAccounts: number;
  suspendedAccounts: number;
  activeDemos: number;
  churn30d: number;
  accountsByPlan: Array<{ plan: string; count: number }>;
  aiUsage: Array<{ tenantId: string; tenant: string; tokens: number; costUsd: string }>;
}

/** Métricas globales. MRR = suma del precio del plan de cuentas reales (no demo) con suscripción activa. */
export async function getPlatformMetrics(
  actor: AuthUser,
  now: Date = new Date(),
): Promise<PlatformMetrics> {
  requireSuperAdmin(actor);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = new Date(now.getTime() - 30 * 86_400_000);

  return withPlatform(async (db) => {
    const [mrrRows, active, suspended, demos, cancelled30, byPlan, ai] = await Promise.all([
      db.$queryRaw<{ mrr: string }[]>`
        SELECT COALESCE(SUM(p."priceMonthly"), 0)::text AS mrr
        FROM tenants t
        JOIN plans p ON p.id = t."planId"
        JOIN subscriptions s ON s."tenantId" = t.id AND s.status = 'ACTIVE'
        WHERE NOT t."isDemo" AND t.status = 'ACTIVE' AND t."deletedAt" IS NULL`,
      db.tenant.count({ where: { isDemo: false, status: "ACTIVE", deletedAt: null } }),
      db.tenant.count({ where: { isDemo: false, status: "SUSPENDED", deletedAt: null } }),
      db.tenant.count({ where: { isDemo: true, demoExpiresAt: { gt: now } } }),
      db.tenant.count({ where: { isDemo: false, cancelledAt: { gte: since } } }),
      db.$queryRaw<{ plan: string; count: bigint }[]>`
        SELECT p.name AS plan, count(*) AS count
        FROM tenants t JOIN plans p ON p.id = t."planId"
        WHERE NOT t."isDemo" AND t."deletedAt" IS NULL
        GROUP BY p.name ORDER BY count(*) DESC`,
      db.$queryRaw<{ tenantId: string; tenant: string; tokens: bigint; cost: string }[]>`
        SELECT t.id AS "tenantId", COALESCE(t."tradeName", t."legalName") AS tenant,
               SUM(r."promptTokens" + r."completionTokens") AS tokens, SUM(r."costUsd")::text AS cost
        FROM ai_runs r JOIN tenants t ON t.id = r."tenantId"
        WHERE r."startedAt" >= ${monthStart} AND NOT r.simulated
        GROUP BY t.id, tenant ORDER BY tokens DESC LIMIT 50`,
    ]);
    const base = active + cancelled30;
    return {
      mrr: mrrRows[0]?.mrr ?? "0",
      activeAccounts: active,
      suspendedAccounts: suspended,
      activeDemos: demos,
      churn30d: base === 0 ? 0 : cancelled30 / base,
      accountsByPlan: byPlan.map((row) => ({ plan: row.plan, count: Number(row.count) })),
      aiUsage: ai.map((row) => ({
        tenantId: row.tenantId,
        tenant: row.tenant,
        tokens: Number(row.tokens),
        costUsd: row.cost,
      })),
    };
  });
}
