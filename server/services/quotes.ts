import { z } from "zod";
import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { nextSequence, Prisma, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import type { Affectation } from "@/lib/pos/totals";
import { paymentSchema, quoteSchema, type QuoteInput } from "@/lib/validation/sales";
import { idempotencyKeySchema } from "@/lib/validation/inventory";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { taxContextOf } from "./billing";
import { changeStatus, recalcTotals } from "./work-orders";
import { createSaleCore, priceLines, runSale, type PreparedLine, type SaleResult } from "./sales";

const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

// ---------------------------------------------------------------------------
// Alta y consulta
// ---------------------------------------------------------------------------

/** Cotización con precios del catálogo (o libres en servicios), descuentos limitados por rol y vigencia. */
export async function createQuote(actor: AuthUser, input: QuoteInput, meta: RequestMeta = {}) {
  requirePermission(actor, "pos:crear");
  const data = quoteSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    if (
      data.customerId &&
      !(await tx.customer.findFirst({ where: { id: data.customerId }, select: { id: true } }))
    )
      throw new NotFoundError("Cliente");
    if (
      data.vehicleId &&
      !(await tx.vehicle.findFirst({ where: { id: data.vehicleId }, select: { id: true } }))
    )
      throw new NotFoundError("Vehículo");
    const ids = [...new Set(data.items.flatMap((i) => (i.productId ? [i.productId] : [])))];
    const products = new Map(
      (await tx.product.findMany({ where: { id: { in: ids }, isActive: true } })).map((p) => [
        p.id,
        p,
      ]),
    );
    const lines: PreparedLine[] = data.items.map((item) => {
      const product = item.productId ? products.get(item.productId) : null;
      if (item.productId && !product) throw new NotFoundError("Producto");
      return {
        product: product ?? null,
        description: item.description?.trim() || product?.name || "",
        quantity: item.quantity,
        unitPrice: product ? product.salePrice.toString() : (item.unitPrice ?? "0"),
        discount: item.discount,
        affectation: (product?.taxAffectation ?? "TAXED") as Affectation,
        stocked: product?.isStocked ?? false,
      };
    });
    const ctx = await taxContextOf(tx);
    const priced = priceLines(actor, lines, ctx);
    const number = await nextSequence(tx, "QUOTE");
    const quote = await tx.quote.create({
      data: {
        number,
        customerId: data.customerId ?? null,
        vehicleId: data.vehicleId ?? null,
        validUntil: new Date(Date.now() + data.validDays * 86_400_000),
        subtotal: priced.totals.subtotal,
        taxTotal: priced.totals.tax,
        total: priced.totals.total,
        notes: data.notes ?? null,
        createdById: actor.userId,
        items: {
          create: lines.map((line, index) => ({
            productId: line.product?.id ?? null,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discount: line.discount,
            taxAffectation: line.affectation,
            isLabor: data.items[index]?.isLabor ?? !line.stocked,
          })),
        },
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "quote.created",
      entityType: "quote",
      entityId: quote.id,
      after: { number, total: priced.totals.total },
    });
    return { id: quote.id, number, total: priced.totals.total };
  });
}

/** Una cotización vencida deja de ser convertible aunque nadie haya corrido el job. */
function effectiveStatus(quote: { status: string; validUntil: Date | null }, now: Date): string {
  return ["DRAFT", "SENT", "ACCEPTED"].includes(quote.status) &&
    quote.validUntil &&
    quote.validUntil < now
    ? "EXPIRED"
    : quote.status;
}

export async function listQuotes(actor: AuthUser, limit = 100, now: Date = new Date()) {
  requirePermission(actor, "pos:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.quote.findMany({
      include: { customer: { select: { name: true } }, vehicle: { select: { plate: true } } },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((q) => ({
      id: q.id,
      number: q.number,
      status: effectiveStatus(q, now),
      customer: q.customer?.name ?? null,
      plate: q.vehicle?.plate ?? null,
      total: q.total.toFixed(2),
      validUntil: q.validUntil,
      createdAt: q.createdAt,
    }));
  });
}

export async function getQuote(actor: AuthUser, quoteId: string, now: Date = new Date()) {
  requirePermission(actor, "pos:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const quote = await tx.quote.findFirst({
      where: { id: quoteId },
      include: {
        customer: { select: { id: true, name: true } },
        vehicle: { select: { id: true, plate: true } },
        items: { include: { product: { select: { sku: true, trackingMode: true } } } },
        sales: { select: { id: true, number: true } },
        workOrders: { select: { id: true, number: true } },
      },
    });
    if (!quote) throw new NotFoundError("Cotización");
    return {
      id: quote.id,
      number: quote.number,
      status: effectiveStatus(quote, now),
      customer: quote.customer,
      vehicle: quote.vehicle,
      notes: quote.notes,
      validUntil: quote.validUntil,
      subtotal: quote.subtotal.toFixed(2),
      taxTotal: quote.taxTotal.toFixed(2),
      total: quote.total.toFixed(2),
      items: quote.items.map((i) => ({
        id: i.id,
        description: i.description,
        sku: i.product?.sku ?? null,
        trackingMode: i.product?.trackingMode ?? "NONE",
        quantity: i.quantity.toString(),
        unitPrice: i.unitPrice.toString(),
        discount: i.discount.toFixed(2),
        isLabor: i.isLabor,
      })),
      sales: quote.sales,
      workOrders: quote.workOrders,
    };
  });
}

const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["SENT", "ACCEPTED", "REJECTED"],
  SENT: ["ACCEPTED", "REJECTED"],
  ACCEPTED: ["REJECTED"],
};

export async function setQuoteStatus(
  actor: AuthUser,
  quoteId: string,
  status: "SENT" | "ACCEPTED" | "REJECTED",
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "pos:crear");
  await withTenant(requireTenantId(actor), async (tx) => {
    const quote = await tx.quote.findFirst({ where: { id: quoteId } });
    if (!quote) throw new NotFoundError("Cotización");
    if (effectiveStatus(quote, new Date()) === "EXPIRED")
      throw new ConflictError("QUOTE_EXPIRED", "La cotización venció");
    if (!TRANSITIONS[quote.status]?.includes(status))
      throw new ConflictError("QUOTE_STATE", "Ese cambio de estado no es válido");
    await tx.quote.update({ where: { id: quoteId }, data: { status } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "quote.status",
      entityType: "quote",
      entityId: quoteId,
      before: { status: quote.status },
      after: { status },
    });
  });
}

/** Marca como vencidas las cotizaciones pasadas de fecha (job diario). */
export async function expireQuotes(tx: TenantTx, now: Date = new Date()): Promise<number> {
  const result = await tx.quote.updateMany({
    where: { status: { in: ["DRAFT", "SENT", "ACCEPTED"] }, validUntil: { lt: now } },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

async function lockConvertible(tx: TenantTx, quoteId: string) {
  await tx.$queryRaw`SELECT id FROM quotes WHERE id = ${quoteId}::uuid FOR UPDATE`;
  const quote = await tx.quote.findFirst({
    where: { id: quoteId },
    include: { items: { include: { product: true } }, customer: true },
  });
  if (!quote) throw new NotFoundError("Cotización");
  if (quote.status === "CONVERTED")
    throw new ConflictError("QUOTE_CONVERTED", "La cotización ya fue convertida");
  if (quote.status === "REJECTED")
    throw new ConflictError("QUOTE_STATE", "La cotización fue rechazada");
  if (effectiveStatus(quote, new Date()) === "EXPIRED")
    throw new ConflictError("QUOTE_EXPIRED", "La cotización venció");
  return quote;
}

// ---------------------------------------------------------------------------
// Cotización → venta
// ---------------------------------------------------------------------------

const quoteSaleSchema = z.object({
  quoteId: z.uuid(),
  idempotencyKey: idempotencyKeySchema,
  documentType: z.enum(["BOLETA", "FACTURA", "NOTA_VENTA"]).default("BOLETA"),
  payments: z.array(paymentSchema).max(6).default([]),
  isCredit: z.boolean().default(false),
  creditDays: z.coerce.number().int().min(1).max(365).optional(),
  /** Series/lotes por línea de la cotización (llantas y baterías se venden con su serie). */
  lines: z
    .array(
      z.object({
        quoteItemId: z.uuid(),
        serials: z.array(z.string().trim().min(3)).optional(),
        lotId: z.uuid().optional(),
      }),
    )
    .default([]),
});
export type QuoteSaleInput = z.input<typeof quoteSaleSchema>;

/** Convierte con un clic: respeta los precios y descuentos cotizados y descarga el stock por el kardex. */
export async function convertQuoteToSale(
  actor: AuthUser,
  input: QuoteSaleInput,
  meta: RequestMeta = {},
): Promise<SaleResult> {
  requirePermission(actor, "pos:crear");
  const data = quoteSaleSchema.parse(input);
  return runSale(requireTenantId(actor), data.idempotencyKey, async (tx) => {
    const replay = await tx.sale.findFirst({
      where: { idempotencyKey: data.idempotencyKey },
      select: { quoteId: true },
    });
    const quote = replay ? null : await lockConvertible(tx, data.quoteId);
    const source =
      quote ??
      (await tx.quote.findFirstOrThrow({
        where: { id: data.quoteId },
        include: { items: { include: { product: true } }, customer: true },
      }));
    const overrides = new Map(data.lines.map((l) => [l.quoteItemId, l]));
    const lines: PreparedLine[] = source.items.map((item) => {
      const product = item.product;
      const override = overrides.get(item.id);
      if (
        product?.trackingMode === "SERIAL" &&
        (override?.serials?.length ?? 0) !== Number(item.quantity)
      ) {
        throw new ConflictError(
          "SERIAL_REQUIRED",
          `«${item.description}» se vende por serie: indica ${item.quantity} serie(s)`,
        );
      }
      return {
        product,
        description: item.description,
        quantity: item.quantity.toString(),
        unitPrice: item.unitPrice.toString(),
        discount: item.discount.toString(),
        affectation: item.taxAffectation as Affectation,
        stocked: product?.isStocked ?? false,
        serials: override?.serials,
        lotId: override?.lotId,
      };
    });
    const result = await createSaleCore(
      tx,
      actor,
      {
        idempotencyKey: data.idempotencyKey,
        documentType: data.documentType,
        customerId: source.customerId ?? undefined,
        vehicleId: source.vehicleId ?? undefined,
        payments: data.payments,
        isCredit: data.isCredit,
        creditDays: data.creditDays,
      },
      lines,
      { quoteId: source.id, honorPrices: true, meta },
    );
    if (!result.replayed) {
      await tx.quote.update({ where: { id: source.id }, data: { status: "CONVERTED" } });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "quote.converted_to_sale",
        entityType: "quote",
        entityId: source.id,
        after: { saleId: result.id, saleNumber: result.number },
      });
    }
    return result;
  });
}

// ---------------------------------------------------------------------------
// Cotización → orden de trabajo
// ---------------------------------------------------------------------------

const quoteWorkOrderSchema = z.object({
  quoteId: z.uuid(),
  mileageIn: z.coerce.number().int().min(0).max(3_000_000),
  fuelLevelEighths: z.coerce.number().int().min(0).max(8).default(4),
  complaint: z.string().trim().max(1000).optional(),
});
export type QuoteWorkOrderInput = z.input<typeof quoteWorkOrderSchema>;

/**
 * Abre la OT con los ítems de la cotización ya APROBADOS por el cliente (la cotización aceptada es
 * su aprobación), así que el taller puede empezar de inmediato. Los repuestos quedan por entregar.
 */
export async function convertQuoteToWorkOrder(
  actor: AuthUser,
  input: QuoteWorkOrderInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "pos:ver");
  requirePermission(actor, "workshop:crear");
  const data = quoteWorkOrderSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const quote = await lockConvertible(tx, data.quoteId);
    if (!quote.vehicleId || !quote.customerId)
      throw new ConflictError(
        "QUOTE_NO_VEHICLE",
        "Para abrir una OT la cotización debe tener cliente y vehículo",
      );
    const vehicle = await tx.vehicle.findFirstOrThrow({ where: { id: quote.vehicleId } });
    if (
      await tx.workOrder.findFirst({
        where: { vehicleId: vehicle.id, status: { notIn: ["DELIVERED", "CANCELLED"] } },
        select: { id: true },
      })
    ) {
      throw new ConflictError(
        "VEHICLE_OPEN_ORDER",
        `El vehículo ${vehicle.plate} ya tiene una orden de trabajo abierta`,
      );
    }
    const branch =
      (await tx.branch.findFirst({ where: { isMain: true } })) ??
      (await tx.branch.findFirst({ orderBy: { createdAt: "asc" } }));
    if (!branch) throw new NotFoundError("Sucursal");
    const ctx = await taxContextOf(tx);
    const rate = D(ctx.taxRate);
    const number = await nextSequence(tx, "WO");
    const now = new Date();
    const order = await tx.workOrder.create({
      data: {
        number,
        branchId: branch.id,
        customerId: quote.customerId,
        vehicleId: vehicle.id,
        quoteId: quote.id,
        mileageIn: data.mileageIn,
        fuelLevelEighths: data.fuelLevelEighths,
        complaint: data.complaint?.trim() || `Según cotización N.º ${quote.number}`,
        createdById: actor.userId,
        statusHistory: {
          create: {
            toStatus: "RECEIVED",
            changedById: actor.userId,
            note: `Creada desde la cotización N.º ${quote.number}`,
          },
        },
      },
    });
    if (vehicle.currentMileage === null || data.mileageIn > vehicle.currentMileage)
      await tx.vehicle.update({
        where: { id: vehicle.id },
        data: { currentMileage: data.mileageIn },
      });

    // Los precios de la OT no incluyen IGV: si el catálogo los trae con IGV se les quita.
    const exTax = (value: Prisma.Decimal, taxed: boolean, places: number) =>
      ctx.pricesIncludeTax && taxed ? value.div(rate.plus(1)).toDecimalPlaces(places) : value;
    let hasParts = false;
    for (const item of quote.items) {
      const taxed = item.taxAffectation === "TAXED";
      const isPart = Boolean(item.product?.isStocked) && !item.isLabor;
      if (isPart) hasParts = true;
      await tx.workOrderItem.create({
        data: {
          workOrderId: order.id,
          type: isPart ? "PART" : "LABOR",
          productId: item.productId,
          description: item.description,
          quantity: item.quantity,
          unitPrice: exTax(item.unitPrice, taxed, 4).toString(),
          discount: exTax(item.discount, taxed, 2).toFixed(2),
          taxAffectation: item.taxAffectation,
          approvalRound: 1,
          approvalStatus: "APPROVED",
          partStatus: isPart ? "REQUESTED" : "NOT_APPLICABLE",
          warrantyPolicyId: !isPart ? (item.product?.warrantyPolicyId ?? null) : null,
        },
      });
    }
    await changeStatus(tx, order, "DIAGNOSING", { userId: actor.userId });
    await changeStatus(tx, { id: order.id, status: "DIAGNOSING" }, "AWAITING_APPROVAL", {
      userId: actor.userId,
    });
    await tx.workOrder.update({
      where: { id: order.id },
      data: {
        approvedAt: now,
        approvalMethod: "QUOTE",
        approvedByName: quote.customer?.name ?? "Cliente",
      },
    });
    await changeStatus(
      tx,
      { id: order.id, status: "AWAITING_APPROVAL" },
      hasParts ? "AWAITING_PARTS" : "IN_REPAIR",
      { userId: actor.userId, note: `Aprobada por la cotización N.º ${quote.number}` },
    );
    const totals = await recalcTotals(tx, order.id);
    await tx.quote.update({ where: { id: quote.id }, data: { status: "CONVERTED" } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "quote.converted_to_work_order",
      entityType: "quote",
      entityId: quote.id,
      after: { workOrderId: order.id, workOrderNumber: number, total: totals.total },
    });
    return { id: order.id, number };
  });
}
