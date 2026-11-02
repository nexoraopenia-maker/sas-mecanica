import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, nextSequence, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { canTransition, OPEN_STATUSES } from "@/lib/purchasing/state";
import { buildOrderMessage } from "@/lib/purchasing/text";
import {
  purchaseOrderSchema,
  receiveSchema,
  supplierReturnSchema,
  type PurchaseOrderInput,
  type ReceiveInput,
  type SupplierReturnInput,
} from "@/lib/validation/purchasing";
import { auditContextOf, recordAudit, type AuditContext, type RequestMeta } from "./audit";
import { applyMovement, applyMovements } from "./inventory";
import { enqueueOutbound } from "./messaging";

const ZERO = new Prisma.Decimal(0);

function isDuplicateKey(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta ?? {}).includes("idempotencyKey")
  );
}

/** Totales con precios de la BD. El IGV (o impuesto del tenant) se aplica solo a ítems gravados. */
export async function computeTotals(
  tx: TenantTx,
  items: Array<{ productId: string; quantity: Prisma.Decimal; unitCost: Prisma.Decimal }>,
) {
  const [settings, products] = await Promise.all([
    tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true } }),
    tx.product.findMany({
      where: { id: { in: items.map((i) => i.productId) } },
      select: { id: true, taxAffectation: true },
    }),
  ]);
  const taxed = new Map(products.map((p) => [p.id, p.taxAffectation === "TAXED"]));
  let subtotal = ZERO;
  let tax = ZERO;
  const rates = new Map<string, Prisma.Decimal>();
  for (const item of items) {
    const line = item.quantity.times(item.unitCost);
    const rate = taxed.get(item.productId) ? settings.taxRate : ZERO;
    rates.set(item.productId, rate);
    subtotal = subtotal.plus(line);
    tax = tax.plus(line.times(rate));
  }
  return {
    subtotal: subtotal.toDecimalPlaces(2),
    taxTotal: tax.toDecimalPlaces(2),
    total: subtotal.plus(tax).toDecimalPlaces(2),
    rates,
  };
}

/** Crea una orden (manual o aprobada desde la bandeja de IA) dentro de la transacción del llamador. */
export async function insertPurchaseOrder(
  tx: TenantTx,
  params: {
    supplierId: string;
    warehouseId: string;
    items: Array<{ productId: string; quantity: string; unitCost: string }>;
    origin: "MANUAL" | "AI";
    status: "DRAFT" | "REQUESTED";
    idempotencyKey: string;
    conditions?: string | undefined;
    expectedAt?: Date | undefined;
    aiRunId?: string | undefined;
    createdById?: string | null | undefined;
    approvedById?: string | null | undefined;
  },
) {
  const items = params.items.map((item) => ({
    productId: item.productId,
    quantity: new Prisma.Decimal(item.quantity),
    unitCost: new Prisma.Decimal(item.unitCost),
  }));
  const totals = await computeTotals(tx, items);
  const number = await nextSequence(tx, "PO");
  return tx.purchaseOrder.create({
    data: {
      number,
      supplierId: params.supplierId,
      warehouseId: params.warehouseId,
      status: params.status,
      origin: params.origin,
      aiRunId: params.aiRunId ?? null,
      subtotal: totals.subtotal.toString(),
      taxTotal: totals.taxTotal.toString(),
      total: totals.total.toString(),
      conditions: params.conditions ?? null,
      expectedAt: params.expectedAt ?? null,
      idempotencyKey: params.idempotencyKey,
      createdById: params.createdById ?? null,
      approvedById: params.approvedById ?? null,
      sentAt: params.status === "REQUESTED" ? new Date() : null,
      items: {
        create: items.map((item) => ({
          productId: item.productId,
          qtyOrdered: item.quantity.toString(),
          unitCost: item.unitCost.toString(),
          taxRate: (totals.rates.get(item.productId) ?? ZERO).toString(),
        })),
      },
    },
    include: { items: true },
  });
}

/**
 * Envía la orden al proveedor por WhatsApp (o correo). Se encola con idempotencia: en una
 * cuenta demo queda SIMULATED y no sale ningún mensaje real.
 */
export async function dispatchOrderToSupplier(tx: TenantTx, orderId: string, intro?: string) {
  const order = await tx.purchaseOrder.findFirstOrThrow({
    where: { id: orderId },
    include: {
      supplier: true,
      items: { include: { product: { select: { sku: true, name: true } } } },
    },
  });
  const tenant = await tx.tenant.findFirstOrThrow({ select: { legalName: true, tradeName: true } });
  const channel = order.supplier.whatsapp
    ? ("WHATSAPP" as const)
    : order.supplier.email
      ? ("EMAIL" as const)
      : null;
  if (!channel)
    throw new ConflictError(
      "SUPPLIER_NO_CONTACT",
      "El proveedor no tiene WhatsApp ni correo configurado",
    );
  const body = buildOrderMessage({
    company: tenant.tradeName ?? tenant.legalName,
    orderNumber: order.number,
    ...(intro ? { intro } : {}),
    currency: order.currency,
    ...(order.conditions ? { conditions: order.conditions } : {}),
    lines: order.items.map((item) => ({
      sku: item.product.sku,
      name: item.product.name,
      quantity: Number(item.qtyOrdered),
      unitPrice: Number(item.unitCost),
    })),
  });
  const message = await enqueueOutbound(tx, {
    channel,
    toAddress: (channel === "WHATSAPP" ? order.supplier.whatsapp : order.supplier.email) ?? "",
    subject: `Pedido N.º ${order.number}`,
    body,
    idempotencyKey: `po-send:${order.id}`,
    relatedType: "purchase_order",
    relatedId: order.id,
  });
  const exists = await tx.supplierMessage.findFirst({
    where: { orderId: order.id, direction: "OUTBOUND" },
  });
  if (!exists) {
    await tx.supplierMessage.create({
      data: {
        supplierId: order.supplierId,
        orderId: order.id,
        direction: "OUTBOUND",
        channel,
        body,
        untrusted: false,
        simulated: message.status === "SIMULATED",
      },
    });
  }
  return { messageId: message.id, status: message.status, channel, body };
}

export async function createPurchaseOrder(
  actor: AuthUser,
  input: PurchaseOrderInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "purchasing:crear");
  requirePermission(actor, "purchasing:ver_costos_compra");
  const data = purchaseOrderSchema.parse(input);
  const tenantId = requireTenantId(actor);
  const run = () =>
    withTenant(tenantId, async (tx) => {
      const existing = await tx.purchaseOrder.findFirst({
        where: { idempotencyKey: data.idempotencyKey },
      });
      if (existing) return { id: existing.id, number: existing.number, replayed: true };
      const [supplier, warehouse] = await Promise.all([
        tx.supplier.findFirst({ where: { id: data.supplierId, isActive: true } }),
        tx.warehouse.findFirst({ where: { id: data.warehouseId, isActive: true } }),
      ]);
      if (!supplier) throw new NotFoundError("Proveedor");
      if (!warehouse) throw new NotFoundError("Almacén");
      const productIds = new Set(data.items.map((item) => item.productId));
      if (productIds.size !== data.items.length)
        throw new ConflictError("DUPLICATE_ITEMS", "Un producto aparece repetido en la orden");
      if (
        (await tx.product.count({ where: { id: { in: [...productIds] }, isStocked: true } })) !==
        productIds.size
      )
        throw new NotFoundError("Producto");

      const order = await insertPurchaseOrder(tx, {
        ...data,
        origin: "MANUAL",
        status: "DRAFT",
        createdById: actor.userId,
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "purchase.created",
        entityType: "purchase_order",
        entityId: order.id,
        after: { number: order.number, supplierId: data.supplierId, total: order.total.toString() },
      });
      return { id: order.id, number: order.number, replayed: false };
    });
  try {
    return await run();
  } catch (error) {
    if (isDuplicateKey(error)) return run();
    throw error;
  }
}

async function claimTransition(
  tx: TenantTx,
  orderId: string,
  to: "REQUESTED" | "QUOTED" | "IN_TRANSIT" | "CANCELLED",
  data: Prisma.PurchaseOrderUpdateManyMutationInput = {},
) {
  const order = await tx.purchaseOrder.findFirst({ where: { id: orderId } });
  if (!order) throw new NotFoundError("Orden de compra");
  if (!canTransition(order.status, to))
    throw new ConflictError("PO_STATE", `No se puede pasar de ${order.status} a ${to}`);
  const claimed = await tx.purchaseOrder.updateMany({
    where: { id: orderId, status: order.status },
    data: { status: to, ...data },
  });
  if (claimed.count !== 1)
    throw new ConflictError("PO_STATE", "La orden cambió de estado; vuelve a intentarlo");
  return order;
}

/** "Solicitar": la orden pasa a Solicitado y se envía al proveedor. */
export async function sendPurchaseOrder(actor: AuthUser, orderId: string, meta: RequestMeta = {}) {
  requirePermission(actor, "purchasing:editar");
  return withTenant(requireTenantId(actor), async (tx) => {
    await claimTransition(tx, orderId, "REQUESTED", {
      sentAt: new Date(),
      approvedById: actor.userId,
    });
    const sent = await dispatchOrderToSupplier(tx, orderId);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "purchase.sent",
      entityType: "purchase_order",
      entityId: orderId,
      after: { channel: sent.channel, delivery: sent.status },
    });
    return { delivery: sent.status };
  });
}

export async function markInTransit(
  actor: AuthUser,
  orderId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "purchasing:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    await claimTransition(tx, orderId, "IN_TRANSIT");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "purchase.in_transit",
      entityType: "purchase_order",
      entityId: orderId,
    });
  });
}

export async function cancelPurchaseOrder(
  actor: AuthUser,
  orderId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "purchasing:editar");
  if (reason.trim().length < 5)
    throw new ConflictError("REASON_REQUIRED", "Indica el motivo de la cancelación");
  await withTenant(requireTenantId(actor), async (tx) => {
    await claimTransition(tx, orderId, "CANCELLED");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "purchase.cancelled",
      entityType: "purchase_order",
      entityId: orderId,
      reason,
    });
  });
}

/**
 * Un humano acepta los precios cotizados por el proveedor (los mensajes del proveedor son datos
 * no confiables y NUNCA cambian precios por sí solos). Se registra antes/después en auditoría.
 */
export async function acceptQuote(
  actor: AuthUser,
  orderId: string,
  prices: Array<{ productId: string; unitCost: string }>,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "purchasing:editar");
  requirePermission(actor, "purchasing:ver_costos_compra");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await tx.purchaseOrder.findFirst({
      where: { id: orderId, status: { in: ["REQUESTED", "QUOTED", "IN_TRANSIT"] } },
      include: { items: true },
    });
    if (!order) throw new ConflictError("PO_STATE", "La orden no admite cambios de precio");
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (const price of prices) {
      const item = order.items.find((i) => i.productId === price.productId);
      if (!item) throw new NotFoundError("Producto de la orden");
      if (!/^\d{1,10}(\.\d{1,4})?$/.test(price.unitCost))
        throw new ConflictError("PRICE_INVALID", "Precio inválido");
      before[price.productId] = item.unitCost.toString();
      after[price.productId] = new Prisma.Decimal(price.unitCost).toString();
      await tx.purchaseOrderItem.update({
        where: { id: item.id },
        data: { unitCost: price.unitCost },
      });
    }
    const items = (await tx.purchaseOrderItem.findMany({ where: { orderId } })).map((i) => ({
      productId: i.productId,
      quantity: i.qtyOrdered,
      unitCost: i.unitCost,
    }));
    const totals = await computeTotals(tx, items);
    await tx.purchaseOrder.update({
      where: { id: orderId },
      data: {
        subtotal: totals.subtotal.toString(),
        taxTotal: totals.taxTotal.toString(),
        total: totals.total.toString(),
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "purchase.quote_accepted",
      entityType: "purchase_order",
      entityId: orderId,
      before,
      after,
    });
  });
}

/** Recepción contra la orden: ingresa al kardex, registra diferencias y avanza el estado. Idempotente. */
export async function receivePurchaseOrder(
  actor: AuthUser,
  input: ReceiveInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "purchasing:editar");
  requirePermission(actor, "inventory:crear");
  const data = receiveSchema.parse(input);
  const tenantId = requireTenantId(actor);

  const run = () =>
    withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('po:' || ${data.orderId}, 0))`;
      const previous = await tx.kardexMovement.findFirst({
        where: { idempotencyKey: { startsWith: `po-rcpt:${data.idempotencyKey}:` } },
      });
      if (previous?.referenceId)
        return {
          receiptId: previous.referenceId,
          status: (await tx.purchaseOrder.findFirstOrThrow({ where: { id: data.orderId } })).status,
          replayed: true,
          differences: [] as ReceiptDifference[],
        };

      const order = await tx.purchaseOrder.findFirst({
        where: { id: data.orderId },
        include: { items: true },
      });
      if (!order) throw new NotFoundError("Orden de compra");
      if (!OPEN_STATUSES.includes(order.status))
        throw new ConflictError("PO_STATE", "La orden no está abierta para recepción");

      const receipt = await tx.purchaseReceipt.create({
        data: {
          orderId: order.id,
          warehouseId: order.warehouseId,
          supplierDocRef: data.supplierDocRef ?? null,
          notes: data.notes ?? null,
          receivedById: actor.userId,
        },
      });
      const differences: ReceiptDifference[] = [];
      const lines = [...data.lines].sort((a, b) => a.orderItemId.localeCompare(b.orderItemId));
      const received = new Map<string, Prisma.Decimal>();

      for (const line of lines) {
        const item = order.items.find((i) => i.id === line.orderItemId);
        if (!item) throw new NotFoundError("Línea de la orden");
        const outstanding = item.qtyOrdered.minus(item.qtyReceived);
        const product = await tx.product.findFirstOrThrow({ where: { id: item.productId } });
        const quantity =
          product.trackingMode === "SERIAL"
            ? new Prisma.Decimal(line.serials?.length ?? 0)
            : new Prisma.Decimal(line.quantity ?? outstanding.toString());
        if (quantity.lte(0))
          throw new ConflictError("RECEIPT_EMPTY", `${product.name}: indica la cantidad recibida`);
        if (quantity.gt(outstanding.times("1.10")))
          throw new ConflictError(
            "RECEIPT_EXCESS",
            `${product.name}: no se puede recibir más del 10 % sobre lo pendiente (${outstanding.toString()})`,
          );

        const outcome = await applyMovement(tx, {
          warehouseId: order.warehouseId,
          productId: item.productId,
          type: "PURCHASE",
          quantity: product.trackingMode === "SERIAL" ? undefined : quantity.toString(),
          unitCost: item.unitCost.toString(),
          referenceType: "purchase_receipt",
          referenceId: receipt.id,
          idempotencyKey: `po-rcpt:${data.idempotencyKey}:${item.id}`,
          createdById: actor.userId,
          ...(line.lot ? { lot: line.lot } : {}),
          ...(line.serials ? { serials: line.serials } : {}),
        });
        const first = outcome.movements[0];
        await tx.purchaseReceiptItem.create({
          data: {
            receiptId: receipt.id,
            orderItemId: item.id,
            productId: item.productId,
            lotId: first?.lotId ?? null,
            serialId: first?.serialId ?? null,
            qtyExpected: outstanding.toString(),
            qtyReceived: quantity.toString(),
            difference: quantity.minus(outstanding).toString(),
            unitCost: item.unitCost.toString(),
            kardexMovementId: first?.id ?? null,
            notes: line.notes ?? null,
          },
        });
        await tx.purchaseOrderItem.update({
          where: { id: item.id },
          data: { qtyReceived: item.qtyReceived.plus(quantity).toString() },
        });
        received.set(item.id, quantity);
        await tx.product.update({
          where: { id: item.productId },
          data: { lastPurchaseCost: item.unitCost.toString() },
        });
        await syncSupplierPrice(tx, order.supplierId, item.productId, item.unitCost);
        if (!quantity.eq(outstanding))
          differences.push({
            productId: item.productId,
            expected: outstanding.toString(),
            received: quantity.toString(),
            difference: quantity.minus(outstanding).toString(),
          });
      }

      const items = await tx.purchaseOrderItem.findMany({ where: { orderId: order.id } });
      const complete = items.every((item) => item.qtyReceived.gte(item.qtyOrdered));
      const status = complete ? "RECEIVED" : "PARTIALLY_RECEIVED";
      await tx.purchaseOrder.update({
        where: { id: order.id },
        data: { status, ...(complete ? { receivedAt: new Date() } : {}) },
      });
      if (differences.length > 0) {
        await tx.notification.createMany({
          data: [
            {
              kind: "purchase.difference",
              severity: "WARNING",
              title: `Diferencias en la recepción de la orden #${order.number}`,
              body: `${differences.length} línea(s) no coinciden con lo pedido.`,
              data: {
                orderId: order.id,
                receiptId: receipt.id,
                differences: differences.map((d) => ({ ...d })),
              },
              dedupeKey: `po-diff:${receipt.id}`,
            },
          ],
          skipDuplicates: true,
        });
      }
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "purchase.received",
        entityType: "purchase_order",
        entityId: order.id,
        after: {
          number: order.number,
          status,
          receiptId: receipt.id,
          differences: differences.map((d) => ({ ...d })),
        },
      });
      return { receiptId: receipt.id, status, replayed: false, differences };
    });

  try {
    return await run();
  } catch (error) {
    if (isDuplicateKey(error)) return run();
    throw error;
  }
}

export interface ReceiptDifference {
  productId: string;
  expected: string;
  received: string;
  difference: string;
}

/** Último precio del proveedor y su historial, a partir de lo realmente recibido. */
async function syncSupplierPrice(
  tx: TenantTx,
  supplierId: string,
  productId: string,
  price: Prisma.Decimal,
): Promise<void> {
  const link = await tx.supplierProduct.findFirst({ where: { supplierId, productId } });
  if (!link) return;
  if (link.lastPrice?.eq(price)) return;
  await tx.supplierProduct.update({
    where: { id: link.id },
    data: { lastPrice: price.toString(), lastPriceAt: new Date() },
  });
  await tx.supplierPriceHistory.create({
    data: {
      supplierProductId: link.id,
      price: price.toString(),
      currency: link.currency,
      source: "PURCHASE_ORDER",
    },
  });
}

/** Devolución a proveedor: sale del stock (RETURN_SUPPLIER) con motivo y queda auditada. */
export async function createSupplierReturn(
  actor: AuthUser,
  input: SupplierReturnInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "purchasing:crear");
  requirePermission(actor, "inventory:editar");
  const data = supplierReturnSchema.parse(input);
  const tenantId = requireTenantId(actor);

  const run = () =>
    withTenant(tenantId, async (tx) => {
      // Serializa por clave: sin esto, peticiones simultáneas crearían varios registros de devolución
      // (el kardex ya es idempotente, pero la cabecera de la devolución no lo era).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sret:' || app_current_tenant()::text || ${data.idempotencyKey}, 0))`;
      const previous = await tx.kardexMovement.findFirst({
        where: { idempotencyKey: { startsWith: `sret:${data.idempotencyKey}:` } },
      });
      if (previous?.referenceId) {
        const existing = await tx.supplierReturn.findFirstOrThrow({
          where: { id: previous.referenceId },
        });
        return { id: existing.id, number: existing.number, replayed: true };
      }
      const [supplier, warehouse] = await Promise.all([
        tx.supplier.findFirst({ where: { id: data.supplierId } }),
        tx.warehouse.findFirst({ where: { id: data.warehouseId, isActive: true } }),
      ]);
      if (!supplier) throw new NotFoundError("Proveedor");
      if (!warehouse) throw new NotFoundError("Almacén");
      const number = await nextSequence(tx, "SR");
      const ret = await tx.supplierReturn.create({
        data: {
          number,
          supplierId: data.supplierId,
          warehouseId: data.warehouseId,
          orderId: data.orderId ?? null,
          reason: data.reason,
          createdById: actor.userId,
        },
      });

      const requests = data.items.map((item, index) => ({
        warehouseId: data.warehouseId,
        productId: item.productId,
        type: "RETURN_SUPPLIER" as const,
        quantity: item.quantity,
        reason: data.reason,
        referenceType: "supplier_return",
        referenceId: ret.id,
        idempotencyKey: `sret:${data.idempotencyKey}:${index}`,
        createdById: actor.userId,
        ...(item.lotId ? { lotId: item.lotId } : {}),
        ...(item.serials ? { serials: item.serials } : {}),
      }));
      const outcomes = await applyMovements(tx, requests);
      for (const outcome of outcomes) {
        for (const movement of outcome.movements) {
          await tx.supplierReturnItem.create({
            data: {
              returnId: ret.id,
              productId: movement.productId,
              quantity: new Prisma.Decimal(movement.quantityDelta).abs().toString(),
              unitCost: movement.unitCost ?? "0",
              kardexMovementId: movement.id,
            },
          });
        }
      }
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "supplier.return_created",
        entityType: "supplier_return",
        entityId: ret.id,
        after: { number, supplierId: data.supplierId, items: data.items.length },
        reason: data.reason,
      });
      return { id: ret.id, number, replayed: false };
    });
  try {
    return await run();
  } catch (error) {
    if (isDuplicateKey(error)) return run();
    throw error;
  }
}

export async function listPurchaseOrders(
  actor: AuthUser,
  filter: { status?: Prisma.PurchaseOrderWhereInput["status"] } = {},
) {
  requirePermission(actor, "purchasing:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const rows = await withTenant(requireTenantId(actor), (tx) =>
    tx.purchaseOrder.findMany({
      where: { ...(filter.status ? { status: filter.status } : {}) },
      include: {
        supplier: { select: { name: true } },
        items: { include: { product: { select: { sku: true, name: true } } } },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
  return rows.map((order) => ({
    id: order.id,
    number: order.number,
    status: order.status,
    origin: order.origin,
    supplier: order.supplier.name,
    supplierId: order.supplierId,
    createdAt: order.createdAt,
    sentAt: order.sentAt,
    receivedAt: order.receivedAt,
    ...(canSeeCost
      ? {
          subtotal: order.subtotal.toString(),
          taxTotal: order.taxTotal.toString(),
          total: order.total.toString(),
        }
      : {}),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      sku: item.product.sku,
      name: item.product.name,
      qtyOrdered: item.qtyOrdered.toString(),
      qtyReceived: item.qtyReceived.toString(),
      ...(canSeeCost ? { unitCost: item.unitCost.toString() } : {}),
    })),
  }));
}

export type { AuditContext };
