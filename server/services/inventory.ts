import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, withTenant, type MovementType, type TenantTx } from "@/lib/db";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import { parseDot } from "@/lib/inventory/tire";
import {
  adjustmentSchema,
  stockInSchema,
  type AdjustmentInput,
  type StockInInput,
} from "@/lib/validation/inventory";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { evaluateStockAlert } from "./stock-alerts";

const INBOUND: ReadonlySet<MovementType> = new Set<MovementType>([
  "INITIAL",
  "PURCHASE",
  "ADJUSTMENT_IN",
  "COUNT_ADJUSTMENT_IN",
  "TRANSFER_IN",
  "RETURN_CUSTOMER",
  "WORK_ORDER_RETURN",
  "SALE_VOID",
]);

/** Tipos que dan de alta series nuevas; el resto exige que la serie ya exista. */
const CREATES_SERIALS: ReadonlySet<MovementType> = new Set<MovementType>([
  "INITIAL",
  "PURCHASE",
  "ADJUSTMENT_IN",
  "COUNT_ADJUSTMENT_IN",
]);
const SERIAL_RETURN_FROM: ReadonlySet<MovementType> = new Set<MovementType>([
  "RETURN_CUSTOMER",
  "WORK_ORDER_RETURN",
  "SALE_VOID",
]);

const SERIAL_STATUS_OUT: Partial<
  Record<MovementType, "SOLD" | "INSTALLED" | "SCRAP" | "RETURNED_TO_SUPPLIER" | "IN_TRANSIT">
> = {
  SALE: "SOLD",
  WORK_ORDER_CONSUMPTION: "INSTALLED",
  ADJUSTMENT_OUT: "SCRAP",
  COUNT_ADJUSTMENT_OUT: "SCRAP",
  RETURN_SUPPLIER: "RETURNED_TO_SUPPLIER",
  TRANSFER_OUT: "IN_TRANSIT",
};

export const isInbound = (type: MovementType): boolean => INBOUND.has(type);

export interface MovementRequest {
  warehouseId: string;
  productId: string;
  type: MovementType;
  /** Siempre positiva; el signo lo da el tipo. En productos con serie se deduce de `serials`. */
  quantity?: string;
  unitCost?: string;
  reason?: string;
  referenceType?: string;
  referenceId?: string;
  idempotencyKey: string;
  /** El llamador ya verificó `inventory:permitir_stock_negativo` y el ajuste del tenant. */
  allowNegative?: boolean;
  createdById?: string | null;
  lot?: { code: string; dotCode?: string | undefined };
  lotId?: string;
  serials?: string[];
}

export interface AppliedMovement {
  id: string;
  productId: string;
  warehouseId: string;
  lotId: string | null;
  serialId: string | null;
  quantityDelta: string;
  unitCost: string | null;
  balanceAfter: string;
  avgCostAfter: string;
}

export interface MovementOutcome {
  movements: AppliedMovement[];
  /** true si la clave de idempotencia ya existía: no se aplicó nada nuevo. */
  replayed: boolean;
}

interface Line {
  lotId: string | null;
  serialId: string | null;
  quantity: Prisma.Decimal;
}

const toApplied = (row: {
  id: string;
  productId: string;
  warehouseId: string;
  lotId: string | null;
  serialId: string | null;
  quantityDelta: Prisma.Decimal;
  unitCost: Prisma.Decimal | null;
  balanceAfter: Prisma.Decimal;
  avgCostAfter: Prisma.Decimal;
}): AppliedMovement => ({
  id: row.id,
  productId: row.productId,
  warehouseId: row.warehouseId,
  lotId: row.lotId,
  serialId: row.serialId,
  quantityDelta: row.quantityDelta.toString(),
  unitCost: row.unitCost?.toString() ?? null,
  balanceAfter: row.balanceAfter.toString(),
  avgCostAfter: row.avgCostAfter.toString(),
});

async function findReplay(tx: TenantTx, req: MovementRequest): Promise<MovementOutcome | null> {
  const rows = await tx.kardexMovement.findMany({
    where: {
      OR: [
        { idempotencyKey: req.idempotencyKey },
        { idempotencyKey: { startsWith: `${req.idempotencyKey}#` } },
      ],
    },
    orderBy: { idempotencyKey: "asc" },
  });
  if (rows.length === 0) return null;
  if (
    rows.some(
      (row) =>
        row.productId !== req.productId ||
        row.warehouseId !== req.warehouseId ||
        row.type !== req.type,
    )
  ) {
    throw new ConflictError(
      "IDEMPOTENCY_MISMATCH",
      "La clave de idempotencia ya se usó con otra operación distinta",
    );
  }
  return { movements: rows.map(toApplied), replayed: true };
}

/** Serializa las operaciones de un producto en un almacén (necesario para repartir lotes sin carreras). */
async function lockProduct(tx: TenantTx, warehouseId: string, productId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(app_current_tenant()::text || ${warehouseId} || ${productId}, 0))`;
}

async function resolveLot(
  tx: TenantTx,
  productId: string,
  lot: { code: string; dotCode?: string | undefined },
  unitCost: string | undefined,
) {
  const existing = await tx.stockLot.findFirst({ where: { productId, code: lot.code } });
  if (existing) return existing;
  const parsed = lot.dotCode ? parseDot(lot.dotCode) : null;
  if (lot.dotCode && !parsed)
    throw new ConflictError("DOT_INVALID", `DOT inválido: ${lot.dotCode}`);
  return tx.stockLot.create({
    data: {
      productId,
      code: lot.code,
      dotCode: lot.dotCode ?? null,
      manufacturedAt: parsed?.manufacturedAt ?? null,
      unitCost: unitCost ?? null,
    },
  });
}

/** Reparto FEFO: primero el lote más antiguo (fabricación; luego recepción). */
async function allocateFefo(
  tx: TenantTx,
  warehouseId: string,
  productId: string,
  quantity: Prisma.Decimal,
  allowNegative: boolean,
): Promise<Line[]> {
  const balances = await tx.stockLotBalance.findMany({
    where: { warehouseId, productId, quantity: { gt: 0 } },
    include: { lot: true },
  });
  balances.sort((a, b) => {
    const am = a.lot.manufacturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bm = b.lot.manufacturedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return (
      am - bm ||
      a.lot.receivedAt.getTime() - b.lot.receivedAt.getTime() ||
      a.lotId.localeCompare(b.lotId)
    );
  });
  const lines: Line[] = [];
  let remaining = quantity;
  for (const balance of balances) {
    if (remaining.lte(0)) break;
    const take = Prisma.Decimal.min(balance.quantity, remaining);
    lines.push({ lotId: balance.lotId, serialId: null, quantity: take });
    remaining = remaining.minus(take);
  }
  if (remaining.gt(0)) {
    if (!allowNegative || lines.length === 0) {
      throw new InsufficientStockError(
        `Stock insuficiente en lotes: faltan ${remaining.toString()} unidades`,
        { productId, warehouseId, missing: remaining.toString() },
      );
    }
    // Con permiso de negativo, el resto sale del último lote.
    const last = lines[lines.length - 1];
    if (last) last.quantity = last.quantity.plus(remaining);
  }
  return lines;
}

async function planLines(
  tx: TenantTx,
  req: MovementRequest,
  product: { trackingMode: "NONE" | "LOT" | "SERIAL" },
): Promise<Line[]> {
  const inbound = isInbound(req.type);
  const quantity = req.quantity !== undefined ? new Prisma.Decimal(req.quantity) : null;

  if (product.trackingMode === "SERIAL") {
    const serials = [...new Set(req.serials ?? [])];
    if (serials.length === 0)
      throw new ConflictError(
        "SERIAL_REQUIRED",
        "Este producto se controla por número de serie: indica las series",
      );
    if (req.lot || req.lotId)
      throw new ConflictError("LOT_NOT_ALLOWED", "Este producto no usa lotes");
    if (quantity !== null && !quantity.eq(serials.length))
      throw new ConflictError(
        "SERIAL_QTY_MISMATCH",
        "La cantidad no coincide con el número de series",
      );
    const lines: Line[] = [];
    for (const serial of serials) {
      const existing = await tx.serialNumber.findFirst({
        where: { productId: req.productId, serial },
      });
      if (inbound && CREATES_SERIALS.has(req.type)) {
        if (existing)
          throw new ConflictError("SERIAL_EXISTS", `La serie ${serial} ya está registrada`);
        const created = await tx.serialNumber.create({
          data: {
            productId: req.productId,
            serial,
            warehouseId: req.warehouseId,
            status: "IN_STOCK",
          },
        });
        lines.push({ lotId: null, serialId: created.id, quantity: new Prisma.Decimal(1) });
      } else {
        if (!existing) throw new NotFoundError(`Serie ${serial}`);
        lines.push({ lotId: null, serialId: existing.id, quantity: new Prisma.Decimal(1) });
      }
    }
    return lines;
  }

  if (req.serials?.length)
    throw new ConflictError(
      "SERIAL_NOT_ALLOWED",
      "Este producto no se controla por número de serie",
    );
  if (quantity === null || quantity.lte(0))
    throw new ConflictError("QUANTITY_REQUIRED", "Indica una cantidad mayor que 0");

  if (product.trackingMode === "LOT") {
    if (inbound) {
      const lot = req.lotId
        ? await tx.stockLot.findFirst({ where: { id: req.lotId, productId: req.productId } })
        : req.lot
          ? await resolveLot(tx, req.productId, req.lot, req.unitCost)
          : null;
      if (!lot)
        throw new ConflictError(
          "LOT_REQUIRED",
          "Este producto se controla por lote: indica el lote (y el DOT en llantas)",
        );
      return [{ lotId: lot.id, serialId: null, quantity }];
    }
    if (req.lotId) {
      if (!(await tx.stockLot.findFirst({ where: { id: req.lotId, productId: req.productId } })))
        throw new NotFoundError("Lote");
      return [{ lotId: req.lotId, serialId: null, quantity }];
    }
    return allocateFefo(tx, req.warehouseId, req.productId, quantity, req.allowNegative === true);
  }

  if (req.lot || req.lotId)
    throw new ConflictError("LOT_NOT_ALLOWED", "Este producto no usa lotes");
  return [{ lotId: null, serialId: null, quantity }];
}

/** Marca la serie según el movimiento. El UPDATE condicional impide vender dos veces la misma serie. */
async function moveSerial(tx: TenantTx, req: MovementRequest, serialId: string): Promise<void> {
  if (isInbound(req.type)) {
    if (CREATES_SERIALS.has(req.type)) return; // ya nació IN_STOCK
    const from = SERIAL_RETURN_FROM.has(req.type) ? ["SOLD", "INSTALLED"] : ["IN_TRANSIT"];
    const updated = await tx.serialNumber.updateMany({
      where: { id: serialId, status: { in: from as Array<"SOLD" | "INSTALLED" | "IN_TRANSIT"> } },
      data: { status: "IN_STOCK", warehouseId: req.warehouseId, soldAt: null },
    });
    if (updated.count !== 1)
      throw new ConflictError(
        "SERIAL_STATE",
        "La serie no está en un estado que permita este ingreso",
      );
    return;
  }
  const next = SERIAL_STATUS_OUT[req.type];
  if (!next)
    throw new ConflictError(
      "SERIAL_STATE",
      `Tipo de movimiento no admitido para series: ${req.type}`,
    );
  const updated = await tx.serialNumber.updateMany({
    where: { id: serialId, status: "IN_STOCK", warehouseId: req.warehouseId },
    data: {
      status: next,
      ...(next === "SOLD" || next === "INSTALLED" ? { soldAt: new Date() } : {}),
    },
  });
  if (updated.count !== 1)
    throw new ConflictError("SERIAL_UNAVAILABLE", "La serie ya no está disponible en este almacén");
}

/**
 * ÚNICO camino para mover stock. Dentro de la transacción del llamador:
 * valida producto/almacén/lote/serie, reparte lotes (FEFO), inserta en el
 * kardex (el trigger actualiza saldos y costo promedio con bloqueo de fila y
 * rechaza el saldo negativo) y evalúa la alerta. NO verifica permisos: eso es
 * responsabilidad de quien lo invoca (los servicios públicos de abajo, ventas, OT...).
 */
export async function applyMovement(tx: TenantTx, req: MovementRequest): Promise<MovementOutcome> {
  // El lock va primero: si otra petición con la misma clave está en curso, esperamos su commit
  // y entonces la comprobación de idempotencia ya ve su movimiento.
  await lockProduct(tx, req.warehouseId, req.productId);
  const replay = await findReplay(tx, req);
  if (replay) return replay;

  const [product, warehouse] = await Promise.all([
    tx.product.findFirst({ where: { id: req.productId } }),
    tx.warehouse.findFirst({ where: { id: req.warehouseId, isActive: true } }),
  ]);
  if (!product) throw new NotFoundError("Producto");
  if (!warehouse) throw new NotFoundError("Almacén");
  if (!product.isStocked)
    throw new ConflictError("NOT_STOCKED", "Este producto es un servicio y no maneja stock");

  const lines = await planLines(tx, req, product);
  const sign = isInbound(req.type) ? 1 : -1;
  const applied: AppliedMovement[] = [];

  for (const [index, line] of lines.entries()) {
    // La serie se reclama antes de tocar el kardex: dos ventas de la misma serie no pueden coexistir.
    if (line.serialId) await moveSerial(tx, req, line.serialId);
    const row = await tx.kardexMovement.create({
      data: {
        warehouseId: req.warehouseId,
        productId: req.productId,
        lotId: line.lotId,
        serialId: line.serialId,
        type: req.type,
        quantityDelta: line.quantity.times(sign).toString(),
        unitCost: req.unitCost ?? null,
        reason: req.reason ?? null,
        referenceType: req.referenceType ?? null,
        referenceId: req.referenceId ?? null,
        allowNegative: req.allowNegative === true,
        idempotencyKey:
          lines.length === 1 ? req.idempotencyKey : `${req.idempotencyKey}#${index + 1}`,
        createdById: req.createdById ?? null,
      },
    });
    applied.push(toApplied(row));
  }

  if (!isInbound(req.type)) await evaluateStockAlert(tx, req.warehouseId, req.productId);
  return { movements: applied, replayed: false };
}

/** Aplica varias líneas en orden fijo (almacén, producto): dos operaciones cruzadas nunca se bloquean entre sí. */
export async function applyMovements(
  tx: TenantTx,
  requests: MovementRequest[],
): Promise<MovementOutcome[]> {
  const ordered = [...requests].sort(
    (a, b) => a.warehouseId.localeCompare(b.warehouseId) || a.productId.localeCompare(b.productId),
  );
  const results: MovementOutcome[] = [];
  for (const request of ordered) results.push(await applyMovement(tx, request));
  return results;
}

function isIdempotencyRace(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta ?? {}).includes("idempotencyKey")
  );
}

/**
 * Ejecuta `fn` en una transacción de tenant. Si dos peticiones con la MISMA clave
 * de idempotencia compiten y la restricción única aborta a la perdedora, esta
 * reintenta: ahora ve el movimiento ganador y devuelve su resultado (sin duplicar).
 */
async function runIdempotent(
  tenantId: string,
  fn: (tx: TenantTx) => Promise<MovementOutcome>,
): Promise<MovementOutcome> {
  try {
    return await withTenant(tenantId, fn);
  } catch (error) {
    if (!isIdempotencyRace(error)) throw error;
    return withTenant(tenantId, fn);
  }
}

async function stockSettings(tx: TenantTx) {
  return tx.tenantSettings.findFirst({ select: { allowNegativeStock: true } });
}

/** Entrada de mercadería o inventario inicial (costo obligatorio). */
export async function registerStockIn(
  actor: AuthUser,
  input: StockInInput,
  meta: RequestMeta = {},
): Promise<MovementOutcome> {
  requirePermission(actor, "inventory:crear");
  const tenantId = requireTenantId(actor);
  const data = stockInSchema.parse(input);
  return runIdempotent(tenantId, async (tx) => {
    const outcome = await applyMovement(tx, {
      warehouseId: data.warehouseId,
      productId: data.productId,
      type: data.type,
      quantity: data.quantity,
      unitCost: data.unitCost,
      reason: data.reason,
      referenceType: data.reference ? "manual" : undefined,
      idempotencyKey: data.idempotencyKey,
      createdById: actor.userId,
      lot: data.lot,
      serials: data.serials,
    });
    if (!outcome.replayed) {
      await tx.product.update({
        where: { id: data.productId },
        data: { lastPurchaseCost: data.unitCost },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "stock.in",
        entityType: "product",
        entityId: data.productId,
        after: {
          type: data.type,
          warehouseId: data.warehouseId,
          unitCost: data.unitCost,
          movements: outcome.movements.length,
          balanceAfter: outcome.movements.at(-1)?.balanceAfter ?? null,
        },
      });
    }
    return outcome;
  });
}

/**
 * Ajuste manual con motivo obligatorio. Dejar el saldo negativo exige el
 * permiso `inventory:permitir_stock_negativo` Y que el tenant lo haya habilitado.
 */
export async function adjustStock(
  actor: AuthUser,
  input: AdjustmentInput,
  meta: RequestMeta = {},
): Promise<MovementOutcome> {
  requirePermission(actor, "inventory:editar");
  const tenantId = requireTenantId(actor);
  const data = adjustmentSchema.parse(input);
  if (data.allowNegative && !can(actor, "inventory:permitir_stock_negativo"))
    throw new PermissionDeniedError("inventory:permitir_stock_negativo");

  return runIdempotent(tenantId, async (tx) => {
    if (data.allowNegative && !(await stockSettings(tx))?.allowNegativeStock) {
      throw new ConflictError(
        "NEGATIVE_NOT_ENABLED",
        "Tu empresa no tiene habilitado el stock negativo",
      );
    }
    const before = await tx.stockBalance.findFirst({
      where: { warehouseId: data.warehouseId, productId: data.productId },
    });
    const outcome = await applyMovement(tx, {
      warehouseId: data.warehouseId,
      productId: data.productId,
      type: data.direction === "IN" ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT",
      quantity: data.quantity,
      unitCost: data.unitCost,
      reason: data.reason,
      idempotencyKey: data.idempotencyKey,
      allowNegative: data.allowNegative,
      createdById: actor.userId,
      lot: data.lot,
      lotId: data.lotId,
      serials: data.serials,
    });
    if (!outcome.replayed) {
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "stock.adjusted",
        entityType: "product",
        entityId: data.productId,
        before: { quantity: before?.quantity.toString() ?? "0" },
        after: {
          quantity: outcome.movements.at(-1)?.balanceAfter ?? null,
          direction: data.direction,
        },
        reason: data.reason,
      });
    }
    return outcome;
  });
}
