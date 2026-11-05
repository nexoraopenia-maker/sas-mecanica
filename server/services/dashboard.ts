import { can, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant } from "@/lib/db";
import { limaDay, startOfLimaDay } from "@/lib/reports/period";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/workshop/state";
import { computeAiMetrics, type AiMetrics } from "./reports";
import { listStock } from "./stock-queries";

const D = (value: string | number | Prisma.Decimal | null | undefined): Prisma.Decimal =>
  new Prisma.Decimal(value ?? 0);
const DAY = 86_400_000;

export interface DashboardData {
  sales: {
    todayCount: number;
    todayTotal: string;
    yesterdayTotal: string;
    monthTotal: string;
  } | null;
  stock: { critical: number; reorder: number } | null;
  workshop: {
    active: number;
    overdue: number;
    byStatus: Array<{ status: string; count: number }>;
  } | null;
  warranties: {
    expiring30: number;
    next: Array<{ id: string; description: string; plate: string | null; expiresAt: Date }>;
  } | null;
  receivables: { overdueCount: number; overdueTotal: string } | null;
  ai: (AiMetrics & { monthLabel: string }) | null;
}

/** Tablero del inicio. Cada tarjeta se calcula SOLO si el usuario tiene el permiso del módulo (nadie ve cifras ajenas a su rol). */
export async function getDashboard(
  actor: AuthUser,
  now: Date = new Date(),
): Promise<DashboardData> {
  const tenantId = requireTenantId(actor);
  const today = limaDay(now);
  const todayStart = startOfLimaDay(today);
  const tomorrowStart = new Date(todayStart.getTime() + DAY);
  const yesterdayStart = new Date(todayStart.getTime() - DAY);
  const monthStart = startOfLimaDay(`${today.slice(0, 8)}01`);

  const stockRows = can(actor, "inventory:ver") ? await listStock(actor, { limit: 500 }) : null;

  return withTenant(tenantId, async (tx) => {
    const sums = async (from: Date, to: Date) => {
      const result = await tx.sale.aggregate({
        where: { status: "COMPLETED", createdAt: { gte: from, lt: to } },
        _sum: { total: true },
        _count: true,
      });
      return { total: D(result._sum.total), count: result._count };
    };
    let sales: DashboardData["sales"] = null;
    let receivables: DashboardData["receivables"] = null;
    if (can(actor, "pos:ver")) {
      const [t, y, m, overdue] = await Promise.all([
        sums(todayStart, tomorrowStart),
        sums(yesterdayStart, todayStart),
        sums(monthStart, tomorrowStart),
        tx.receivable.aggregate({
          where: { status: "OVERDUE" },
          _sum: { balance: true },
          _count: true,
        }),
      ]);
      sales = {
        todayCount: t.count,
        todayTotal: t.total.toFixed(2),
        yesterdayTotal: y.total.toFixed(2),
        monthTotal: m.total.toFixed(2),
      };
      receivables = {
        overdueCount: overdue._count,
        overdueTotal: D(overdue._sum.balance).toFixed(2),
      };
    }

    // Una tienda de autopartes (rubro comercial) no ve Taller ni Garantías aunque tenga el permiso.
    const sellsServices = actor.businessType !== "AUTOPARTS";
    let workshop: DashboardData["workshop"] = null;
    if (sellsServices && can(actor, "workshop:ver")) {
      const grouped = await tx.workOrder.groupBy({
        by: ["status"],
        where: { status: { in: OPEN_WORK_ORDER_STATUSES } },
        _count: true,
      });
      const overdue = await tx.workOrder.count({
        where: { status: { in: OPEN_WORK_ORDER_STATUSES }, promisedAt: { lt: now } },
      });
      workshop = {
        active: grouped.reduce((s, g) => s + g._count, 0),
        overdue,
        byStatus: grouped.map((g) => ({ status: g.status, count: g._count })),
      };
    }

    let warranties: DashboardData["warranties"] = null;
    if (sellsServices && can(actor, "warranties:ver")) {
      const where = {
        status: "ACTIVE" as const,
        expiresAt: { gte: now, lte: new Date(now.getTime() + 30 * DAY) },
      };
      const [count, next] = await Promise.all([
        tx.warranty.count({ where }),
        tx.warranty.findMany({
          where,
          orderBy: { expiresAt: "asc" },
          take: 5,
          select: {
            id: true,
            description: true,
            expiresAt: true,
            vehicle: { select: { plate: true } },
          },
        }),
      ]);
      warranties = {
        expiring30: count,
        next: next.flatMap((w) =>
          w.expiresAt
            ? [
                {
                  id: w.id,
                  description: w.description,
                  plate: w.vehicle?.plate ?? null,
                  expiresAt: w.expiresAt,
                },
              ]
            : [],
        ),
      };
    }

    let ai: DashboardData["ai"] = null;
    if (can(actor, "ai_agent:ver")) {
      const period = {
        from: `${today.slice(0, 8)}01`,
        to: today,
        start: monthStart,
        endExclusive: tomorrowStart,
      };
      ai = { ...(await computeAiMetrics(tx, period)), monthLabel: today.slice(0, 7) };
    }

    const stock: DashboardData["stock"] = stockRows
      ? {
          critical: stockRows.filter((r) => r.status === "CRITICAL").length,
          reorder: stockRows.filter((r) => r.status === "REORDER").length,
        }
      : null;
    return { sales, stock, workshop, warranties, receivables, ai };
  });
}
