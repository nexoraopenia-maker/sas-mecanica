import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { type Prisma, withTenant, type TenantTx } from "@/lib/db";
import { ConflictError } from "@/lib/errors";
import { formatTireSize, parseTireSize } from "@/lib/inventory/tire";
import type { PosProduct, PosSnapshot, PosTaxContext } from "@/lib/pos/types";
import { productSearchSchema } from "@/lib/validation/catalog";
import { buildSearchWhere } from "./catalog";
import { searchCustomers } from "./customers";
import { findVehicleByPlate } from "./vehicles";

const productInclude = {
  tireDetail: true,
  partDetail: true,
  equivalences: { select: { code: true } },
} satisfies Prisma.ProductInclude;

type Row = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

/** Máximo de productos del catálogo que se guardan en el dispositivo para vender sin conexión. */
export const SNAPSHOT_LIMIT = 5000;

function toPosProduct(row: Row, stock: number | null): PosProduct {
  const codes = [
    row.partDetail?.oemCode,
    row.partDetail?.partNumber,
    ...row.equivalences.map((e) => e.code),
  ].filter((code): code is string => Boolean(code));
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    kind: row.kind,
    brand: row.brand,
    salePrice: row.salePrice.toString(),
    stock,
    trackingMode: row.trackingMode,
    isStocked: row.isStocked,
    taxAffectation: row.taxAffectation,
    codes: [...new Set(codes)],
    tire: row.tireDetail
      ? formatTireSize({
          width: row.tireDetail.width,
          aspectRatio: row.tireDetail.aspectRatio,
          rimDiameter: Number(row.tireDetail.rimDiameter),
        })
      : null,
  };
}

async function stockOf(tx: TenantTx, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const totals = await tx.stockBalance.groupBy({
    by: ["productId"],
    where: { productId: { in: ids } },
    _sum: { quantity: true },
  });
  return new Map(totals.map((t) => [t.productId, Number(t._sum.quantity ?? 0)]));
}

function guard(actor: AuthUser): string {
  requirePermission(actor, "pos:crear");
  requirePermission(actor, "catalog:ver");
  return requireTenantId(actor);
}

export async function posTaxContext(actor: AuthUser): Promise<PosTaxContext> {
  requirePermission(actor, "pos:crear");
  return withTenant(requireTenantId(actor), async (tx) => {
    const s = await tx.tenantSettings.findFirstOrThrow({
      select: { taxRate: true, pricesIncludeTax: true },
    });
    return { taxRate: s.taxRate.toString(), pricesIncludeTax: s.pricesIncludeTax };
  });
}

/** Sugerencias en tiempo real del mostrador (nombre, SKU, marca, código de barras, OEM o medida de llanta). */
export async function suggestProducts(
  actor: AuthUser,
  query: string,
  limit = 8,
): Promise<PosProduct[]> {
  const tenantId = guard(actor);
  const q = query.trim();
  if (q.length < 2) return [];
  const where = buildSearchWhere(
    productSearchSchema.parse({ q, limit: Math.min(Math.max(limit, 1), 20) }),
  );
  const canSeeStock = can(actor, "inventory:ver");
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: Math.min(Math.max(limit, 1), 20),
    });
    const stock = canSeeStock
      ? await stockOf(
          tx,
          rows.map((r) => r.id),
        )
      : new Map<string, number>();
    return rows.map((row) => toPosProduct(row, canSeeStock ? (stock.get(row.id) ?? 0) : null));
  });
}

/**
 * Copia del catálogo vendible para guardar en el dispositivo (modo sin conexión). Solo del tenant de la
 * sesión, solo productos activos, y el stock solo si el rol ve inventario.
 */
export async function posSnapshot(actor: AuthUser, now: Date = new Date()): Promise<PosSnapshot> {
  const tenantId = guard(actor);
  const canSeeStock = can(actor, "inventory:ver");
  return withTenant(tenantId, async (tx) => {
    const [settings, rows] = await Promise.all([
      tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true, pricesIncludeTax: true } }),
      tx.product.findMany({
        where: { isActive: true },
        include: productInclude,
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: SNAPSHOT_LIMIT + 1,
      }),
    ]);
    const truncated = rows.length > SNAPSHOT_LIMIT;
    const kept = truncated ? rows.slice(0, SNAPSHOT_LIMIT) : rows;
    const stock = canSeeStock
      ? await stockOf(
          tx,
          kept.map((r) => r.id),
        )
      : new Map<string, number>();
    return {
      version: 1 as const,
      generatedAt: now.toISOString(),
      tax: { taxRate: settings.taxRate.toString(), pricesIncludeTax: settings.pricesIncludeTax },
      products: kept.map((row) => toPosProduct(row, canSeeStock ? (stock.get(row.id) ?? 0) : null)),
      truncated,
    };
  });
}

export interface PosSearchInput {
  q?: string;
  tireSize?: string;
  make?: string;
  model?: string;
}

/** Búsqueda del mostrador con filtros (medida de llanta y vehículo) además del texto libre. */
export async function searchPosProducts(
  actor: AuthUser,
  input: PosSearchInput,
  limit = 30,
): Promise<PosProduct[]> {
  const tenantId = guard(actor);
  const data = productSearchSchema.parse({
    q: input.q?.trim() || undefined,
    tireSize: input.tireSize?.trim() || undefined,
    vehicle: input.make?.trim()
      ? { make: input.make.trim(), model: input.model?.trim() || undefined }
      : undefined,
    limit,
  });
  if (data.tireSize && !parseTireSize(data.tireSize))
    throw new ConflictError("TIRE_SIZE", "Medida de llanta inválida (ej.: 205/55 R16)");
  const canSeeStock = can(actor, "inventory:ver");
  return withTenant(tenantId, async (tx) => {
    const rows = await tx.product.findMany({
      where: buildSearchWhere(data),
      include: productInclude,
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: data.limit,
    });
    const stock = canSeeStock
      ? await stockOf(
          tx,
          rows.map((r) => r.id),
        )
      : new Map<string, number>();
    return rows.map((row) => toPosProduct(row, canSeeStock ? (stock.get(row.id) ?? 0) : null));
  });
}

export async function lookupCustomers(actor: AuthUser, query: string) {
  const rows = await searchCustomers(actor, query, 8);
  return {
    customers: rows.map((c) => ({
      id: c.id,
      name: c.name,
      docType: c.docType,
      docNumber: c.docNumber,
      plates: c.vehicles.map((v) => v.plate),
    })),
  };
}

export async function lookupPlate(actor: AuthUser, plate: string) {
  const vehicle = await findVehicleByPlate(actor, plate);
  if (!vehicle) return { found: null };
  return {
    found: {
      vehicleId: vehicle.id,
      plate: vehicle.plate,
      make: vehicle.make,
      model: vehicle.model,
      customer: {
        id: vehicle.customer.id,
        name: vehicle.customer.name,
        docType: vehicle.customer.docType,
        docNumber: vehicle.customer.docNumber,
      },
    },
  };
}
