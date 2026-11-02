import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, nextSequence, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  transferReceiveSchema,
  transferRequestSchema,
  type TransferRequestInput,
} from "@/lib/validation/inventory";
import { type z } from "zod";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { applyMovement } from "./inventory";

/** Solicita una transferencia entre almacenes (no mueve stock todavía). */
export async function requestTransfer(
  actor: AuthUser,
  input: TransferRequestInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "inventory:crear");
  const data = transferRequestSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const warehouses = await tx.warehouse.findMany({
      where: { id: { in: [data.fromWarehouseId, data.toWarehouseId] }, isActive: true },
    });
    if (warehouses.length !== 2) throw new NotFoundError("Almacén");

    const rows: Prisma.StockTransferItemUncheckedCreateWithoutTransferInput[] = [];
    for (const item of data.items) {
      const product = await tx.product.findFirst({
        where: { id: item.productId, isStocked: true },
      });
      if (!product) throw new NotFoundError("Producto");
      if (product.trackingMode === "SERIAL") {
        if (!item.serials?.length)
          throw new ConflictError(
            "SERIAL_REQUIRED",
            `${product.name}: indica las series a transferir`,
          );
        for (const serial of item.serials) {
          const found = await tx.serialNumber.findFirst({
            where: {
              productId: product.id,
              serial,
              status: "IN_STOCK",
              warehouseId: data.fromWarehouseId,
            },
          });
          if (!found)
            throw new ConflictError(
              "SERIAL_UNAVAILABLE",
              `La serie ${serial} no está disponible en el almacén de origen`,
            );
          rows.push({ productId: product.id, serialId: found.id, qtyRequested: "1" });
        }
      } else {
        if (!item.quantity)
          throw new ConflictError("QUANTITY_REQUIRED", `${product.name}: indica la cantidad`);
        rows.push({
          productId: product.id,
          lotId: item.lotId ?? null,
          qtyRequested: item.quantity,
        });
      }
    }
    const number = await nextSequence(tx, "TR");
    const transfer = await tx.stockTransfer.create({
      data: {
        number,
        fromWarehouseId: data.fromWarehouseId,
        toWarehouseId: data.toWarehouseId,
        notes: data.notes ?? null,
        requestedById: actor.userId,
        items: { create: rows },
      },
      include: { items: true },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "transfer.requested",
      entityType: "stock_transfer",
      entityId: transfer.id,
      after: { number, from: data.fromWarehouseId, to: data.toWarehouseId, items: rows.length },
    });
    return { id: transfer.id, number };
  });
}

/**
 * Despacha: descuenta el stock del origen (TRANSFER_OUT, con FEFO en lotes) y la
 * mercadería queda "en tránsito" hasta que el destino la reciba. El cambio de
 * estado condicional impide despachar dos veces.
 */
export async function shipTransfer(actor: AuthUser, transferId: string, meta: RequestMeta = {}) {
  requirePermission(actor, "inventory:editar");
  return withTenant(requireTenantId(actor), async (tx) => {
    const claimed = await tx.stockTransfer.updateMany({
      where: { id: transferId, status: "REQUESTED" },
      data: { status: "IN_TRANSIT", shippedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ConflictError("TRANSFER_STATE", "La transferencia no está en estado Solicitada");
    const transfer = await tx.stockTransfer.findFirstOrThrow({
      where: { id: transferId },
      include: { items: true },
    });

    const items = [...transfer.items].sort(
      (a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id),
    );
    let shippedLines = 0;
    for (const item of items) {
      const serial = item.serialId
        ? await tx.serialNumber.findFirst({ where: { id: item.serialId } })
        : null;
      const outcome = await applyMovement(tx, {
        warehouseId: transfer.fromWarehouseId,
        productId: item.productId,
        type: "TRANSFER_OUT",
        quantity: serial ? undefined : item.qtyRequested.toString(),
        referenceType: "transfer",
        referenceId: transfer.id,
        idempotencyKey: `transfer:${transfer.id}:out:${item.id}`,
        createdById: actor.userId,
        ...(item.lotId ? { lotId: item.lotId } : {}),
        ...(serial ? { serials: [serial.serial] } : {}),
      });
      const [first, ...extra] = outcome.movements;
      if (!first) continue;
      await tx.stockTransferItem.update({
        where: { id: item.id },
        data: {
          lotId: first.lotId,
          qtyShipped: new Prisma.Decimal(first.quantityDelta).abs().toString(),
        },
      });
      // Un reparto FEFO en varios lotes genera una fila por lote.
      for (const movement of extra) {
        await tx.stockTransferItem.create({
          data: {
            transferId: transfer.id,
            productId: item.productId,
            lotId: movement.lotId,
            qtyRequested: new Prisma.Decimal(movement.quantityDelta).abs().toString(),
            qtyShipped: new Prisma.Decimal(movement.quantityDelta).abs().toString(),
          },
        });
      }
      shippedLines += outcome.movements.length;
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "transfer.shipped",
      entityType: "stock_transfer",
      entityId: transfer.id,
      after: { number: transfer.number, lines: shippedLines },
    });
    return { id: transfer.id, number: transfer.number, lines: shippedLines };
  });
}

/**
 * Recepción en el destino (TRANSFER_IN al costo con que salió). Si llega menos
 * de lo despachado, la diferencia queda registrada y se notifica como crítica.
 */
export async function receiveTransfer(
  actor: AuthUser,
  input: z.input<typeof transferReceiveSchema>,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "inventory:editar");
  const data = transferReceiveSchema.parse(input);
  const overrides = new Map((data.received ?? []).map((entry) => [entry.itemId, entry.quantity]));

  return withTenant(requireTenantId(actor), async (tx) => {
    const claimed = await tx.stockTransfer.updateMany({
      where: { id: data.transferId, status: "IN_TRANSIT" },
      data: { status: "RECEIVED", receivedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ConflictError("TRANSFER_STATE", "La transferencia no está En tránsito");
    const transfer = await tx.stockTransfer.findFirstOrThrow({
      where: { id: data.transferId },
      include: { items: true },
    });
    const outMovements = await tx.kardexMovement.findMany({
      where: { referenceType: "transfer", referenceId: transfer.id, type: "TRANSFER_OUT" },
    });

    let missing = new Prisma.Decimal(0);
    const items = [...transfer.items].sort(
      (a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id),
    );
    for (const item of items) {
      const received = new Prisma.Decimal(overrides.get(item.id) ?? item.qtyShipped.toString());
      if (received.gt(item.qtyShipped))
        throw new ConflictError("TRANSFER_EXCESS", "No puedes recibir más de lo despachado");
      missing = missing.plus(item.qtyShipped.minus(received));
      await tx.stockTransferItem.update({
        where: { id: item.id },
        data: { qtyReceived: received.toString() },
      });
      if (received.lte(0)) continue;

      const out = outMovements.find(
        (m) =>
          m.productId === item.productId && m.lotId === item.lotId && m.serialId === item.serialId,
      );
      const serial = item.serialId
        ? await tx.serialNumber.findFirst({ where: { id: item.serialId } })
        : null;
      await applyMovement(tx, {
        warehouseId: transfer.toWarehouseId,
        productId: item.productId,
        type: "TRANSFER_IN",
        quantity: serial ? undefined : received.toString(),
        unitCost: out?.unitCost?.toString(),
        referenceType: "transfer",
        referenceId: transfer.id,
        idempotencyKey: `transfer:${transfer.id}:in:${item.id}`,
        createdById: actor.userId,
        ...(item.lotId ? { lotId: item.lotId } : {}),
        ...(serial ? { serials: [serial.serial] } : {}),
      });
    }
    if (missing.gt(0)) {
      await tx.notification.createMany({
        data: [
          {
            kind: "transfer.difference",
            severity: "CRITICAL",
            title: `Diferencia en la transferencia #${transfer.number}`,
            body: `Se despacharon más unidades de las recibidas (faltan ${missing.toString()}). Revisa y ajusta si corresponde.`,
            data: { transferId: transfer.id, missing: missing.toString() },
            dedupeKey: `transfer-diff:${transfer.id}`,
          },
        ],
        skipDuplicates: true,
      });
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "transfer.received",
      entityType: "stock_transfer",
      entityId: transfer.id,
      after: { number: transfer.number, missing: missing.toString() },
    });
    return { id: transfer.id, number: transfer.number, missing: missing.toString() };
  });
}

/** Cancela una transferencia que aún no se despachó. */
export async function cancelTransfer(
  actor: AuthUser,
  transferId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "inventory:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const result = await tx.stockTransfer.updateMany({
      where: { id: transferId, status: "REQUESTED" },
      data: { status: "CANCELLED" },
    });
    if (result.count !== 1)
      throw new ConflictError(
        "TRANSFER_STATE",
        "Solo se pueden cancelar transferencias Solicitadas",
      );
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "transfer.cancelled",
      entityType: "stock_transfer",
      entityId: transferId,
    });
  });
}

export async function listTransfers(actor: AuthUser) {
  requirePermission(actor, "inventory:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.stockTransfer.findMany({
      include: {
        fromWarehouse: { select: { name: true } },
        toWarehouse: { select: { name: true } },
        items: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  );
}
