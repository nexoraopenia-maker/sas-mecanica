import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant, type TenantTx } from "@/lib/db";
import { periodSchema, type Period } from "@/lib/reports/period";
import { REPORT_IDS, type Report, type ReportId } from "@/lib/reports/table";
import { z } from "zod";
import { listReceivables } from "./receivables";

const D = (value: string | number | Prisma.Decimal | null | undefined): Prisma.Decimal =>
  new Prisma.Decimal(value ?? 0);
const money = (value: Prisma.Decimal): string => value.toDecimalPlaces(2).toFixed(2);
const pct = (num: Prisma.Decimal, den: Prisma.Decimal): string =>
  den.isZero() ? "0.0" : num.div(den).times(100).toDecimalPlaces(1).toFixed(1);
const DAY = 86_400_000;

function guard(actor: AuthUser): string {
  requirePermission(actor, "reports:ver");
  return requireTenantId(actor);
}

// ---------------------------------------------------------------------------
// Ventas por periodo
// ---------------------------------------------------------------------------

const salesInput = z.object({ groupBy: z.enum(["day", "month"]).default("day") });

/** Ventas completadas por día o mes (hora de Lima), menos devoluciones, y cobros por medio de pago. */
export async function salesReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
  options: z.input<typeof salesInput> = {},
): Promise<Report> {
  const tenantId = guard(actor);
  const period = periodSchema.parse(periodInput);
  const { groupBy } = salesInput.parse(options);
  // Valor de una lista cerrada (day|month), nunca de la entrada del usuario; va como literal SQL.
  const unit = Prisma.raw(groupBy === "day" ? "'day'" : "'month'");
  const format = Prisma.raw(groupBy === "day" ? "'YYYY-MM-DD'" : "'YYYY-MM'");
  return withTenant(tenantId, async (tx) => {
    const [sales, returns, methods] = await Promise.all([
      tx.$queryRaw<
        Array<{
          bucket: string;
          n: bigint;
          subtotal: string;
          tax: string;
          discount: string;
          total: string;
        }>
      >`
        SELECT to_char(date_trunc(${unit}, s."createdAt" AT TIME ZONE 'America/Lima'), ${format}) AS bucket,
               count(*) AS n, sum(s.subtotal)::text AS subtotal, sum(s."taxTotal")::text AS tax,
               sum(s."discountTotal")::text AS discount, sum(s.total)::text AS total
        FROM sales s
        WHERE s.status = 'COMPLETED' AND s."createdAt" >= ${period.start} AND s."createdAt" < ${period.endExclusive}
        GROUP BY 1 ORDER BY 1`,
      tx.$queryRaw<Array<{ bucket: string; total: string }>>`
        SELECT to_char(date_trunc(${unit}, r."createdAt" AT TIME ZONE 'America/Lima'), ${format}) AS bucket, sum(r.total)::text AS total
        FROM sale_returns r
        WHERE r."createdAt" >= ${period.start} AND r."createdAt" < ${period.endExclusive}
        GROUP BY 1`,
      tx.$queryRaw<Array<{ method: string; total: string }>>`
        SELECT p.method::text AS method, sum(p.amount)::text AS total
        FROM sale_payments p
        WHERE p."paidAt" >= ${period.start} AND p."paidAt" < ${period.endExclusive}
        GROUP BY 1 ORDER BY 2 DESC`,
    ]);
    const returned = new Map(returns.map((r) => [r.bucket, D(r.total)]));
    let totalSales = D(0);
    let totalTax = D(0);
    let totalReturns = D(0);
    let count = 0;
    const rows = sales.map((row) => {
      const ret = returned.get(row.bucket) ?? D(0);
      totalSales = totalSales.plus(row.total);
      totalTax = totalTax.plus(row.tax);
      totalReturns = totalReturns.plus(ret);
      count += Number(row.n);
      return {
        period: row.bucket,
        sales: Number(row.n),
        subtotal: money(D(row.subtotal)),
        tax: money(D(row.tax)),
        discount: money(D(row.discount)),
        returns: money(ret),
        net: money(D(row.total).minus(ret)),
      };
    });
    const net = totalSales.minus(totalReturns);
    return {
      id: "sales" as const,
      title: "Ventas por periodo",
      summary: [
        { label: "Ventas", value: String(count) },
        { label: "Total vendido", value: `S/ ${money(totalSales)}` },
        { label: "Devoluciones", value: `S/ ${money(totalReturns)}` },
        { label: "Venta neta", value: `S/ ${money(net)}` },
        { label: "IGV", value: `S/ ${money(totalTax)}` },
        {
          label: "Ticket promedio",
          value: count === 0 ? "S/ 0.00" : `S/ ${money(totalSales.div(count))}`,
        },
        ...methods.map((m) => ({
          label: `Cobrado: ${m.method}`,
          value: `S/ ${money(D(m.total))}`,
        })),
      ],
      columns: [
        { key: "period", label: groupBy === "day" ? "Día" : "Mes" },
        { key: "sales", label: "Ventas", kind: "number" as const },
        { key: "subtotal", label: "Subtotal", kind: "money" as const },
        { key: "tax", label: "IGV", kind: "money" as const },
        { key: "discount", label: "Descuentos", kind: "money" as const },
        { key: "returns", label: "Devoluciones", kind: "money" as const },
        { key: "net", label: "Venta neta", kind: "money" as const },
      ],
      rows,
      notes: [
        "Solo ventas completadas (las anuladas no cuentan). Las devoluciones se descuentan en el periodo en que ocurrieron.",
        "Los cobros por medio de pago incluyen cobranza de créditos y descuentan reembolsos.",
      ],
    };
  });
}

// ---------------------------------------------------------------------------
// Margen y más vendidos
// ---------------------------------------------------------------------------

interface LineAgg {
  productId: string | null;
  sku: string;
  name: string;
  qty: string;
  revenue: string;
  cost: string;
}

async function productLines(tx: TenantTx, period: Period): Promise<LineAgg[]> {
  return tx.$queryRaw<LineAgg[]>`
    WITH ret AS (
      SELECT sri."saleItemId" AS id, sum(sri.quantity) AS qty, sum(sri.amount) AS amount
      FROM sale_return_items sri GROUP BY 1)
    SELECT p.id AS "productId", COALESCE(p.sku, '—') AS sku, COALESCE(p.name, 'Servicios y mano de obra') AS name,
           sum(si.quantity - COALESCE(ret.qty, 0))::text AS qty,
           sum((si."lineTotal" - COALESCE(ret.amount, 0)) / (1 + si."taxRate"))::text AS revenue,
           sum(si."unitCost" * (si.quantity - COALESCE(ret.qty, 0)))::text AS cost
    FROM sale_items si
    JOIN sales s ON s.id = si."saleId" AND s."tenantId" = si."tenantId"
    LEFT JOIN products p ON p.id = si."productId" AND p."tenantId" = si."tenantId"
    LEFT JOIN ret ON ret.id = si.id
    WHERE s.status = 'COMPLETED' AND s."createdAt" >= ${period.start} AND s."createdAt" < ${period.endExclusive}
    GROUP BY p.id, p.sku, p.name`;
}

/** Margen por producto. Ingreso sin IGV y neto de devoluciones; costo = costo promedio al momento de la venta. */
export async function marginReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
): Promise<Report> {
  const tenantId = guard(actor);
  // Sin permiso de costos no hay margen que mostrar: se niega en vez de dar un reporte a medias.
  requirePermission(actor, "purchasing:ver_costos_compra");
  const period = periodSchema.parse(periodInput);
  const lines = await withTenant(tenantId, (tx) => productLines(tx, period));
  const enriched = lines.map((l) => {
    const revenue = D(l.revenue);
    const cost = D(l.cost);
    return { ...l, revenue, cost, margin: revenue.minus(cost) };
  });
  enriched.sort((a, b) => b.margin.comparedTo(a.margin));
  const totalRevenue = enriched.reduce((s, l) => s.plus(l.revenue), D(0));
  const totalCost = enriched.reduce((s, l) => s.plus(l.cost), D(0));
  return {
    id: "margin",
    title: "Margen y rentabilidad por producto",
    summary: [
      { label: "Ingresos (sin IGV)", value: `S/ ${money(totalRevenue)}` },
      { label: "Costo de ventas", value: `S/ ${money(totalCost)}` },
      { label: "Margen bruto", value: `S/ ${money(totalRevenue.minus(totalCost))}` },
      { label: "Margen %", value: `${pct(totalRevenue.minus(totalCost), totalRevenue)} %` },
    ],
    columns: [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Producto" },
      { key: "qty", label: "Cantidad", kind: "number" },
      { key: "revenue", label: "Ingreso", kind: "money" },
      { key: "cost", label: "Costo", kind: "money" },
      { key: "margin", label: "Margen", kind: "money" },
      { key: "marginPct", label: "Margen %", kind: "percent" },
    ],
    rows: enriched.map((l) => ({
      sku: l.sku,
      name: l.name,
      qty: Number(D(l.qty).toDecimalPlaces(2)),
      revenue: money(l.revenue),
      cost: money(l.cost),
      margin: money(l.margin),
      marginPct: pct(l.margin, l.revenue),
    })),
    notes: [
      "El costo es el promedio ponderado vigente al vender. Las líneas de mano de obra no llevan costo de material, por lo que muestran margen completo.",
      "Ingreso neto de devoluciones y sin IGV.",
    ],
  };
}

/** Productos más vendidos por cantidad (no expone costos). */
export async function topProductsReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
): Promise<Report> {
  const tenantId = guard(actor);
  const period = periodSchema.parse(periodInput);
  const lines = await withTenant(tenantId, (tx) => productLines(tx, period));
  const sorted = lines
    .filter((l) => l.productId !== null)
    .sort((a, b) => D(b.qty).comparedTo(D(a.qty)))
    .slice(0, 50);
  return {
    id: "top",
    title: "Productos más vendidos",
    summary: [
      {
        label: "Productos distintos vendidos",
        value: String(lines.filter((l) => l.productId !== null).length),
      },
    ],
    columns: [
      { key: "rank", label: "#", kind: "number" },
      { key: "sku", label: "SKU" },
      { key: "name", label: "Producto" },
      { key: "qty", label: "Cantidad", kind: "number" },
      { key: "revenue", label: "Ingreso (sin IGV)", kind: "money" },
    ],
    rows: sorted.map((l, index) => ({
      rank: index + 1,
      sku: l.sku,
      name: l.name,
      qty: Number(D(l.qty).toDecimalPlaces(2)),
      revenue: money(D(l.revenue)),
    })),
    notes: ["Los 50 productos con más unidades vendidas en el periodo, netas de devoluciones."],
  };
}

// ---------------------------------------------------------------------------
// Rotación y stock muerto
// ---------------------------------------------------------------------------

const CONSUMPTION = [
  "SALE",
  "WORK_ORDER_CONSUMPTION",
  "RETURN_CUSTOMER",
  "SALE_VOID",
  "WORK_ORDER_RETURN",
] as const;

interface StockPosition {
  productId: string;
  sku: string;
  name: string;
  stock: Prisma.Decimal;
  avgCost: Prisma.Decimal;
  used30: Prisma.Decimal;
  used90: Prisma.Decimal;
  lastUse: Date | null;
  createdAt: Date;
}

async function stockPositions(tx: TenantTx, now: Date): Promise<StockPosition[]> {
  const since30 = new Date(now.getTime() - 30 * DAY);
  const since90 = new Date(now.getTime() - 90 * DAY);
  const [balances, used30, used90, lastUse] = await Promise.all([
    tx.stockBalance.findMany({
      where: { quantity: { gt: 0 } },
      select: {
        productId: true,
        quantity: true,
        avgCost: true,
        product: {
          select: { sku: true, name: true, createdAt: true, isStocked: true, isActive: true },
        },
      },
    }),
    tx.kardexMovement.groupBy({
      by: ["productId"],
      where: { type: { in: [...CONSUMPTION] }, occurredAt: { gte: since30 } },
      _sum: { quantityDelta: true },
    }),
    tx.kardexMovement.groupBy({
      by: ["productId"],
      where: { type: { in: [...CONSUMPTION] }, occurredAt: { gte: since90 } },
      _sum: { quantityDelta: true },
    }),
    tx.kardexMovement.groupBy({
      by: ["productId"],
      where: { type: { in: ["SALE", "WORK_ORDER_CONSUMPTION"] } },
      _max: { occurredAt: true },
    }),
  ]);
  // Consumo neto: salidas (negativas) más devoluciones (positivas), en positivo.
  const net = (rows: typeof used30) =>
    new Map(rows.map((r) => [r.productId, D(r._sum.quantityDelta).negated()]));
  const n30 = net(used30);
  const n90 = net(used90);
  const last = new Map(lastUse.map((r) => [r.productId, r._max.occurredAt]));
  const byProduct = new Map<string, StockPosition>();
  for (const b of balances) {
    if (!b.product.isStocked || !b.product.isActive) continue;
    const existing = byProduct.get(b.productId);
    const value = D(b.quantity).times(b.avgCost);
    if (existing) {
      const stock = existing.stock.plus(b.quantity);
      byProduct.set(b.productId, {
        ...existing,
        stock,
        avgCost: existing.avgCost.times(existing.stock).plus(value).div(stock),
      });
    } else {
      byProduct.set(b.productId, {
        productId: b.productId,
        sku: b.product.sku,
        name: b.product.name,
        stock: D(b.quantity),
        avgCost: D(b.avgCost),
        used30: n30.get(b.productId) ?? D(0),
        used90: n90.get(b.productId) ?? D(0),
        lastUse: last.get(b.productId) ?? null,
        createdAt: b.product.createdAt,
      });
    }
  }
  return [...byProduct.values()];
}

/** Rotación: cuánto se consumió en 30 y 90 días frente al stock, y para cuántos días alcanza. */
export async function rotationReport(actor: AuthUser, now: Date = new Date()): Promise<Report> {
  const tenantId = guard(actor);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const positions = await withTenant(tenantId, (tx) => stockPositions(tx, now));
  const rows = positions
    .map((p) => {
      const daily = p.used90.div(90);
      return { p, daily, cover: daily.gt(0) ? p.stock.div(daily) : null };
    })
    .sort((a, b) => b.p.used90.comparedTo(a.p.used90));
  return {
    id: "rotation",
    title: "Rotación de inventario",
    summary: [
      { label: "Productos con stock", value: String(positions.length) },
      {
        label: "Sin consumo en 90 días",
        value: String(positions.filter((p) => p.used90.lte(0)).length),
      },
      ...(canSeeCost
        ? [
            {
              label: "Valor del inventario",
              value: `S/ ${money(positions.reduce((s, p) => s.plus(p.stock.times(p.avgCost)), D(0)))}`,
            },
          ]
        : []),
    ],
    columns: [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Producto" },
      { key: "stock", label: "Stock", kind: "number" },
      { key: "used30", label: "Consumo 30 d", kind: "number" },
      { key: "used90", label: "Consumo 90 d", kind: "number" },
      { key: "turnover", label: "Rotación (90 d)", kind: "number" },
      { key: "cover", label: "Días de cobertura", kind: "number" },
      ...(canSeeCost ? [{ key: "value", label: "Valor del stock", kind: "money" as const }] : []),
    ],
    rows: rows.map(({ p, cover }) => ({
      sku: p.sku,
      name: p.name,
      stock: Number(p.stock.toDecimalPlaces(2)),
      used30: Number(p.used30.toDecimalPlaces(2)),
      used90: Number(p.used90.toDecimalPlaces(2)),
      turnover: p.stock.gt(0) ? Number(p.used90.div(p.stock).toDecimalPlaces(2)) : 0,
      cover: cover === null ? null : Math.round(Number(cover)),
      ...(canSeeCost ? { value: money(p.stock.times(p.avgCost)) } : {}),
    })),
    notes: [
      "Consumo = ventas y consumo en OT, netos de devoluciones. Rotación = consumo de 90 días ÷ stock actual. Sin consumo, los días de cobertura quedan vacíos.",
    ],
  };
}

/** Stock muerto: hay existencias pero no se consume desde hace N días (configurable por empresa). */
export async function deadStockReport(actor: AuthUser, now: Date = new Date()): Promise<Report> {
  const tenantId = guard(actor);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const { positions, days } = await withTenant(tenantId, async (tx) => ({
    positions: await stockPositions(tx, now),
    days: (await tx.tenantSettings.findFirstOrThrow({ select: { deadStockDays: true } }))
      .deadStockDays,
  }));
  const limit = now.getTime() - days * DAY;
  // Un producto recién creado no es «muerto»: aún no tuvo oportunidad de venderse.
  const dead = positions
    .filter(
      (p) => p.createdAt.getTime() < limit && (p.lastUse === null || p.lastUse.getTime() < limit),
    )
    .sort((a, b) => b.stock.times(b.avgCost).comparedTo(a.stock.times(a.avgCost)));
  const totalValue = dead.reduce((s, p) => s.plus(p.stock.times(p.avgCost)), D(0));
  return {
    id: "dead",
    title: `Stock muerto (sin consumo en ${days} días)`,
    summary: [
      { label: "Productos", value: String(dead.length) },
      ...(canSeeCost ? [{ label: "Capital inmovilizado", value: `S/ ${money(totalValue)}` }] : []),
    ],
    columns: [
      { key: "sku", label: "SKU" },
      { key: "name", label: "Producto" },
      { key: "stock", label: "Stock", kind: "number" },
      { key: "lastUse", label: "Último consumo" },
      ...(canSeeCost ? [{ key: "value", label: "Valor", kind: "money" as const }] : []),
    ],
    rows: dead.map((p) => ({
      sku: p.sku,
      name: p.name,
      stock: Number(p.stock.toDecimalPlaces(2)),
      lastUse: p.lastUse ? p.lastUse.toISOString().slice(0, 10) : "Nunca",
      ...(canSeeCost ? { value: money(p.stock.times(p.avgCost)) } : {}),
    })),
    notes: [
      `Umbral configurable en Configuración (hoy ${days} días). Se excluyen productos creados dentro del umbral.`,
    ],
  };
}

// ---------------------------------------------------------------------------
// Mecánicos
// ---------------------------------------------------------------------------

/** Rendimiento por mecánico: OT entregadas, tiempos, puntualidad y mano de obra facturada. */
export async function mechanicsReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
): Promise<Report> {
  const tenantId = guard(actor);
  const period = periodSchema.parse(periodInput);
  const orders = await withTenant(tenantId, (tx) =>
    tx.workOrder.findMany({
      where: {
        status: "DELIVERED",
        deliveredAt: { gte: period.start, lt: period.endExclusive },
        assignedMechanicId: { not: null },
      },
      select: {
        assignedMechanicId: true,
        receivedAt: true,
        deliveredAt: true,
        promisedAt: true,
        assignedMechanic: { select: { name: true } },
        items: {
          where: { type: "LABOR", approvalStatus: "APPROVED" },
          select: { quantity: true, unitPrice: true, discount: true },
        },
        statusHistory: {
          where: { toStatus: { in: ["IN_REPAIR", "READY"] } },
          select: { toStatus: true, changedAt: true },
          orderBy: { changedAt: "asc" },
        },
      },
      take: 5000,
    }),
  );
  interface Acc {
    name: string;
    orders: number;
    cycleMs: number;
    repairMs: number;
    repairN: number;
    promised: number;
    onTime: number;
    labor: Prisma.Decimal;
  }
  const byMechanic = new Map<string, Acc>();
  for (const o of orders) {
    if (!o.assignedMechanicId || !o.deliveredAt) continue;
    const acc = byMechanic.get(o.assignedMechanicId) ?? {
      name: o.assignedMechanic?.name ?? "—",
      orders: 0,
      cycleMs: 0,
      repairMs: 0,
      repairN: 0,
      promised: 0,
      onTime: 0,
      labor: D(0),
    };
    acc.orders += 1;
    acc.cycleMs += o.deliveredAt.getTime() - o.receivedAt.getTime();
    const start = o.statusHistory.find((h) => h.toStatus === "IN_REPAIR");
    const end = [...o.statusHistory].reverse().find((h) => h.toStatus === "READY");
    if (start && end && end.changedAt > start.changedAt) {
      acc.repairMs += end.changedAt.getTime() - start.changedAt.getTime();
      acc.repairN += 1;
    }
    if (o.promisedAt) {
      acc.promised += 1;
      if (o.deliveredAt <= o.promisedAt) acc.onTime += 1;
    }
    acc.labor = o.items.reduce(
      (s, i) => s.plus(D(i.quantity).times(i.unitPrice).minus(i.discount)),
      acc.labor,
    );
    byMechanic.set(o.assignedMechanicId, acc);
  }
  const hours = (ms: number, n: number) =>
    n === 0 ? null : Number((ms / n / 3_600_000).toFixed(1));
  const rows = [...byMechanic.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((a) => ({
      mechanic: a.name,
      orders: a.orders,
      cycleHours: hours(a.cycleMs, a.orders),
      repairHours: hours(a.repairMs, a.repairN),
      onTime: a.promised === 0 ? null : Number(((a.onTime / a.promised) * 100).toFixed(1)),
      labor: money(a.labor),
    }));
  return {
    id: "mechanics",
    title: "Rendimiento de mecánicos",
    summary: [
      { label: "OT entregadas", value: String(rows.reduce((s, r) => s + r.orders, 0)) },
      {
        label: "Mano de obra",
        value: `S/ ${money([...byMechanic.values()].reduce((s, a) => s.plus(a.labor), D(0)))}`,
      },
    ],
    columns: [
      { key: "mechanic", label: "Mecánico" },
      { key: "orders", label: "OT entregadas", kind: "number" },
      { key: "cycleHours", label: "Ciclo total (h)", kind: "number" },
      { key: "repairHours", label: "En reparación (h)", kind: "number" },
      { key: "onTime", label: "A tiempo %", kind: "percent" },
      { key: "labor", label: "Mano de obra (sin IGV)", kind: "money" },
    ],
    rows,
    notes: [
      "Ciclo total = recepción → entrega. En reparación = primera vez «En reparación» → última «Lista». A tiempo = entregadas hasta la fecha prometida (solo OT con promesa).",
      "Mano de obra aprobada por el cliente, antes de IGV.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Agente IA: ahorro estimado vs costo de tokens
// ---------------------------------------------------------------------------

export interface AiMetrics {
  runs: number;
  tokens: number;
  costUsd: string;
  costLocal: string;
  draftsApproved: number;
  draftsRejected: number;
  draftsPending: number;
  ordersCreated: number;
  linesOrdered: number;
  orderedValue: string;
  savedHours: string;
  savingsLocal: string;
  netLocal: string;
  assumptions: { minutesPerLine: number; hourlyCost: string; usdRate: string };
}

export async function computeAiMetrics(tx: TenantTx, period: Period): Promise<AiMetrics> {
  const settings = await tx.tenantSettings.findFirstOrThrow({
    select: { aiMinutesSavedPerLine: true, staffHourlyCost: true, usdExchangeRate: true },
  });
  const inPeriod = { gte: period.start, lt: period.endExclusive };
  const [runs, drafts, orders] = await Promise.all([
    tx.aiRun.aggregate({
      where: { startedAt: inPeriod, simulated: false },
      _count: true,
      _sum: { promptTokens: true, completionTokens: true, costUsd: true },
    }),
    tx.aiOrderDraft.groupBy({ by: ["status"], where: { createdAt: inPeriod }, _count: true }),
    tx.purchaseOrder.findMany({
      where: { origin: "AI", createdAt: inPeriod, status: { not: "CANCELLED" } },
      select: { total: true, _count: { select: { items: true } } },
    }),
  ]);
  const count = (status: string) => drafts.find((d) => d.status === status)?._count ?? 0;
  const lines = orders.reduce((s, o) => s + o._count.items, 0);
  const costUsd = D(runs._sum.costUsd);
  const costLocal = costUsd.times(settings.usdExchangeRate);
  const savedHours = D(lines).times(settings.aiMinutesSavedPerLine).div(60);
  const savings = savedHours.times(settings.staffHourlyCost);
  return {
    runs: runs._count,
    tokens: (runs._sum.promptTokens ?? 0) + (runs._sum.completionTokens ?? 0),
    costUsd: costUsd.toDecimalPlaces(4).toFixed(4),
    costLocal: money(costLocal),
    draftsApproved: count("APPROVED") + count("SENT"),
    draftsRejected: count("REJECTED"),
    draftsPending: count("PENDING"),
    ordersCreated: orders.length,
    linesOrdered: lines,
    orderedValue: money(orders.reduce((s, o) => s.plus(o.total), D(0))),
    savedHours: savedHours.toDecimalPlaces(1).toFixed(1),
    savingsLocal: money(savings),
    netLocal: money(savings.minus(costLocal)),
    assumptions: {
      minutesPerLine: settings.aiMinutesSavedPerLine,
      hourlyCost: money(D(settings.staffHourlyCost)),
      usdRate: D(settings.usdExchangeRate).toFixed(4),
    },
  };
}

export async function aiReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
): Promise<Report> {
  requirePermission(actor, "ai_agent:ver");
  const tenantId = guard(actor);
  const period = periodSchema.parse(periodInput);
  const m = await withTenant(tenantId, (tx) => computeAiMetrics(tx, period));
  const row = (metric: string, value: string, note = "") => ({ metric, value, note });
  return {
    id: "ai",
    title: "Agente IA de compras: ahorro estimado vs costo",
    summary: [
      { label: "Ahorro estimado", value: `S/ ${m.savingsLocal}` },
      { label: "Costo de tokens", value: `S/ ${m.costLocal}` },
      { label: "Beneficio neto", value: `S/ ${m.netLocal}` },
    ],
    columns: [
      { key: "metric", label: "Métrica" },
      { key: "value", label: "Valor" },
      { key: "note", label: "Cómo se calcula" },
    ],
    rows: [
      row(
        "Corridas del agente",
        String(m.runs),
        "Solo corridas reales (las simuladas de la demo no cuentan)",
      ),
      row("Tokens consumidos", String(m.tokens)),
      row("Costo (USD)", m.costUsd, "Según las tarifas de lib/ai/pricing.ts"),
      row("Costo (S/)", m.costLocal, `USD × ${m.assumptions.usdRate}`),
      row("Borradores aprobados", String(m.draftsApproved)),
      row("Borradores rechazados", String(m.draftsRejected)),
      row("Borradores pendientes", String(m.draftsPending)),
      row("Órdenes de compra creadas por la IA", String(m.ordersCreated)),
      row("Líneas de pedido generadas", String(m.linesOrdered)),
      row("Valor pedido (S/)", m.orderedValue),
      row(
        "Horas de trabajo ahorradas",
        m.savedHours,
        `Líneas × ${m.assumptions.minutesPerLine} min ÷ 60`,
      ),
      row(
        "Ahorro estimado (S/)",
        m.savingsLocal,
        `Horas × S/ ${m.assumptions.hourlyCost} por hora`,
      ),
      row("Beneficio neto (S/)", m.netLocal, "Ahorro − costo de tokens"),
    ],
    notes: [
      "El ahorro es una ESTIMACIÓN: depende de los supuestos (minutos por línea, costo por hora, tipo de cambio) que se editan en Configuración.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Proveedores
// ---------------------------------------------------------------------------

/** Desempeño de proveedores: puntualidad, plazo real, cumplimiento de lo pedido y gasto. */
export async function suppliersReport(
  actor: AuthUser,
  periodInput: { from: string; to: string },
): Promise<Report> {
  const tenantId = guard(actor);
  requirePermission(actor, "purchasing:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const period = periodSchema.parse(periodInput);
  const orders = await withTenant(tenantId, (tx) =>
    tx.purchaseOrder.findMany({
      where: {
        createdAt: { gte: period.start, lt: period.endExclusive },
        status: { in: ["REQUESTED", "QUOTED", "IN_TRANSIT", "PARTIALLY_RECEIVED", "RECEIVED"] },
      },
      select: {
        supplierId: true,
        expectedAt: true,
        sentAt: true,
        receivedAt: true,
        status: true,
        supplier: { select: { name: true } },
        items: { select: { qtyOrdered: true, qtyReceived: true, unitCost: true } },
      },
      take: 5000,
    }),
  );
  interface Acc {
    name: string;
    orders: number;
    received: number;
    dated: number;
    onTime: number;
    leadMs: number;
    leadN: number;
    ordered: Prisma.Decimal;
    got: Prisma.Decimal;
    spend: Prisma.Decimal;
  }
  const bySupplier = new Map<string, Acc>();
  for (const o of orders) {
    const acc = bySupplier.get(o.supplierId) ?? {
      name: o.supplier.name,
      orders: 0,
      received: 0,
      dated: 0,
      onTime: 0,
      leadMs: 0,
      leadN: 0,
      ordered: D(0),
      got: D(0),
      spend: D(0),
    };
    acc.orders += 1;
    if (o.receivedAt) {
      acc.received += 1;
      if (o.expectedAt) {
        acc.dated += 1;
        if (o.receivedAt <= o.expectedAt) acc.onTime += 1;
      }
      if (o.sentAt) {
        acc.leadMs += o.receivedAt.getTime() - o.sentAt.getTime();
        acc.leadN += 1;
      }
    }
    for (const i of o.items) {
      acc.ordered = acc.ordered.plus(i.qtyOrdered);
      acc.got = acc.got.plus(i.qtyReceived);
      acc.spend = acc.spend.plus(D(i.qtyReceived).times(i.unitCost));
    }
    bySupplier.set(o.supplierId, acc);
  }
  const rows = [...bySupplier.values()]
    .sort((a, b) => b.orders - a.orders)
    .map((a) => ({
      supplier: a.name,
      orders: a.orders,
      received: a.received,
      onTime: a.dated === 0 ? null : Number(((a.onTime / a.dated) * 100).toFixed(1)),
      leadDays: a.leadN === 0 ? null : Number((a.leadMs / a.leadN / 86_400_000).toFixed(1)),
      fillRate: a.ordered.isZero() ? null : Number(pct(a.got, a.ordered)),
      ...(canSeeCost ? { spend: money(a.spend) } : {}),
    }));
  return {
    id: "suppliers",
    title: "Desempeño de proveedores",
    summary: [
      { label: "Proveedores con pedidos", value: String(rows.length) },
      { label: "Órdenes", value: String(orders.length) },
    ],
    columns: [
      { key: "supplier", label: "Proveedor" },
      { key: "orders", label: "Órdenes", kind: "number" },
      { key: "received", label: "Recibidas", kind: "number" },
      { key: "onTime", label: "Puntualidad %", kind: "percent" },
      { key: "leadDays", label: "Plazo real (días)", kind: "number" },
      { key: "fillRate", label: "Cumplimiento %", kind: "percent" },
      ...(canSeeCost ? [{ key: "spend", label: "Recibido (S/)", kind: "money" as const }] : []),
    ],
    rows,
    notes: [
      "Puntualidad = recibidas hasta la fecha esperada (solo órdenes con fecha esperada). Plazo real = envío → recepción. Cumplimiento = cantidad recibida ÷ pedida.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Cuentas por cobrar
// ---------------------------------------------------------------------------

export async function receivablesReport(actor: AuthUser, now: Date = new Date()): Promise<Report> {
  guard(actor);
  const data = await listReceivables(actor, {}, now);
  return {
    id: "receivables",
    title: "Cuentas por cobrar y antigüedad de saldos",
    summary: [
      { label: "Total por cobrar", value: `S/ ${data.totalOutstanding}` },
      { label: "Al día", value: `S/ ${data.aging.CURRENT}` },
      { label: "1–30 días", value: `S/ ${data.aging.D1_30}` },
      { label: "31–60 días", value: `S/ ${data.aging.D31_60}` },
      { label: "61–90 días", value: `S/ ${data.aging.D61_90}` },
      { label: "Más de 90 días", value: `S/ ${data.aging.D90_PLUS}` },
    ],
    columns: [
      { key: "customer", label: "Cliente" },
      { key: "sale", label: "Venta", kind: "number" },
      { key: "total", label: "Total", kind: "money" },
      { key: "balance", label: "Saldo", kind: "money" },
      { key: "dueDate", label: "Vence" },
      { key: "daysOverdue", label: "Días de atraso", kind: "number" },
    ],
    rows: data.items.map((r) => ({
      customer: r.customer,
      sale: r.saleNumber,
      total: r.total,
      balance: r.balance,
      dueDate: r.dueDate.toISOString().slice(0, 10),
      daysOverdue: r.daysOverdue,
    })),
    notes: ["Saldos abiertos al día de hoy; no depende del periodo."],
  };
}

// ---------------------------------------------------------------------------
// Despachador
// ---------------------------------------------------------------------------

const periodless = new Set<ReportId>(["rotation", "dead", "receivables"]);

export function reportNeedsPeriod(id: ReportId): boolean {
  return !periodless.has(id);
}

/** Qué reportes puede ver este usuario (permiso del reporte, no solo `reports:ver`). */
export function availableReports(actor: AuthUser): Array<{ id: ReportId; label: string }> {
  if (!can(actor, "reports:ver")) return [];
  const all: Array<{ id: ReportId; label: string; allowed: boolean }> = [
    { id: "sales", label: "Ventas por periodo", allowed: true },
    {
      id: "margin",
      label: "Margen por producto",
      allowed: can(actor, "purchasing:ver_costos_compra"),
    },
    { id: "top", label: "Más vendidos", allowed: true },
    { id: "rotation", label: "Rotación de inventario", allowed: true },
    { id: "dead", label: "Stock muerto", allowed: true },
    { id: "mechanics", label: "Rendimiento de mecánicos", allowed: true },
    { id: "ai", label: "Agente IA: ahorro vs costo", allowed: can(actor, "ai_agent:ver") },
    { id: "suppliers", label: "Desempeño de proveedores", allowed: can(actor, "purchasing:ver") },
    { id: "receivables", label: "Cuentas por cobrar", allowed: can(actor, "pos:ver") },
  ];
  return all.filter((r) => r.allowed).map(({ id, label }) => ({ id, label }));
}

export async function runReport(
  actor: AuthUser,
  id: string,
  period: { from: string; to: string },
  now: Date = new Date(),
  groupBy: "day" | "month" = "day",
): Promise<Report> {
  const reportId = z.enum(REPORT_IDS).parse(id);
  switch (reportId) {
    case "sales":
      return salesReport(actor, period, { groupBy });
    case "margin":
      return marginReport(actor, period);
    case "top":
      return topProductsReport(actor, period);
    case "rotation":
      return rotationReport(actor, now);
    case "dead":
      return deadStockReport(actor, now);
    case "mechanics":
      return mechanicsReport(actor, period);
    case "ai":
      return aiReport(actor, period);
    case "suppliers":
      return suppliersReport(actor, period);
    case "receivables":
      return receivablesReport(actor, now);
  }
}
