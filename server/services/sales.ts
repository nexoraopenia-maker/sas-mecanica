import { randomUUID } from "node:crypto";
import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { nextSequence, Prisma, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import { toDocumentLine, type DocumentLine } from "@/lib/billing/payload";
import {
  CREDIT_NOTE_REASONS,
  formatDocumentNumber,
  validateIgvRate,
  validateIssuance,
  type FiscalType,
} from "@/lib/billing/sunat";
import {
  allocate,
  computeSale,
  exceedsDiscountLimit,
  type Affectation,
  type TaxContext,
} from "@/lib/pos/totals";
import {
  returnSchema,
  saleSchema,
  voidSaleSchema,
  workOrderSaleSchema,
  type ReturnInput,
  type SaleInput,
  type WorkOrderSaleInput,
} from "@/lib/validation/sales";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import {
  buyerOf,
  createPendingDocument,
  dispatchDocument,
  issuerOf,
  taxContextOf,
} from "./billing";
import { lockOpenSession } from "./cash";
import { applyMovement, type AppliedMovement } from "./inventory";
import { registerWarranty } from "./warranties";

type ProductRow = Prisma.ProductGetPayload<object>;
const D = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);
const r2 = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

function isUniqueViolation(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta ?? {}).includes(field)
  );
}

// ---------------------------------------------------------------------------
// Preparación de líneas
// ---------------------------------------------------------------------------

/** Uso interno (cotizaciones y OT): línea ya validada contra el catálogo. */
export interface PreparedLine {
  product: ProductRow | null;
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  affectation: Affectation;
  stocked: boolean;
  serials?: string[] | undefined;
  lotId?: string | undefined;
  /** Línea de OT: el repuesto ya salió del kardex en la OT; aquí solo se vincula. */
  existing?:
    | { movementId: string | null; lotId: string | null; serialId: string | null; unitCost: string }
    | undefined;
}

async function prepareLines(tx: TenantTx, items: SaleInput["items"]): Promise<PreparedLine[]> {
  const parsed = saleSchema.shape.items.parse(items);
  const ids = [...new Set(parsed.flatMap((line) => (line.productId ? [line.productId] : [])))];
  const products = new Map(
    (await tx.product.findMany({ where: { id: { in: ids }, isActive: true } })).map((p) => [
      p.id,
      p,
    ]),
  );
  return parsed.map((line) => {
    if (!line.productId) {
      return {
        product: null,
        description: line.description ?? "",
        quantity: line.quantity,
        unitPrice: line.unitPrice ?? "0",
        discount: line.discount,
        affectation: "TAXED" as const,
        stocked: false,
      };
    }
    const product = products.get(line.productId);
    if (!product) throw new NotFoundError("Producto");
    if (product.trackingMode === "SERIAL") {
      if (
        !line.serials ||
        line.serials.length !== Number(line.quantity) ||
        !Number.isInteger(Number(line.quantity))
      ) {
        throw new ConflictError(
          "SERIAL_REQUIRED",
          `«${product.name}» se vende por número de serie: indica ${line.quantity} serie(s)`,
        );
      }
    } else if (line.serials) {
      throw new ConflictError("SERIAL_NOT_ALLOWED", `«${product.name}» no se controla por serie`);
    }
    if (line.lotId && product.trackingMode !== "LOT")
      throw new ConflictError("LOT_NOT_ALLOWED", `«${product.name}» no se controla por lote`);
    return {
      product,
      description: line.description?.trim() || product.name,
      quantity: line.quantity,
      unitPrice: product.salePrice.toString(),
      discount: line.discount,
      affectation: product.taxAffectation as Affectation,
      stocked: product.isStocked,
      serials: line.serials,
      lotId: line.lotId,
    };
  });
}

export function priceLines(
  actor: AuthUser,
  lines: PreparedLine[],
  ctx: TaxContext,
  enforceDiscountLimit = true,
) {
  const priced = computeSale(
    lines.map((l) => ({
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount,
      affectation: l.affectation,
    })),
    ctx,
  );
  if (enforceDiscountLimit) {
    priced.lines.forEach((line, index) => {
      if (D(line.discount).isZero()) return;
      if (!can(actor, "pos:aplicar_descuentos"))
        throw new PermissionDeniedError("pos:aplicar_descuentos");
      if (exceedsDiscountLimit(line, actor.maxDiscountPercent)) {
        throw new ConflictError(
          "DISCOUNT_LIMIT",
          `El descuento de «${lines[index]?.description}» (${line.discountPercent} %) supera tu límite (${actor.maxDiscountPercent} %)`,
        );
      }
    });
  }
  return priced;
}

// ---------------------------------------------------------------------------
// Cobro y crédito
// ---------------------------------------------------------------------------

async function outstandingBalance(tx: TenantTx, customerId: string): Promise<Prisma.Decimal> {
  const sum = await tx.receivable.aggregate({
    where: { customerId, status: { in: ["OPEN", "PARTIAL", "OVERDUE"] } },
    _sum: { balance: true },
  });
  return D(sum._sum.balance ?? 0);
}

interface Settlement {
  paid: Prisma.Decimal;
  due: Prisma.Decimal;
  paymentStatus: "UNPAID" | "PARTIAL" | "PAID";
}

async function settle(
  tx: TenantTx,
  data: { isCredit: boolean; payments: Array<{ amount: string }>; customerId?: string | undefined },
  total: Prisma.Decimal,
): Promise<Settlement> {
  const paid = data.payments.reduce((sum, p) => sum.plus(p.amount), D(0));
  if (paid.gt(total))
    throw new ConflictError("PAYMENT_EXCEEDS", "Los pagos superan el total de la venta");
  if (!data.isCredit) {
    if (!paid.eq(total))
      throw new ConflictError(
        "PAYMENT_MISMATCH",
        `Los pagos (S/ ${paid.toFixed(2)}) deben sumar el total (S/ ${total.toFixed(2)})`,
      );
    return { paid, due: D(0), paymentStatus: "PAID" };
  }
  const due = total.minus(paid);
  if (due.lte(0))
    throw new ConflictError("CREDIT_NO_BALANCE", "Una venta a crédito debe dejar saldo pendiente");
  const customer = await tx.customer.findFirst({ where: { id: data.customerId } });
  if (!customer) throw new NotFoundError("Cliente");
  if (customer.creditLimit.lte(0))
    throw new ConflictError("NO_CREDIT", "El cliente no tiene línea de crédito autorizada");
  const outstanding = await outstandingBalance(tx, customer.id);
  if (outstanding.plus(due).gt(customer.creditLimit)) {
    throw new ConflictError(
      "CREDIT_LIMIT",
      `Excede la línea de crédito (S/ ${customer.creditLimit.toFixed(2)}); deuda actual S/ ${outstanding.toFixed(2)}`,
    );
  }
  return { paid, due, paymentStatus: paid.isZero() ? "UNPAID" : "PARTIAL" };
}

// ---------------------------------------------------------------------------
// Creación de la venta
// ---------------------------------------------------------------------------

export interface SaleResult {
  id: string;
  number: number;
  total: string;
  paymentStatus: "UNPAID" | "PARTIAL" | "PAID";
  documentId: string | null;
  documentNumber: string | null;
  replayed: boolean;
}

export interface CoreOptions {
  quoteId?: string | undefined;
  workOrderId?: string | undefined;
  /** Precios y descuentos ya pactados (cotización/OT): no se vuelven a limitar por rol. */
  honorPrices?: boolean | undefined;
  ctxOverride?: Partial<TaxContext> | undefined;
  meta?: RequestMeta | undefined;
}

export type SaleData = Omit<ReturnType<typeof saleSchema.parse>, "items">;

async function resultOf(tx: TenantTx, saleId: string, replayed: boolean): Promise<SaleResult> {
  const sale = await tx.sale.findFirstOrThrow({
    where: { id: saleId },
    include: { documents: { where: { type: { in: ["BOLETA", "FACTURA"] } } } },
  });
  const doc = sale.documents[0];
  return {
    id: sale.id,
    number: sale.number,
    total: sale.total.toFixed(2),
    paymentStatus: sale.paymentStatus,
    documentId: doc?.id ?? null,
    documentNumber: doc ? formatDocumentNumber(doc.series, doc.correlative) : null,
    replayed,
  };
}

async function defaultWarehouseId(
  tx: TenantTx,
  branchId: string,
  requested?: string,
): Promise<string> {
  const found = requested
    ? await tx.warehouse.findFirst({ where: { id: requested, isActive: true } })
    : ((await tx.warehouse.findFirst({ where: { branchId, isDefault: true, isActive: true } })) ??
      (await tx.warehouse.findFirst({
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { code: "asc" }],
      })));
  if (!found) throw new NotFoundError("Almacén");
  return found.id;
}

export async function createSaleCore(
  tx: TenantTx,
  actor: AuthUser,
  data: SaleData,
  lines: PreparedLine[],
  options: CoreOptions,
): Promise<SaleResult> {
  const replay = await tx.sale.findFirst({
    where: { idempotencyKey: data.idempotencyKey },
    select: { id: true },
  });
  if (replay) return resultOf(tx, replay.id, true);

  const session = await lockOpenSession(tx, actor);
  const settings = await tx.tenantSettings.findFirstOrThrow();
  const baseCtx = await taxContextOf(tx);
  const ctx: TaxContext = { ...baseCtx, ...options.ctxOverride };
  const priced = priceLines(actor, lines, ctx, !options.honorPrices);
  const total = D(priced.totals.total);
  if (total.lte(0))
    throw new ConflictError("EMPTY_SALE", "El total de la venta debe ser mayor que cero");

  const customer = data.customerId
    ? await tx.customer.findFirst({ where: { id: data.customerId } })
    : null;
  if (data.customerId && !customer) throw new NotFoundError("Cliente");
  if (
    data.vehicleId &&
    !(await tx.vehicle.findFirst({ where: { id: data.vehicleId }, select: { id: true } }))
  )
    throw new NotFoundError("Vehículo");
  const buyer = buyerOf(customer);

  if (data.documentType === "NOTA_VENTA") {
    if (!settings.enabledDocumentTypes.includes("NOTA_VENTA"))
      throw new ConflictError("DOC_DISABLED", "La nota de venta no está habilitada");
  } else {
    const problem = validateIssuance(data.documentType, Number(total), buyer);
    if (problem) throw new ConflictError("DOC_RULE", problem);
    const igv = validateIgvRate(ctx.taxRate, priced.totals.taxed);
    if (igv) throw new ConflictError("IGV_RATE", igv);
  }

  const settlement = await settle(tx, data, total);
  const warehouseId = await defaultWarehouseId(tx, session.branchId, data.warehouseId);
  const saleId = randomUUID();
  const number = await nextSequence(tx, "SALE");

  // La venta se inserta ANTES de mover stock: si dos peticiones idénticas compiten, la perdedora espera aquí y falla sin tocar el kardex.
  await tx.sale.create({
    data: {
      id: saleId,
      number,
      branchId: session.branchId,
      warehouseId,
      cashSessionId: session.id,
      customerId: customer?.id ?? null,
      vehicleId: data.vehicleId ?? null,
      workOrderId: options.workOrderId ?? null,
      quoteId: options.quoteId ?? null,
      sellerId: actor.userId,
      status: "COMPLETED",
      paymentStatus: settlement.paymentStatus,
      isCredit: data.isCredit,
      subtotal: priced.totals.subtotal,
      discountTotal: priced.totals.discount,
      taxTotal: priced.totals.tax,
      total: priced.totals.total,
      paidTotal: settlement.paid.toFixed(2),
      idempotencyKey: data.idempotencyKey,
      documentType: data.documentType,
      notes: data.notes ?? null,
    },
  });

  // Stock: SOLO por applyMovement, en orden fijo de producto (evita bloqueos cruzados entre ventas simultáneas).
  const allowNegative =
    can(actor, "inventory:permitir_stock_negativo") && settings.allowNegativeStock;
  const outcomes = new Map<number, AppliedMovement[]>();
  const stockLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.stocked && line.product && !line.existing);
  stockLines.sort((a, b) => (a.line.product?.id ?? "").localeCompare(b.line.product?.id ?? ""));
  for (const { line, index } of stockLines) {
    const outcome = await applyMovement(tx, {
      warehouseId,
      productId: line.product?.id ?? "",
      type: "SALE",
      ...(line.serials ? { serials: line.serials } : { quantity: line.quantity }),
      ...(line.lotId ? { lotId: line.lotId } : {}),
      referenceType: "sale",
      referenceId: saleId,
      idempotencyKey: `sale:${saleId}:${index}`,
      allowNegative,
      createdById: actor.userId,
    });
    outcomes.set(index, outcome.movements);
  }

  // Líneas de venta (una por lote o serie consumidos) con el importe repartido sin perder céntimos.
  const vehicle = data.vehicleId
    ? await tx.vehicle.findFirst({
        where: { id: data.vehicleId },
        select: { currentMileage: true },
      })
    : null;
  for (const [index, line] of lines.entries()) {
    const computed = priced.lines[index];
    if (!computed) continue;
    const taxRate = line.affectation === "TAXED" ? ctx.taxRate.toString() : "0";
    const movements = outcomes.get(index);
    const parts: Array<{ quantity: string; movement: AppliedMovement | null }> = movements
      ? movements.map((m) => ({ quantity: D(m.quantityDelta).abs().toString(), movement: m }))
      : [{ quantity: line.quantity, movement: null }];
    const totals = allocate(
      computed.lineTotal,
      parts.map((p) => p.quantity),
    );
    const discounts = allocate(
      computed.discount,
      parts.map((p) => p.quantity),
    );
    for (const [partIndex, part] of parts.entries()) {
      const item = await tx.saleItem.create({
        data: {
          saleId,
          productId: line.product?.id ?? null,
          lotId: part.movement?.lotId ?? line.existing?.lotId ?? null,
          serialId: part.movement?.serialId ?? line.existing?.serialId ?? null,
          description: line.description,
          quantity: part.quantity,
          unitPrice: line.unitPrice,
          unitCost: part.movement?.avgCostAfter ?? line.existing?.unitCost ?? "0",
          discount: discounts[partIndex] ?? "0",
          taxAffectation: line.affectation,
          taxRate,
          lineTotal: totals[partIndex] ?? "0",
          kardexMovementId: part.movement?.id ?? line.existing?.movementId ?? null,
        },
      });
      // Garantía automática de la venta (con la serie de la batería o el DOT de la llanta).
      if (!line.existing && line.product?.warrantyPolicyId && part.movement) {
        await registerWarranty(tx, {
          source: "SALE_ITEM",
          customerId: customer?.id ?? null,
          vehicleId: data.vehicleId ?? null,
          productId: line.product.id,
          policyId: line.product.warrantyPolicyId,
          saleItemId: item.id,
          serialId: item.serialId,
          lotId: item.lotId,
          description: `${line.description} (venta N.º ${number})`,
          startsAt: new Date(),
          startMileage: vehicle?.currentMileage ?? null,
        });
      }
    }
  }

  // Pagos de la venta (con signo: las devoluciones serán filas negativas).
  for (const payment of data.payments) {
    await tx.salePayment.create({
      data: {
        saleId,
        cashSessionId: session.id,
        method: payment.method,
        amount: payment.amount,
        reference: payment.reference ?? null,
        receivedById: actor.userId,
      },
    });
  }
  if (data.isCredit && customer) {
    const days =
      data.creditDays ??
      (customer.creditDays > 0 ? customer.creditDays : settings.defaultCreditDays);
    await tx.receivable.create({
      data: {
        saleId,
        customerId: customer.id,
        total: total.toFixed(2),
        balance: settlement.due.toFixed(2),
        dueDate: new Date(Date.now() + days * 86_400_000),
        status: settlement.paid.isZero() ? "OPEN" : "PARTIAL",
      },
    });
  }

  // Comprobante electrónico (PENDING): su envío ocurre fuera de esta transacción.
  if (data.documentType !== "NOTA_VENTA") {
    const type = data.documentType as "BOLETA" | "FACTURA";
    await issuerOf(tx); // sin RUC no se puede emitir: falla ahora y revierte la venta.
    const docLines: DocumentLine[] = lines.map((line, index) =>
      toDocumentLine(
        {
          code: line.product?.sku ?? null,
          description: line.description,
          isService: !line.stocked,
          quantity: line.quantity,
          affectation: line.affectation,
        },
        priced.lines[index] as NonNullable<(typeof priced.lines)[number]>,
        ctx,
      ),
    );
    await createPendingDocument(tx, {
      type,
      saleId,
      docKey: `${saleId}:${type}`,
      series: type === "FACTURA" ? settings.facturaSeries : settings.boletaSeries,
      lines: docLines,
      buyer,
      isCredit: data.isCredit,
      issueDate: new Date(),
    });
  }

  await recordAudit(tx, auditContextOf(actor, options.meta ?? {}), {
    action: "sale.created",
    entityType: "sale",
    entityId: saleId,
    after: {
      number,
      total: priced.totals.total,
      paid: settlement.paid.toFixed(2),
      isCredit: data.isCredit,
      documentType: data.documentType,
      items: lines.length,
      workOrderId: options.workOrderId ?? null,
      quoteId: options.quoteId ?? null,
    },
  });
  return resultOf(tx, saleId, false);
}

/** Corre una venta con reintento si compite con otra idéntica (misma clave de idempotencia). */
export async function runSale(
  tenantId: string,
  idempotencyKey: string,
  fn: (tx: TenantTx) => Promise<SaleResult>,
): Promise<SaleResult> {
  let result: SaleResult;
  try {
    result = await withTenant(tenantId, fn, { timeoutMs: 30_000 });
  } catch (error) {
    if (!isUniqueViolation(error, "idempotencyKey")) throw error;
    result = await withTenant(tenantId, async (tx) => {
      const existing = await tx.sale.findFirst({ where: { idempotencyKey }, select: { id: true } });
      if (!existing) throw error;
      return resultOf(tx, existing.id, true);
    });
  }
  // Envío al OSE fuera de la transacción: si falla, el job lo reintenta (la venta ya está registrada).
  if (result.documentId && !result.replayed)
    await dispatchDocument(tenantId, result.documentId).catch(() => "RETRY");
  return result;
}

/** Venta de mostrador. Descarga el stock exclusivamente con `applyMovement`. */
export async function createSale(
  actor: AuthUser,
  input: SaleInput,
  meta: RequestMeta = {},
): Promise<SaleResult> {
  requirePermission(actor, "pos:crear");
  const data = saleSchema.parse(input);
  return runSale(requireTenantId(actor), data.idempotencyKey, async (tx) => {
    const lines = await prepareLines(tx, data.items);
    return createSaleCore(tx, actor, data, lines, { meta });
  });
}

// ---------------------------------------------------------------------------
// OT → venta (cuenta mixta, sin volver a tocar el kardex)
// ---------------------------------------------------------------------------

export async function convertWorkOrderToSale(
  actor: AuthUser,
  input: WorkOrderSaleInput,
  meta: RequestMeta = {},
): Promise<SaleResult> {
  requirePermission(actor, "pos:crear");
  requirePermission(actor, "workshop:ver");
  const data = workOrderSaleSchema.parse(input);
  return runSale(requireTenantId(actor), data.idempotencyKey, async (tx) => {
    const order = await tx.workOrder.findFirst({
      where: { id: data.workOrderId },
      include: { customer: true },
    });
    if (!order) throw new NotFoundError("Orden de trabajo");
    if (!["READY", "DELIVERED"].includes(order.status))
      throw new ConflictError("WO_STATE", "Solo se factura una OT lista para entrega o entregada");
    const replay = await tx.sale.findFirst({
      where: { idempotencyKey: data.idempotencyKey },
      select: { id: true },
    });
    if (replay) return resultOf(tx, replay.id, true);
    if (
      await tx.sale.findFirst({
        where: { workOrderId: order.id, status: { not: "VOIDED" } },
        select: { id: true },
      })
    ) {
      throw new ConflictError("WO_ALREADY_SOLD", "Esta orden de trabajo ya fue facturada");
    }
    const items = await tx.workOrderItem.findMany({
      where: { workOrderId: order.id, approvalStatus: "APPROVED", NOT: { partStatus: "RETURNED" } },
      include: { product: true },
      orderBy: { createdAt: "asc" },
    });
    if (items.length === 0)
      throw new ConflictError("WO_EMPTY", "La orden no tiene ítems aprobados para facturar");
    if (items.some((item) => item.type === "PART" && item.partStatus !== "ISSUED"))
      throw new ConflictError("PARTS_PENDING", "Hay repuestos aprobados sin entregar");

    const movementIds = items.flatMap((item) =>
      item.consumptionMovementId ? [item.consumptionMovementId] : [],
    );
    const movements = new Map(
      (await tx.kardexMovement.findMany({ where: { id: { in: movementIds } } })).map((m) => [
        m.id,
        m,
      ]),
    );
    const lines: PreparedLine[] = items.map((item) => {
      const movement = item.consumptionMovementId
        ? movements.get(item.consumptionMovementId)
        : undefined;
      return {
        product: item.product,
        description: item.description,
        quantity: item.quantity.toString(),
        // Los precios de la OT no incluyen IGV: la venta se calcula con esa misma base.
        unitPrice: item.unitPrice.toString(),
        discount: item.discount.toString(),
        affectation: item.taxAffectation as Affectation,
        stocked: item.type === "PART",
        existing:
          item.type === "PART"
            ? {
                movementId: item.consumptionMovementId,
                lotId: movement?.lotId ?? null,
                serialId: movement?.serialId ?? null,
                unitCost: item.unitCost.toString(),
              }
            : undefined,
      };
    });
    const customerId = order.customerId;
    const result = await createSaleCore(
      tx,
      actor,
      { ...data, customerId, vehicleId: order.vehicleId },
      lines,
      { workOrderId: order.id, honorPrices: true, ctxOverride: { pricesIncludeTax: false }, meta },
    );
    return result;
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listSales(
  actor: AuthUser,
  filter: { q?: string; status?: "COMPLETED" | "VOIDED"; limit?: number } = {},
) {
  requirePermission(actor, "pos:ver");
  const q = filter.q?.trim();
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.sale.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(q
          ? {
              OR: [
                ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : []),
                { customer: { name: { contains: q, mode: "insensitive" as const } } },
              ],
            }
          : {}),
      },
      include: {
        customer: { select: { name: true } },
        documents: {
          where: { type: { in: ["BOLETA", "FACTURA"] } },
          select: { series: true, correlative: true, status: true, type: true },
        },
      },
      orderBy: { createdAt: "desc" },
      take: filter.limit ?? 100,
    });
    return rows.map((s) => ({
      id: s.id,
      number: s.number,
      createdAt: s.createdAt,
      status: s.status,
      paymentStatus: s.paymentStatus,
      isCredit: s.isCredit,
      customer: s.customer?.name ?? null,
      total: s.total.toFixed(2),
      document: s.documents[0]
        ? {
            number: formatDocumentNumber(s.documents[0].series, s.documents[0].correlative),
            status: s.documents[0].status,
            type: s.documents[0].type,
          }
        : null,
    }));
  });
}

/** Venta completa para la pantalla y el ticket. El costo solo lo ve quien tiene el permiso de costos. */
export async function getSale(actor: AuthUser, saleId: string) {
  requirePermission(actor, "pos:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  return withTenant(requireTenantId(actor), async (tx) => {
    const sale = await tx.sale.findFirst({
      where: { id: saleId },
      include: {
        customer: true,
        vehicle: { select: { plate: true, make: true, model: true } },
        seller: { select: { name: true } },
        items: {
          orderBy: { id: "asc" },
          include: {
            product: { select: { sku: true } },
            serial: { select: { serial: true } },
            lot: { select: { dotCode: true, code: true } },
          },
        },
        payments: { orderBy: { paidAt: "asc" } },
        receivable: true,
        documents: { orderBy: { createdAt: "asc" } },
        returns: { orderBy: { number: "asc" } },
      },
    });
    if (!sale) throw new NotFoundError("Venta");
    const returnedByItem = new Map<string, Prisma.Decimal>();
    for (const row of await tx.saleReturnItem.findMany({
      where: { saleItem: { saleId } },
      select: { saleItemId: true, quantity: true },
    })) {
      returnedByItem.set(
        row.saleItemId,
        (returnedByItem.get(row.saleItemId) ?? D(0)).plus(row.quantity),
      );
    }
    return {
      id: sale.id,
      number: sale.number,
      status: sale.status,
      paymentStatus: sale.paymentStatus,
      isCredit: sale.isCredit,
      documentType: sale.documentType,
      createdAt: sale.createdAt,
      voidReason: sale.voidReason,
      workOrderId: sale.workOrderId,
      notes: sale.notes,
      seller: sale.seller?.name ?? null,
      customer: sale.customer
        ? {
            id: sale.customer.id,
            name: sale.customer.name,
            docType: sale.customer.docType,
            docNumber: sale.customer.docNumber,
          }
        : null,
      vehicle: sale.vehicle,
      subtotal: sale.subtotal.toFixed(2),
      discountTotal: sale.discountTotal.toFixed(2),
      taxTotal: sale.taxTotal.toFixed(2),
      total: sale.total.toFixed(2),
      paidTotal: sale.paidTotal.toFixed(2),
      items: sale.items.map((i) => ({
        id: i.id,
        description: i.description,
        sku: i.product?.sku ?? null,
        quantity: i.quantity.toString(),
        returned: (returnedByItem.get(i.id) ?? D(0)).toString(),
        unitPrice: i.unitPrice.toString(),
        discount: i.discount.toFixed(2),
        lineTotal: i.lineTotal.toFixed(2),
        serial: i.serial?.serial ?? null,
        dotCode: i.lot?.dotCode ?? null,
        ...(canSeeCost ? { unitCost: i.unitCost.toString() } : {}),
      })),
      payments: sale.payments.map((p) => ({
        id: p.id,
        method: p.method,
        amount: p.amount.toFixed(2),
        reference: p.reference,
        paidAt: p.paidAt,
      })),
      receivable: sale.receivable
        ? {
            id: sale.receivable.id,
            balance: sale.receivable.balance.toFixed(2),
            dueDate: sale.receivable.dueDate,
            status: sale.receivable.status,
          }
        : null,
      documents: sale.documents.map((d) => ({
        id: d.id,
        type: d.type,
        number: formatDocumentNumber(d.series, d.correlative),
        status: d.status,
        total: d.total.toFixed(2),
        errorMessage: d.errorMessage,
        pdfUrl: d.pdfUrl,
        noteReason: d.noteReason,
      })),
      returns: sale.returns.map((r) => ({
        id: r.id,
        number: r.number,
        total: r.total.toFixed(2),
        reason: r.reason,
        resolution: r.resolution,
        createdAt: r.createdAt,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Anulación
// ---------------------------------------------------------------------------

function creditNoteLines(
  items: Array<{
    description: string;
    quantity: Prisma.Decimal;
    unitPrice: Prisma.Decimal;
    lineTotal: Prisma.Decimal;
    taxAffectation: string;
    taxRate: Prisma.Decimal;
    product: { sku: string; isStocked: boolean } | null;
  }>,
  amounts: Prisma.Decimal[],
  quantities: Prisma.Decimal[],
): DocumentLine[] {
  return items.map((item, index) => {
    const total = amounts[index] ?? D(0);
    const qty = quantities[index] ?? item.quantity;
    const taxed = item.taxAffectation === "TAXED";
    const base = taxed ? r2(total.div(item.taxRate.plus(1))) : total;
    return {
      code: item.product?.sku ?? null,
      description: item.description,
      unitCode: item.product?.isStocked ? "NIU" : "ZZ",
      quantity: qty.toString(),
      unitValue: base.div(qty).toDecimalPlaces(6).toString(),
      unitPrice: total.div(qty).toDecimalPlaces(4).toString(),
      discount: "0.00",
      base: base.toFixed(2),
      tax: total.minus(base).toFixed(2),
      total: total.toFixed(2),
      affectation: item.taxAffectation as Affectation,
    };
  });
}

async function lockSale(tx: TenantTx, saleId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId}::uuid FOR UPDATE`;
}

/**
 * Anula una venta: devuelve el stock por el kardex (`SALE_VOID`), reintegra lo cobrado en la caja
 * abierta, cancela la deuda, anula las garantías y, si el comprobante ya fue aceptado, emite la
 * nota de crédito de anulación. Requiere permiso, motivo y queda auditada.
 */
export async function voidSale(actor: AuthUser, input: z_VoidInput, meta: RequestMeta = {}) {
  requirePermission(actor, "pos:anular_venta");
  const data = voidSaleSchema.parse(input);
  const tenantId = requireTenantId(actor);
  const outcome = await withTenant(
    tenantId,
    async (tx) => {
      await lockSale(tx, data.saleId);
      const sale = await tx.sale.findFirst({
        where: { id: data.saleId },
        include: {
          items: {
            include: {
              product: { select: { sku: true, isStocked: true } },
              serial: { select: { serial: true } },
            },
          },
          payments: true,
          receivable: true,
          documents: true,
        },
      });
      if (!sale) throw new NotFoundError("Venta");
      if (sale.status === "VOIDED")
        return { replayed: true as const, noteId: null as string | null };
      if (await tx.saleReturn.findFirst({ where: { saleId: sale.id }, select: { id: true } }))
        throw new ConflictError(
          "SALE_HAS_RETURNS",
          "La venta tiene devoluciones: no se puede anular completa",
        );
      const main = sale.documents.find((d) => d.type === "BOLETA" || d.type === "FACTURA");
      if (
        main &&
        main.status === "PENDING" &&
        main.attempts > 0 &&
        main.nextRetryAt &&
        main.nextRetryAt > new Date()
      ) {
        throw new ConflictError(
          "DOC_IN_FLIGHT",
          "El comprobante se está enviando; espera unos minutos para anular",
        );
      }

      // 1) Dinero: se devuelve lo cobrado (neto por medio de pago) en la caja abierta de quien anula.
      const netByMethod = new Map<string, Prisma.Decimal>();
      for (const p of sale.payments)
        netByMethod.set(p.method, (netByMethod.get(p.method) ?? D(0)).plus(p.amount));
      const refunds = [...netByMethod.entries()].filter(([, amount]) => amount.gt(0));
      if (refunds.length > 0) {
        const session = await lockOpenSession(tx, actor);
        const refunded = refunds.reduce((sum, [, amount]) => sum.plus(amount), D(0));
        if (data.refundMethod) {
          await tx.salePayment.create({
            data: {
              saleId: sale.id,
              cashSessionId: session.id,
              method: data.refundMethod,
              amount: refunded.negated().toFixed(2),
              reference: `Anulación venta ${sale.number}`,
              receivedById: actor.userId,
            },
          });
        } else {
          for (const [method, amount] of refunds) {
            await tx.salePayment.create({
              data: {
                saleId: sale.id,
                cashSessionId: session.id,
                method: method as "CASH",
                amount: amount.negated().toFixed(2),
                reference: `Anulación venta ${sale.number}`,
                receivedById: actor.userId,
              },
            });
          }
        }
      }

      // 2) Stock: reingreso por el kardex (las ventas de OT no tocaron el stock: el repuesto lo consumió la OT).
      if (!sale.workOrderId) {
        for (const item of sale.items) {
          if (!item.productId || !item.kardexMovementId || !item.product?.isStocked) continue;
          const original = await tx.kardexMovement.findFirstOrThrow({
            where: { id: item.kardexMovementId },
          });
          await applyMovement(tx, {
            warehouseId: original.warehouseId,
            productId: item.productId,
            type: "SALE_VOID",
            ...(item.serial
              ? { serials: [item.serial.serial] }
              : { quantity: item.quantity.toString() }),
            ...(item.lotId ? { lotId: item.lotId } : {}),
            unitCost: item.unitCost.toString(),
            reason: `Anulación de la venta ${sale.number}: ${data.reason}`,
            referenceType: "sale",
            referenceId: sale.id,
            idempotencyKey: `sale-void:${sale.id}:${item.id}`,
            createdById: actor.userId,
          });
        }
        await tx.warranty.updateMany({
          where: {
            saleItemId: { in: sale.items.map((i) => i.id) },
            status: { in: ["ACTIVE", "IN_CLAIM"] },
          },
          data: { status: "VOID" },
        });
      }

      // 3) Deuda y comprobante.
      if (sale.receivable)
        await tx.receivable.update({
          where: { id: sale.receivable.id },
          data: { balance: 0, status: "WRITTEN_OFF" },
        });
      let noteId: string | null = null;
      if (main?.status === "ACCEPTED") {
        const settings = await tx.tenantSettings.findFirstOrThrow();
        const snapshot = main.customerSnapshot as {
          buyer: Parameters<typeof createPendingDocument>[1]["buyer"];
          isCredit: boolean;
        };
        const note = await createPendingDocument(tx, {
          type: "NOTA_CREDITO",
          saleId: sale.id,
          related: {
            id: main.id,
            type: main.type as FiscalType,
            series: main.series,
            correlative: main.correlative,
          },
          docKey: `${sale.id}:NC:void`,
          series:
            main.type === "FACTURA"
              ? settings.creditNoteFacturaSeries
              : settings.creditNoteBoletaSeries,
          lines: creditNoteLines(
            sale.items,
            sale.items.map((i) => i.lineTotal),
            sale.items.map((i) => i.quantity),
          ),
          buyer: snapshot.buyer,
          isCredit: snapshot.isCredit,
          note: { reasonCode: "01", reason: CREDIT_NOTE_REASONS["01"] },
          issueDate: new Date(),
        });
        noteId = note.id;
      } else if (main && main.status !== "VOIDED") {
        await tx.fiscalDocument.update({
          where: { id: main.id },
          data: {
            status: "VOIDED",
            nextRetryAt: null,
            errorMessage: "Anulado antes de ser aceptado",
          },
        });
      }

      await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: "VOIDED",
          voidedAt: new Date(),
          voidedById: actor.userId,
          voidReason: data.reason,
          paidTotal: 0,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "sale.voided",
        entityType: "sale",
        entityId: sale.id,
        reason: data.reason,
        before: { total: sale.total.toFixed(2), paid: sale.paidTotal.toFixed(2) },
        after: { creditNoteId: noteId },
      });
      return { replayed: false as const, noteId };
    },
    { timeoutMs: 30_000 },
  );
  if (outcome.noteId) await dispatchDocument(tenantId, outcome.noteId).catch(() => "RETRY");
  return outcome;
}
type z_VoidInput = Parameters<typeof voidSaleSchema.parse>[0];

// ---------------------------------------------------------------------------
// Devolución parcial o total
// ---------------------------------------------------------------------------

/**
 * Devolución de ítems. Primero baja la deuda del cliente (si la venta fue a crédito) y solo lo que
 * excede se devuelve en dinero, de la caja abierta. «Nota de crédito» solo aplica contra deuda.
 * El stock vuelve por el kardex (`RETURN_CUSTOMER`) salvo que se indique que el producto no sirve.
 */
export async function returnSale(actor: AuthUser, input: ReturnInput, meta: RequestMeta = {}) {
  requirePermission(actor, "pos:anular_venta");
  const data = returnSchema.parse(input);
  const tenantId = requireTenantId(actor);
  const outcome = await withTenant(
    tenantId,
    async (tx) => {
      const replay = await tx.saleReturn.findFirst({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (replay)
        return {
          id: replay.id,
          number: replay.number,
          total: replay.total.toFixed(2),
          cashRefund: "0.00",
          debtReduction: "0.00",
          noteId: null as string | null,
          replayed: true,
        };
      await lockSale(tx, data.saleId);
      const sale = await tx.sale.findFirst({
        where: { id: data.saleId },
        include: {
          items: {
            include: {
              product: { select: { sku: true, isStocked: true } },
              serial: { select: { serial: true } },
            },
          },
          receivable: true,
          documents: true,
        },
      });
      if (!sale) throw new NotFoundError("Venta");
      if (sale.status !== "COMPLETED")
        throw new ConflictError("SALE_STATE", "Solo se devuelven ventas completadas");
      const main = sale.documents.find((d) => d.type === "BOLETA" || d.type === "FACTURA");
      if (main?.status === "PENDING")
        throw new ConflictError(
          "DOC_PENDING",
          "El comprobante aún no fue aceptado: espera su envío antes de devolver",
        );

      const previous = await tx.saleReturnItem.findMany({
        where: { saleItem: { saleId: sale.id } },
        select: { saleItemId: true, quantity: true, amount: true },
      });
      const returnedQty = new Map<string, Prisma.Decimal>();
      const returnedAmount = new Map<string, Prisma.Decimal>();
      for (const row of previous) {
        returnedQty.set(
          row.saleItemId,
          (returnedQty.get(row.saleItemId) ?? D(0)).plus(row.quantity),
        );
        returnedAmount.set(
          row.saleItemId,
          (returnedAmount.get(row.saleItemId) ?? D(0)).plus(row.amount),
        );
      }

      const lines: Array<{
        item: (typeof sale.items)[number];
        quantity: Prisma.Decimal;
        amount: Prisma.Decimal;
        restock: boolean;
      }> = [];
      for (const entry of data.items) {
        const item = sale.items.find((i) => i.id === entry.saleItemId);
        if (!item) throw new NotFoundError("Ítem de la venta");
        const quantity = D(entry.quantity);
        const remaining = item.quantity.minus(returnedQty.get(item.id) ?? 0);
        if (quantity.gt(remaining))
          throw new ConflictError(
            "RETURN_EXCEEDS",
            `«${item.description}»: solo quedan ${remaining.toString()} por devolver`,
          );
        // La última porción devuelve el resto exacto del importe (sin deriva por redondeo).
        const amount = quantity.eq(remaining)
          ? item.lineTotal.minus(returnedAmount.get(item.id) ?? 0)
          : r2(item.lineTotal.times(quantity).div(item.quantity));
        lines.push({ item, quantity, amount, restock: entry.restock && !sale.workOrderId });
      }
      if (new Set(lines.map((l) => l.item.id)).size !== lines.length)
        throw new ConflictError("RETURN_DUPLICATE", "Un ítem aparece dos veces en la devolución");
      const total = lines.reduce((sum, l) => sum.plus(l.amount), D(0));

      const debtReduction =
        sale.receivable && ["OPEN", "PARTIAL", "OVERDUE"].includes(sale.receivable.status)
          ? Prisma.Decimal.min(total, sale.receivable.balance)
          : D(0);
      const cashRefund = total.minus(debtReduction);
      if (data.resolution === "CREDIT_NOTE" && cashRefund.gt(0)) {
        throw new ConflictError(
          "CREDIT_NOTE_NO_DEBT",
          "La nota de crédito aplica contra la deuda del cliente; para devolver dinero elige «Reembolso»",
        );
      }
      const netPaid = await tx.salePayment.aggregate({
        where: { saleId: sale.id },
        _sum: { amount: true },
      });
      if (cashRefund.gt(D(netPaid._sum.amount ?? 0)))
        throw new ConflictError(
          "REFUND_EXCEEDS_PAID",
          "El reembolso supera lo cobrado en esta venta",
        );

      const returnId = randomUUID();
      const number = await nextSequence(tx, "RETURN");
      await tx.saleReturn.create({
        data: {
          id: returnId,
          number,
          saleId: sale.id,
          resolution: data.resolution,
          reason: data.reason,
          total: total.toFixed(2),
          idempotencyKey: data.idempotencyKey,
          createdById: actor.userId,
        },
      });

      for (const line of lines) {
        let movementId: string | null = null;
        if (
          line.restock &&
          line.item.productId &&
          line.item.kardexMovementId &&
          line.item.product?.isStocked
        ) {
          const original = await tx.kardexMovement.findFirstOrThrow({
            where: { id: line.item.kardexMovementId },
          });
          const outcome = await applyMovement(tx, {
            warehouseId: original.warehouseId,
            productId: line.item.productId,
            type: "RETURN_CUSTOMER",
            ...(line.item.serial
              ? { serials: [line.item.serial.serial] }
              : { quantity: line.quantity.toString() }),
            ...(line.item.lotId ? { lotId: line.item.lotId } : {}),
            unitCost: line.item.unitCost.toString(),
            reason: `Devolución ${number} de la venta ${sale.number}: ${data.reason}`,
            referenceType: "sale_return",
            referenceId: returnId,
            idempotencyKey: `sale-return:${returnId}:${line.item.id}`,
            createdById: actor.userId,
          });
          movementId = outcome.movements[0]?.id ?? null;
        }
        await tx.saleReturnItem.create({
          data: {
            returnId,
            saleItemId: line.item.id,
            quantity: line.quantity.toString(),
            amount: line.amount.toFixed(2),
            restock: line.restock,
            kardexMovementId: movementId,
          },
        });
        if (line.quantity.eq(line.item.quantity.minus(returnedQty.get(line.item.id) ?? 0))) {
          await tx.warranty.updateMany({
            where: { saleItemId: line.item.id, status: { in: ["ACTIVE", "IN_CLAIM"] } },
            data: { status: "VOID" },
          });
        }
      }

      if (debtReduction.gt(0) && sale.receivable) {
        const balance = sale.receivable.balance.minus(debtReduction);
        await tx.receivable.update({
          where: { id: sale.receivable.id },
          data: {
            balance: balance.toFixed(2),
            status: balance.isZero() ? "PAID" : sale.receivable.status,
          },
        });
      }
      if (cashRefund.gt(0)) {
        const session = await lockOpenSession(tx, actor);
        await tx.salePayment.create({
          data: {
            saleId: sale.id,
            cashSessionId: session.id,
            method: data.refundMethod,
            amount: cashRefund.negated().toFixed(2),
            reference: `Devolución ${number}`,
            receivedById: actor.userId,
          },
        });
        await tx.sale.update({
          where: { id: sale.id },
          data: { paidTotal: { decrement: cashRefund.toFixed(2) } },
        });
      }

      let noteId: string | null = null;
      if (main?.status === "ACCEPTED") {
        const settings = await tx.tenantSettings.findFirstOrThrow();
        const snapshot = main.customerSnapshot as {
          buyer: Parameters<typeof createPendingDocument>[1]["buyer"];
          isCredit: boolean;
        };
        const fullyReturned = sale.items.every((i) => {
          const line = lines.find((l) => l.item.id === i.id);
          return (returnedQty.get(i.id) ?? D(0)).plus(line?.quantity ?? 0).eq(i.quantity);
        });
        const reason = fullyReturned ? "06" : "07";
        const note = await createPendingDocument(tx, {
          type: "NOTA_CREDITO",
          saleId: sale.id,
          saleReturnId: returnId,
          related: {
            id: main.id,
            type: main.type as FiscalType,
            series: main.series,
            correlative: main.correlative,
          },
          docKey: `${returnId}:NC`,
          series:
            main.type === "FACTURA"
              ? settings.creditNoteFacturaSeries
              : settings.creditNoteBoletaSeries,
          lines: creditNoteLines(
            lines.map((l) => l.item),
            lines.map((l) => l.amount),
            lines.map((l) => l.quantity),
          ),
          buyer: snapshot.buyer,
          isCredit: snapshot.isCredit,
          note: { reasonCode: reason, reason: CREDIT_NOTE_REASONS[reason] },
          issueDate: new Date(),
        });
        noteId = note.id;
      }
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "sale.returned",
        entityType: "sale",
        entityId: sale.id,
        reason: data.reason,
        after: {
          returnId,
          number,
          total: total.toFixed(2),
          cashRefund: cashRefund.toFixed(2),
          debtReduction: debtReduction.toFixed(2),
          resolution: data.resolution,
        },
      });
      return {
        id: returnId,
        number,
        total: total.toFixed(2),
        cashRefund: cashRefund.toFixed(2),
        debtReduction: debtReduction.toFixed(2),
        noteId,
        replayed: false,
      };
    },
    { timeoutMs: 30_000 },
  );
  if (outcome.noteId) await dispatchDocument(tenantId, outcome.noteId).catch(() => "RETRY");
  return outcome;
}

// ---------------------------------------------------------------------------
// Vista previa del carrito (el mostrador muestra los totales que calcula el servidor)
// ---------------------------------------------------------------------------

/** Totales de un carrito sin guardar nada: misma lógica, descuentos y topes que la venta real. */
export async function previewSale(actor: AuthUser, items: SaleInput["items"]) {
  requirePermission(actor, "pos:crear");
  return withTenant(requireTenantId(actor), async (tx) => {
    const lines = await prepareLines(tx, items);
    const priced = priceLines(actor, lines, await taxContextOf(tx));
    return {
      lines: priced.lines.map((line, index) => ({
        unitPrice: lines[index]?.unitPrice ?? "0",
        lineTotal: line.lineTotal,
        discountPercent: line.discountPercent,
      })),
      totals: priced.totals,
    };
  });
}
