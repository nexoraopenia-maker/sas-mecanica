import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, nextSequence, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { countEntrySchema, openCountSchema, type OpenCountInput } from "@/lib/validation/inventory";
import { type z } from "zod";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { applyMovement } from "./inventory";

/**
 * Abre un conteo físico (cíclico o general). Crea una línea por producto —o por
 * lote en llantas— con el saldo del sistema como referencia.
 */
export async function openCount(actor: AuthUser, input: OpenCountInput, meta: RequestMeta = {}) {
  requirePermission(actor, "inventory:editar");
  const data = openCountSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.warehouse.findFirst({ where: { id: data.warehouseId, isActive: true } })))
      throw new NotFoundError("Almacén");
    const balances = await tx.stockBalance.findMany({
      where: {
        warehouseId: data.warehouseId,
        product: { isStocked: true },
        ...(data.productIds ? { productId: { in: data.productIds } } : {}),
      },
      include: { product: { select: { trackingMode: true } } },
    });
    if (balances.length === 0)
      throw new ConflictError("COUNT_EMPTY", "No hay productos con existencias para contar");

    const items: Prisma.InventoryCountItemUncheckedCreateWithoutCountInput[] = [];
    for (const balance of balances) {
      if (balance.product.trackingMode === "LOT") {
        const lots = await tx.stockLotBalance.findMany({
          where: { warehouseId: data.warehouseId, productId: balance.productId },
        });
        for (const lot of lots)
          items.push({
            productId: balance.productId,
            lotId: lot.lotId,
            systemQty: lot.quantity.toString(),
          });
      } else {
        items.push({ productId: balance.productId, systemQty: balance.quantity.toString() });
      }
    }
    const number = await nextSequence(tx, "IC");
    const count = await tx.inventoryCount.create({
      data: {
        number,
        warehouseId: data.warehouseId,
        cyclic: data.cyclic,
        notes: data.notes ?? null,
        createdById: actor.userId,
        items: { create: items },
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "count.opened",
      entityType: "inventory_count",
      entityId: count.id,
      after: { number, items: items.length, cyclic: data.cyclic },
    });
    return { id: count.id, number, items: items.length };
  });
}

/**
 * Registra lo contado. El saldo de referencia se vuelve a leer en este momento:
 * así las ventas ocurridas antes del conteo no se confunden con faltantes.
 */
export async function recordCount(
  actor: AuthUser,
  input: z.input<typeof countEntrySchema>,
): Promise<{ difference: string }> {
  requirePermission(actor, "inventory:editar");
  const data = countEntrySchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const count = await tx.inventoryCount.findFirst({
      where: { id: data.countId, status: "OPEN" },
    });
    if (!count) throw new ConflictError("COUNT_STATE", "El conteo no está abierto");
    const item = await tx.inventoryCountItem.findFirst({
      where: { id: data.itemId, countId: count.id },
    });
    if (!item) throw new NotFoundError("Línea de conteo");
    const current = item.lotId
      ? await tx.stockLotBalance.findFirst({
          where: { warehouseId: count.warehouseId, productId: item.productId, lotId: item.lotId },
        })
      : await tx.stockBalance.findFirst({
          where: { warehouseId: count.warehouseId, productId: item.productId },
        });
    const system = new Prisma.Decimal(current?.quantity.toString() ?? 0);
    await tx.inventoryCountItem.update({
      where: { id: item.id },
      data: { systemQty: system.toString(), countedQty: data.countedQty },
    });
    return { difference: new Prisma.Decimal(data.countedQty).minus(system).toString() };
  });
}

export async function closeCount(actor: AuthUser, countId: string): Promise<void> {
  requirePermission(actor, "inventory:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const counted = await tx.inventoryCountItem.count({
      where: { countId, countedQty: { not: null } },
    });
    if (counted === 0)
      throw new ConflictError("COUNT_EMPTY", "Registra al menos una línea contada antes de cerrar");
    const result = await tx.inventoryCount.updateMany({
      where: { id: countId, status: "OPEN" },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    if (result.count !== 1) throw new ConflictError("COUNT_STATE", "El conteo no está abierto");
  });
}

export interface CountApplyResult {
  adjusted: number;
  unitsIn: string;
  unitsOut: string;
  /** Productos con serie: la diferencia exige un ajuste indicando qué series faltan o sobran. */
  skippedSerial: string[];
}

/**
 * Aplica las diferencias como ajustes auditados (COUNT_ADJUSTMENT_IN/OUT) con el
 * motivo "Conteo físico #n". Idempotente por línea; el conteo queda APPLIED.
 */
export async function applyCount(
  actor: AuthUser,
  countId: string,
  meta: RequestMeta = {},
): Promise<CountApplyResult> {
  requirePermission(actor, "inventory:editar");
  return withTenant(requireTenantId(actor), async (tx) => {
    const claimed = await tx.inventoryCount.updateMany({
      where: { id: countId, status: "CLOSED" },
      data: { status: "APPLIED", appliedAt: new Date() },
    });
    if (claimed.count !== 1)
      throw new ConflictError("COUNT_STATE", "Cierra el conteo antes de aplicarlo");
    const count = await tx.inventoryCount.findFirstOrThrow({
      where: { id: countId },
      include: { items: true },
    });

    let unitsIn = new Prisma.Decimal(0);
    let unitsOut = new Prisma.Decimal(0);
    let adjusted = 0;
    const skippedSerial: string[] = [];
    const items = [...count.items].sort(
      (a, b) => a.productId.localeCompare(b.productId) || a.id.localeCompare(b.id),
    );
    for (const item of items) {
      if (item.countedQty === null) continue;
      const difference = item.countedQty.minus(item.systemQty);
      if (difference.eq(0)) continue;
      const product = await tx.product.findFirst({
        where: { id: item.productId },
        select: { sku: true, trackingMode: true },
      });
      if (!product) continue;
      if (product.trackingMode === "SERIAL") {
        skippedSerial.push(product.sku);
        continue;
      }
      const inbound = difference.gt(0);
      const outcome = await applyMovement(tx, {
        warehouseId: count.warehouseId,
        productId: item.productId,
        type: inbound ? "COUNT_ADJUSTMENT_IN" : "COUNT_ADJUSTMENT_OUT",
        quantity: difference.abs().toString(),
        reason: `Conteo físico #${count.number}`,
        referenceType: "inventory_count",
        referenceId: count.id,
        idempotencyKey: `count:${count.id}:${item.id}`,
        createdById: actor.userId,
        ...(item.lotId ? { lotId: item.lotId } : {}),
      });
      await tx.inventoryCountItem.update({
        where: { id: item.id },
        data: { adjustmentMovementId: outcome.movements[0]?.id ?? null },
      });
      adjusted += 1;
      if (inbound) unitsIn = unitsIn.plus(difference);
      else unitsOut = unitsOut.plus(difference.abs());
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "count.applied",
      entityType: "inventory_count",
      entityId: count.id,
      after: {
        number: count.number,
        adjusted,
        unitsIn: unitsIn.toString(),
        unitsOut: unitsOut.toString(),
        skippedSerial,
      },
      reason: `Conteo físico #${count.number}`,
    });
    return { adjusted, unitsIn: unitsIn.toString(), unitsOut: unitsOut.toString(), skippedSerial };
  });
}
