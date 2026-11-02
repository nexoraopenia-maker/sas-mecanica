import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant, type TenantTx } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import {
  clampSeasonality,
  computeReorder,
  REORDER_CONFIG,
  type DemandStats,
} from "@/lib/inventory/reorder-math";
import { reorderPolicySchema, type ReorderPolicyInput } from "@/lib/validation/inventory";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { evaluateStockAlert } from "./stock-alerts";

interface StatsRow {
  warehouseId: string;
  productId: string;
  out30: string;
  out90: string;
  sumSquares: string;
}

/**
 * Salidas NETAS por producto/almacén. Cuenta ventas y consumo en OT y descuenta
 * sus devoluciones/anulaciones; los ajustes y transferencias no son demanda.
 * `sumSquares` (suma de cuadrados de la salida diaria) permite la desviación
 * estándar sobre 90 días contando los días sin venta como 0.
 */
async function loadDemandStats(
  tx: TenantTx,
  now: Date,
): Promise<Map<string, DemandStats & { warehouseId: string; productId: string }>> {
  const rows = await tx.$queryRaw<StatsRow[]>`
    WITH movements AS (
      SELECT "warehouseId", "productId", "occurredAt", -"quantityDelta" AS qty
      FROM kardex_movements
      WHERE "tenantId" = app_current_tenant()
        AND type IN ('SALE', 'WORK_ORDER_CONSUMPTION', 'SALE_VOID', 'RETURN_CUSTOMER', 'WORK_ORDER_RETURN')
        AND "occurredAt" > ${now}::timestamptz - make_interval(days => ${REORDER_CONFIG.windowLong})
        AND "occurredAt" <= ${now}::timestamptz
    ),
    daily AS (
      SELECT "warehouseId", "productId", ("occurredAt" AT TIME ZONE 'UTC')::date AS day, SUM(qty) AS qty
      FROM movements GROUP BY 1, 2, 3
    ),
    squares AS (
      SELECT "warehouseId", "productId", SUM(qty * qty) AS sum_squares FROM daily GROUP BY 1, 2
    ),
    totals AS (
      SELECT "warehouseId", "productId",
             COALESCE(SUM(qty) FILTER (WHERE "occurredAt" > ${now}::timestamptz - make_interval(days => ${REORDER_CONFIG.windowShort})), 0) AS out30,
             COALESCE(SUM(qty), 0) AS out90
      FROM movements GROUP BY 1, 2
    )
    SELECT t."warehouseId", t."productId", t.out30::text, t.out90::text, s.sum_squares::text AS "sumSquares"
    FROM totals t JOIN squares s USING ("warehouseId", "productId")`;
  const map = new Map<string, DemandStats & { warehouseId: string; productId: string }>();
  for (const row of rows) {
    map.set(`${row.warehouseId}:${row.productId}`, {
      warehouseId: row.warehouseId,
      productId: row.productId,
      netOut30: Number(row.out30),
      netOut90: Number(row.out90),
      sumSquares90: Number(row.sumSquares),
    });
  }
  return map;
}

/** Plazo de entrega por producto: proveedor preferido; si no, el más rápido; si no, el del proveedor; si no, el default. */
async function loadLeadTimes(tx: TenantTx, productIds: string[]): Promise<Map<string, number>> {
  const links = await tx.supplierProduct.findMany({
    where: { productId: { in: productIds }, isActive: true },
    include: { supplier: { select: { defaultLeadTimeDays: true, isActive: true } } },
  });
  const byProduct = new Map<string, Array<{ days: number | null; preferred: boolean }>>();
  for (const link of links) {
    if (!link.supplier.isActive) continue;
    const days = link.leadTimeDays ?? link.supplier.defaultLeadTimeDays;
    byProduct.set(link.productId, [
      ...(byProduct.get(link.productId) ?? []),
      { days, preferred: link.isPreferred },
    ]);
  }
  const result = new Map<string, number>();
  for (const [productId, entries] of byProduct) {
    const pick = (list: typeof entries) => {
      const days = list.map((e) => e.days).filter((d): d is number => d !== null && d > 0);
      return days.length > 0 ? Math.min(...days) : null;
    };
    const lead = pick(entries.filter((e) => e.preferred)) ?? pick(entries);
    if (lead !== null) result.set(productId, lead);
  }
  return result;
}

export interface RecomputeSummary {
  evaluated: number;
  updated: number;
  alerts: number;
}

/**
 * Recalcula mínimo y punto de reorden de TODOS los productos con stock o
 * historial en el tenant, usando la rotación de 30 y 90 días. Guarda el
 * resultado calculado siempre; solo los productos en modo AUTO lo usan como
 * umbral vigente (los MANUAL conservan lo fijado por el usuario).
 * Idempotente: puede ejecutarse varias veces el mismo día.
 */
export async function recomputeReorderPolicies(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<RecomputeSummary> {
  const [stats, balances, policies] = await Promise.all([
    loadDemandStats(tx, now),
    tx.stockBalance.findMany({
      where: { product: { isStocked: true } },
      select: { warehouseId: true, productId: true },
    }),
    tx.reorderPolicy.findMany(),
  ]);

  const pairs = new Map<string, { warehouseId: string; productId: string }>();
  for (const b of balances) pairs.set(`${b.warehouseId}:${b.productId}`, b);
  for (const s of stats.values()) pairs.set(`${s.warehouseId}:${s.productId}`, s);
  for (const p of policies) pairs.set(`${p.warehouseId}:${p.productId}`, p);

  const leadTimes = await loadLeadTimes(tx, [
    ...new Set([...pairs.values()].map((p) => p.productId)),
  ]);
  const policyByKey = new Map(policies.map((p) => [`${p.warehouseId}:${p.productId}`, p]));

  let updated = 0;
  let alerts = 0;
  for (const [key, pair] of pairs) {
    const demand = stats.get(key) ?? { netOut30: 0, netOut90: 0, sumSquares90: 0 };
    const existing = policyByKey.get(key);
    const result = computeReorder(
      demand,
      leadTimes.get(pair.productId) ?? REORDER_CONFIG.defaultLeadTimeDays,
      Number(existing?.seasonalityFactor.toString() ?? 1),
    );
    const data = {
      computedMinStock: result.minStock.toString(),
      computedReorderPoint: result.reorderPoint.toString(),
      avgDailySales30: result.avgDailySales30.toString(),
      avgDailySales90: result.avgDailySales90.toString(),
      computedAt: now,
    };
    if (existing) {
      await tx.reorderPolicy.update({ where: { id: existing.id }, data });
    } else {
      await tx.reorderPolicy.create({
        data: { warehouseId: pair.warehouseId, productId: pair.productId, mode: "AUTO", ...data },
      });
    }
    updated += 1;
    const status = await evaluateStockAlert(tx, pair.warehouseId, pair.productId, now);
    if (status !== "OPTIMAL") alerts += 1;
  }
  return { evaluated: pairs.size, updated, alerts };
}

/** Recalculo bajo demanda para el tenant del usuario (botón "Recalcular"). */
export async function recomputeForTenant(
  actor: AuthUser,
  meta: RequestMeta = {},
): Promise<RecomputeSummary> {
  requirePermission(actor, "inventory:editar");
  return withTenant(
    requireTenantId(actor),
    async (tx) => {
      const summary = await recomputeReorderPolicies(tx);
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "reorder.recomputed",
        entityType: "reorder_policy",
        after: { ...summary },
      });
      return summary;
    },
    { timeoutMs: 120_000 },
  );
}

/**
 * Fija el modo y los umbrales de un producto: AUTO (por rotación) o MANUAL
 * (valores del usuario), más el factor de estacionalidad simple.
 */
export async function setReorderPolicy(
  actor: AuthUser,
  input: ReorderPolicyInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "inventory:editar");
  const data = reorderPolicySchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const [product, warehouse] = await Promise.all([
      tx.product.findFirst({ where: { id: data.productId, isStocked: true } }),
      tx.warehouse.findFirst({ where: { id: data.warehouseId } }),
    ]);
    if (!product) throw new NotFoundError("Producto");
    if (!warehouse) throw new NotFoundError("Almacén");

    const before = await tx.reorderPolicy.findFirst({
      where: { warehouseId: data.warehouseId, productId: data.productId },
    });
    const fields = {
      mode: data.mode,
      manualMinStock: data.mode === "MANUAL" ? (data.manualMinStock?.toString() ?? null) : null,
      manualReorderPoint:
        data.mode === "MANUAL" ? (data.manualReorderPoint?.toString() ?? null) : null,
      ...(data.seasonalityFactor !== undefined
        ? { seasonalityFactor: clampSeasonality(data.seasonalityFactor).toString() }
        : {}),
    };
    const policy = before
      ? await tx.reorderPolicy.update({ where: { id: before.id }, data: fields })
      : await tx.reorderPolicy.create({
          data: { warehouseId: data.warehouseId, productId: data.productId, ...fields },
        });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "reorder.policy_changed",
      entityType: "product",
      entityId: data.productId,
      before: before
        ? {
            mode: before.mode,
            min: before.manualMinStock?.toString() ?? null,
            rop: before.manualReorderPoint?.toString() ?? null,
            seasonality: before.seasonalityFactor.toString(),
          }
        : {},
      after: {
        mode: policy.mode,
        min: policy.manualMinStock?.toString() ?? null,
        rop: policy.manualReorderPoint?.toString() ?? null,
        seasonality: policy.seasonalityFactor.toString(),
      },
    });
    await evaluateStockAlert(tx, data.warehouseId, data.productId);
    return { id: policy.id, mode: policy.mode };
  });
}

export function canSeeReorder(actor: AuthUser): boolean {
  return can(actor, "inventory:ver");
}
