import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, softDeleteData, withTenant, type ProductKind, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import { CATALOG_CHIPS } from "@/lib/catalog/chips";
import { marginPercent, netSalePrice } from "@/lib/catalog/margin";
import { stockIndicator, type StockIndicator } from "@/lib/catalog/stock-light";
import { effectiveThresholds } from "@/lib/inventory/status";
import { formatTireSize, isTireTooOld, parseTireSize } from "@/lib/inventory/tire";
import {
  catalogListSchema,
  compatibilitySchema,
  createProductSchema,
  equivalenceSchema,
  productSearchSchema,
  updateProductSchema,
  type CatalogListInput,
  type CreateProductInput,
  type ProductSearchInput,
  type UpdateProductInput,
} from "@/lib/validation/catalog";
import { z } from "zod";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

const productInclude = {
  tireDetail: true,
  batteryDetail: true,
  lubricantDetail: true,
  partDetail: true,
  equivalences: true,
  compatibilities: true,
} satisfies Prisma.ProductInclude;

type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export interface ProductView {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  description: string | null;
  kind: ProductKind;
  brand: string | null;
  unit: string;
  trackingMode: "NONE" | "LOT" | "SERIAL";
  isStocked: boolean;
  isActive: boolean;
  salePrice: string;
  taxAffectation: "TAXED" | "EXEMPT" | "UNAFFECTED";
  /** Solo con `purchasing:ver_costos_compra`: el vendedor nunca recibe costos. */
  lastPurchaseCost?: string | null;
  warrantyPolicyId: string | null;
  tire?: {
    size: string;
    width: number;
    aspectRatio: number;
    rimDiameter: string;
    loadIndex: number | null;
    speedRating: string | null;
    design: string | null;
    rackLocation: string | null;
  };
  battery?: { voltage: number; capacityAh: number; ccaA: number; polarity: string; label: string };
  lubricant?: { viscosity: string; baseType: string | null; volumeLiters: string | null };
  part?: {
    oemCode: string | null;
    partNumber: string | null;
    isOem: boolean;
    partCategory: string | null;
  };
  equivalences: Array<{ code: string; brand: string | null; type: string }>;
  compatibilities: Array<{
    make: string;
    model: string;
    yearFrom: number | null;
    yearTo: number | null;
    engine: string | null;
  }>;
  /** Stock total (suma de almacenes) si el usuario puede ver inventario. */
  stock?: number;
}

function toView(row: ProductRow, canSeeCost: boolean): ProductView {
  const view: ProductView = {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    name: row.name,
    description: row.description,
    kind: row.kind,
    brand: row.brand,
    unit: row.unit,
    trackingMode: row.trackingMode,
    isStocked: row.isStocked,
    isActive: row.isActive,
    salePrice: row.salePrice.toString(),
    taxAffectation: row.taxAffectation,
    warrantyPolicyId: row.warrantyPolicyId,
    equivalences: row.equivalences.map((e) => ({ code: e.code, brand: e.brand, type: e.type })),
    compatibilities: row.compatibilities.map((c) => ({
      make: c.make,
      model: c.model,
      yearFrom: c.yearFrom,
      yearTo: c.yearTo,
      engine: c.engine,
    })),
  };
  if (canSeeCost) view.lastPurchaseCost = row.lastPurchaseCost?.toString() ?? null;
  if (row.tireDetail) {
    const t = row.tireDetail;
    view.tire = {
      size: formatTireSize({
        width: t.width,
        aspectRatio: t.aspectRatio,
        rimDiameter: Number(t.rimDiameter),
      }),
      width: t.width,
      aspectRatio: t.aspectRatio,
      rimDiameter: t.rimDiameter.toString(),
      loadIndex: t.loadIndex,
      speedRating: t.speedRating,
      design: t.design,
      rackLocation: t.rackLocation,
    };
  }
  if (row.batteryDetail) {
    const b = row.batteryDetail;
    view.battery = {
      voltage: b.voltage,
      capacityAh: b.capacityAh,
      ccaA: b.ccaA,
      polarity: b.polarity,
      label: `${b.voltage}V ${b.capacityAh}Ah ${b.ccaA}CCA`,
    };
  }
  if (row.lubricantDetail) {
    view.lubricant = {
      viscosity: row.lubricantDetail.viscosity,
      baseType: row.lubricantDetail.baseType,
      volumeLiters: row.lubricantDetail.volumeLiters?.toString() ?? null,
    };
  }
  if (row.partDetail) {
    view.part = {
      oemCode: row.partDetail.oemCode,
      partNumber: row.partDetail.partNumber,
      isOem: row.partDetail.isOem,
      partCategory: row.partDetail.partCategory,
    };
  }
  return view;
}

function isUniqueViolation(error: unknown, field: string): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta ?? {})
      .toLowerCase()
      .includes(field.toLowerCase())
  );
}

const TRACKING: Record<ProductKind, "NONE" | "LOT" | "SERIAL"> = {
  TIRE: "LOT", // lote = DOT
  BATTERY: "SERIAL", // serie única
  LUBRICANT: "NONE",
  PART: "NONE",
  ACCESSORY: "NONE",
  SERVICE: "NONE",
};

/** Alta de producto con su ficha técnica según el tipo (llanta, batería, lubricante, repuesto...). */
export async function createProduct(
  actor: AuthUser,
  input: CreateProductInput,
  meta: RequestMeta = {},
): Promise<ProductView> {
  requirePermission(actor, "catalog:crear");
  const data = createProductSchema.parse(input);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  if (data.lastPurchaseCost !== undefined && !canSeeCost)
    throw new PermissionDeniedError("purchasing:ver_costos_compra");

  try {
    return await withTenant(requireTenantId(actor), async (tx) => {
      const product = await tx.product.create({
        data: {
          sku: data.sku,
          barcode: data.barcode ?? null,
          name: data.name,
          description: data.description ?? null,
          kind: data.kind,
          brand: data.brand ?? null,
          categoryId: data.categoryId ?? null,
          unit: data.unit,
          trackingMode: TRACKING[data.kind],
          isStocked: data.kind !== "SERVICE",
          salePrice: data.salePrice,
          lastPurchaseCost: data.lastPurchaseCost ?? null,
          taxAffectation: data.taxAffectation,
          warrantyPolicyId: data.warrantyPolicyId ?? null,
          isActive: data.isActive,
          ...(data.kind === "TIRE"
            ? {
                tireDetail: {
                  create: { ...data.tire, rimDiameter: data.tire.rimDiameter.toString() },
                },
              }
            : {}),
          ...(data.kind === "BATTERY" ? { batteryDetail: { create: data.battery } } : {}),
          ...(data.kind === "LUBRICANT"
            ? {
                lubricantDetail: {
                  create: {
                    ...data.lubricant,
                    volumeLiters: data.lubricant.volumeLiters?.toString(),
                  },
                },
              }
            : {}),
          ...(data.kind === "PART" ? { partDetail: { create: data.part } } : {}),
          equivalences: {
            create: data.equivalences.map((e) => ({
              code: e.code,
              brand: e.brand ?? null,
              type: e.type,
            })),
          },
          compatibilities: {
            create: data.compatibilities.map((c) => ({
              make: c.make,
              model: c.model,
              yearFrom: c.yearFrom ?? null,
              yearTo: c.yearTo ?? null,
              engine: c.engine ?? null,
            })),
          },
        },
        include: productInclude,
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "product.created",
        entityType: "product",
        entityId: product.id,
        after: {
          sku: product.sku,
          name: product.name,
          kind: product.kind,
          salePrice: product.salePrice.toString(),
        },
      });
      return toView(product, canSeeCost);
    });
  } catch (error) {
    if (isUniqueViolation(error, "sku"))
      throw new ConflictError("SKU_TAKEN", `Ya existe un producto con el SKU ${data.sku}`);
    if (isUniqueViolation(error, "barcode"))
      throw new ConflictError("BARCODE_TAKEN", "Ya existe un producto con ese código de barras");
    throw error;
  }
}

/** Edita datos comerciales. Cambios de precio y de costo quedan en auditoría con valor anterior y nuevo. */
export async function updateProduct(
  actor: AuthUser,
  productId: string,
  input: UpdateProductInput,
  meta: RequestMeta = {},
): Promise<ProductView> {
  requirePermission(actor, "catalog:editar");
  const data = updateProductSchema.parse(input);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  if (data.lastPurchaseCost !== undefined && !canSeeCost)
    throw new PermissionDeniedError("purchasing:ver_costos_compra");

  try {
    return await withTenant(requireTenantId(actor), async (tx) => {
      const before = await tx.product.findFirst({ where: { id: productId } });
      if (!before) throw new NotFoundError("Producto");
      const product = await tx.product.update({
        where: { id: productId },
        data: {
          ...(data.name !== undefined ? { name: data.name } : {}),
          ...(data.description !== undefined ? { description: data.description } : {}),
          ...(data.brand !== undefined ? { brand: data.brand } : {}),
          ...(data.barcode !== undefined ? { barcode: data.barcode } : {}),
          ...(data.salePrice !== undefined ? { salePrice: data.salePrice } : {}),
          ...(data.lastPurchaseCost !== undefined
            ? { lastPurchaseCost: data.lastPurchaseCost }
            : {}),
          ...(data.warrantyPolicyId !== undefined
            ? { warrantyPolicyId: data.warrantyPolicyId }
            : {}),
          ...(data.categoryId !== undefined ? { categoryId: data.categoryId } : {}),
          ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        },
        include: productInclude,
      });
      const priceChanged = data.salePrice !== undefined && !before.salePrice.eq(data.salePrice);
      const costChanged =
        data.lastPurchaseCost !== undefined &&
        !(before.lastPurchaseCost?.eq(data.lastPurchaseCost) ?? false);
      if (priceChanged) {
        await recordAudit(tx, auditContextOf(actor, meta), {
          action: "product.price_changed",
          entityType: "product",
          entityId: productId,
          before: { salePrice: before.salePrice.toString() },
          after: { salePrice: product.salePrice.toString() },
        });
      }
      if (costChanged) {
        await recordAudit(tx, auditContextOf(actor, meta), {
          action: "product.cost_changed",
          entityType: "product",
          entityId: productId,
          before: { lastPurchaseCost: before.lastPurchaseCost?.toString() ?? null },
          after: { lastPurchaseCost: product.lastPurchaseCost?.toString() ?? null },
        });
      }
      if (!priceChanged && !costChanged) {
        await recordAudit(tx, auditContextOf(actor, meta), {
          action: "product.updated",
          entityType: "product",
          entityId: productId,
          after: { fields: Object.keys(data) },
        });
      }
      return toView(product, canSeeCost);
    });
  } catch (error) {
    if (isUniqueViolation(error, "barcode"))
      throw new ConflictError("BARCODE_TAKEN", "Ya existe un producto con ese código de barras");
    throw error;
  }
}

/** Borrado lógico. No se puede dar de baja un producto con existencias. */
export async function deleteProduct(
  actor: AuthUser,
  productId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "catalog:eliminar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const product = await tx.product.findFirst({ where: { id: productId } });
    if (!product) throw new NotFoundError("Producto");
    const stock = await tx.stockBalance.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    if (!(stock._sum.quantity ?? new Prisma.Decimal(0)).eq(0))
      throw new ConflictError(
        "PRODUCT_HAS_STOCK",
        "El producto tiene existencias; ajusta el stock a 0 antes de eliminarlo",
      );
    await tx.product.update({ where: { id: productId }, data: softDeleteData() });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "product.deleted",
      entityType: "product",
      entityId: productId,
      before: { sku: product.sku, name: product.name },
    });
  });
}

export async function getProduct(
  actor: AuthUser,
  productId: string,
): Promise<
  ProductView & {
    stockByWarehouse?: Array<{
      warehouseId: string;
      warehouse: string;
      quantity: string;
      avgCost?: string;
    }>;
  }
> {
  requirePermission(actor, "catalog:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const canSeeStock = can(actor, "inventory:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const product = await tx.product.findFirst({
      where: { id: productId },
      include: productInclude,
    });
    if (!product) throw new NotFoundError("Producto");
    const view = toView(product, canSeeCost);
    if (!canSeeStock) return view;
    const balances = await tx.stockBalance.findMany({
      where: { productId },
      include: { warehouse: { select: { name: true } } },
    });
    return {
      ...view,
      stock: balances.reduce((sum, b) => sum + Number(b.quantity), 0),
      stockByWarehouse: balances.map((b) => ({
        warehouseId: b.warehouseId,
        warehouse: b.warehouse.name,
        quantity: b.quantity.toString(),
        ...(canSeeCost ? { avgCost: b.avgCost.toString() } : {}),
      })),
    };
  });
}

export function buildSearchWhere(
  data: z.output<typeof productSearchSchema>,
): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  if (!data.includeInactive) and.push({ isActive: true });
  if (data.kind) and.push({ kind: data.kind });

  if (data.q) {
    const q = data.q;
    const size = parseTireSize(q);
    and.push({
      OR: [
        { sku: { contains: q, mode: "insensitive" } },
        { barcode: q },
        { name: { contains: q, mode: "insensitive" } },
        { brand: { contains: q, mode: "insensitive" } },
        {
          partDetail: {
            OR: [
              { oemCode: { contains: q, mode: "insensitive" } },
              { partNumber: { contains: q, mode: "insensitive" } },
            ],
          },
        },
        { equivalences: { some: { code: { contains: q, mode: "insensitive" } } } },
        ...(size
          ? [
              {
                tireDetail: {
                  width: size.width,
                  aspectRatio: size.aspectRatio,
                  rimDiameter: size.rimDiameter.toString(),
                },
              },
            ]
          : []),
      ],
    });
  }
  if (data.tireSize) {
    const size = parseTireSize(data.tireSize);
    if (size)
      and.push({
        tireDetail: {
          width: size.width,
          aspectRatio: size.aspectRatio,
          rimDiameter: size.rimDiameter.toString(),
        },
      });
  }
  if (data.code) {
    and.push({
      OR: [
        {
          partDetail: {
            OR: [
              { oemCode: { equals: data.code, mode: "insensitive" } },
              { partNumber: { equals: data.code, mode: "insensitive" } },
            ],
          },
        },
        { equivalences: { some: { code: { equals: data.code, mode: "insensitive" } } } },
      ],
    });
  }
  if (data.vehicle) {
    const { make, model, year } = data.vehicle;
    const compat: Prisma.VehicleCompatibilityWhereInput[] = [
      { make: { equals: make, mode: "insensitive" } },
    ];
    if (model) compat.push({ model: { contains: model, mode: "insensitive" } });
    if (year !== undefined) {
      compat.push(
        { OR: [{ yearFrom: null }, { yearFrom: { lte: year } }] },
        { OR: [{ yearTo: null }, { yearTo: { gte: year } }] },
      );
    }
    and.push({ compatibilities: { some: { AND: compat } } });
  }
  return { AND: and };
}

/**
 * Búsqueda por texto, medida de llanta ("205/55R16"), código OEM/equivalente o
 * vehículo (marca/modelo/año). Incluye el stock total si el usuario ve inventario.
 */
export async function searchProducts(
  actor: AuthUser,
  input: ProductSearchInput = {},
): Promise<ProductView[]> {
  requirePermission(actor, "catalog:ver");
  const data = productSearchSchema
    .refine((value) => value.tireSize === undefined || parseTireSize(value.tireSize) !== null, {
      message: "Medida de llanta inválida (ej.: 205/55 R16)",
      path: ["tireSize"],
    })
    .parse(input);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const canSeeStock = can(actor, "inventory:ver");

  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.product.findMany({
      where: buildSearchWhere(data),
      include: productInclude,
      orderBy: [{ name: "asc" }],
      take: data.limit,
    });
    const views = rows.map((row) => toView(row, canSeeCost));
    if (!canSeeStock || rows.length === 0) return views;
    const totals = await tx.stockBalance.groupBy({
      by: ["productId"],
      where: {
        productId: { in: rows.map((r) => r.id) },
        ...(data.warehouseId ? { warehouseId: data.warehouseId } : {}),
      },
      _sum: { quantity: true },
    });
    const byProduct = new Map(totals.map((t) => [t.productId, Number(t._sum.quantity ?? 0)]));
    return views.map((view) => ({ ...view, stock: byProduct.get(view.id) ?? 0 }));
  });
}

export interface CatalogItem extends ProductView {
  categoryName: string | null;
  /** Solo con `inventory:ver` y para productos con control de stock. */
  stockInfo?: StockIndicator & { quantity: number; reorderPoint: number };
  /** Solo con `purchasing:ver_costos_compra`. Null si no hay costo registrado. */
  marginPercent?: string | null;
}

export interface CatalogPage {
  items: CatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Hay algún filtro activo (distingue «catálogo vacío» de «sin resultados»). */
  filtered: boolean;
}

function chipWhere(chipId: string): Prisma.ProductWhereInput | null {
  const chip = CATALOG_CHIPS.find((c) => c.id === chipId);
  if (!chip) return null;
  if ("kind" in chip) return { kind: chip.kind };
  if ("category" in chip) {
    const match = { contains: chip.category, mode: "insensitive" } as const;
    return { category: { OR: [{ name: match }, { parent: { name: match } }] } };
  }
  return null;
}

/**
 * Catálogo paginado en el servidor: búsqueda (SKU, nombre, código de barras u OEM), medida de llanta, código OEM,
 * vehículo (marca, modelo, año) y chip de categoría. Costo y margen solo con `purchasing:ver_costos_compra`;
 * el semáforo de stock solo con `inventory:ver` y usa el punto de reposición existente (sin stock máximo).
 */
export async function listCatalog(
  actor: AuthUser,
  input: CatalogListInput = {},
): Promise<CatalogPage> {
  requirePermission(actor, "catalog:ver");
  const data = catalogListSchema.parse(input);
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const canSeeStock = can(actor, "inventory:ver");

  const and: Prisma.ProductWhereInput[] = [
    buildSearchWhere(
      productSearchSchema.parse({ q: data.q, tireSize: data.tireSize, code: data.code }),
    ),
  ];
  const chip = chipWhere(data.chip);
  if (chip) and.push(chip);
  if (data.make || data.model || data.year !== undefined) {
    const compat: Prisma.VehicleCompatibilityWhereInput[] = [];
    if (data.make) compat.push({ make: { equals: data.make, mode: "insensitive" } });
    if (data.model) compat.push({ model: { contains: data.model, mode: "insensitive" } });
    if (data.year !== undefined) {
      compat.push(
        { OR: [{ yearFrom: null }, { yearFrom: { lte: data.year } }] },
        { OR: [{ yearTo: null }, { yearTo: { gte: data.year } }] },
      );
    }
    and.push({ compatibilities: { some: { AND: compat } } });
  }
  const where: Prisma.ProductWhereInput = { AND: and };
  const filtered = Boolean(
    data.q ||
    data.tireSize ||
    data.code ||
    data.make ||
    data.model ||
    data.year !== undefined ||
    data.chip !== "todos",
  );

  return withTenant(requireTenantId(actor), async (tx) => {
    const total = await tx.product.count({ where });
    const pageCount = Math.max(1, Math.ceil(total / data.pageSize));
    const page = Math.min(data.page, pageCount);
    const rows = await tx.product.findMany({
      where,
      include: { ...productInclude, category: { select: { name: true } } },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      skip: (page - 1) * data.pageSize,
      take: data.pageSize,
    });

    const ids = rows.map((r) => r.id);
    const [balances, policies, settings] = await Promise.all([
      canSeeStock && ids.length
        ? tx.stockBalance.groupBy({
            by: ["productId"],
            where: { productId: { in: ids } },
            _sum: { quantity: true },
          })
        : [],
      canSeeStock && ids.length
        ? tx.reorderPolicy.findMany({ where: { productId: { in: ids } } })
        : [],
      canSeeCost
        ? tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true, pricesIncludeTax: true } })
        : null,
    ]);
    const stockOf = new Map(balances.map((b) => [b.productId, Number(b._sum.quantity ?? 0)]));
    const pointOf = new Map<string, number>();
    for (const policy of policies)
      pointOf.set(
        policy.productId,
        (pointOf.get(policy.productId) ?? 0) + effectiveThresholds(policy).reorderPoint,
      );

    const items = rows.map((row): CatalogItem => {
      const item: CatalogItem = {
        ...toView(row, canSeeCost),
        categoryName: row.category?.name ?? null,
      };
      if (canSeeStock && row.isStocked) {
        const quantity = stockOf.get(row.id) ?? 0;
        const reorderPoint = pointOf.get(row.id) ?? 0;
        item.stockInfo = { ...stockIndicator(quantity, reorderPoint), quantity, reorderPoint };
      }
      if (canSeeCost && settings) {
        const net = netSalePrice(row.salePrice.toString(), row.taxAffectation, {
          taxRate: settings.taxRate.toString(),
          pricesIncludeTax: settings.pricesIncludeTax,
        });
        item.marginPercent = marginPercent(net, row.lastPurchaseCost?.toString());
      }
      return item;
    });
    return { items, total, page, pageSize: data.pageSize, pageCount, filtered };
  });
}

/** Reemplaza las compatibilidades por vehículo (marca, modelo, año, motor). */
export async function replaceCompatibilities(
  actor: AuthUser,
  productId: string,
  items: Array<z.input<typeof compatibilitySchema>>,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "catalog:editar");
  const parsed = z.array(compatibilitySchema).max(200).parse(items);
  await withTenant(requireTenantId(actor), async (tx) => {
    await assertProduct(tx, productId);
    await tx.vehicleCompatibility.deleteMany({ where: { productId } });
    await tx.vehicleCompatibility.createMany({
      data: parsed.map((c) => ({
        productId,
        make: c.make,
        model: c.model,
        yearFrom: c.yearFrom ?? null,
        yearTo: c.yearTo ?? null,
        engine: c.engine ?? null,
      })),
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "product.compatibility_changed",
      entityType: "product",
      entityId: productId,
      after: { count: parsed.length },
    });
  });
}

/** Reemplaza las equivalencias cruzadas (OEM ↔ alternativos). */
export async function replaceEquivalences(
  actor: AuthUser,
  productId: string,
  items: Array<z.input<typeof equivalenceSchema>>,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "catalog:editar");
  const parsed = z.array(equivalenceSchema).max(50).parse(items);
  await withTenant(requireTenantId(actor), async (tx) => {
    await assertProduct(tx, productId);
    await tx.partEquivalence.deleteMany({ where: { productId } });
    await tx.partEquivalence.createMany({
      data: parsed.map((e) => ({ productId, code: e.code, brand: e.brand ?? null, type: e.type })),
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "product.equivalences_changed",
      entityType: "product",
      entityId: productId,
      after: { count: parsed.length },
    });
  });
}

async function assertProduct(tx: TenantTx, productId: string): Promise<void> {
  if (!(await tx.product.findFirst({ where: { id: productId }, select: { id: true } })))
    throw new NotFoundError("Producto");
}

export interface OldTireLot {
  lotId: string;
  productId: string;
  sku: string;
  name: string;
  dotCode: string | null;
  ageYears: number;
  quantity: number;
}

/** Llantas con DOT más antiguo que el máximo configurado del tenant y todavía en stock. */
export async function listOldTires(actor: AuthUser, now: Date = new Date()): Promise<OldTireLot[]> {
  requirePermission(actor, "inventory:ver");
  return withTenant(requireTenantId(actor), (tx) => findOldTireLots(tx, now));
}

export async function findOldTireLots(tx: TenantTx, now: Date = new Date()): Promise<OldTireLot[]> {
  const settings = await tx.tenantSettings.findFirst({ select: { tireMaxAgeYears: true } });
  const maxAge = settings?.tireMaxAgeYears ?? 5;
  const balances = await tx.stockLotBalance.findMany({
    where: { quantity: { gt: 0 } },
    include: { lot: true, product: { select: { sku: true, name: true } } },
  });
  const totals = new Map<string, OldTireLot>();
  for (const balance of balances) {
    if (!isTireTooOld(balance.lot.manufacturedAt, maxAge, now)) continue;
    const existing = totals.get(balance.lotId);
    const age =
      (now.getTime() - (balance.lot.manufacturedAt?.getTime() ?? now.getTime())) /
      (365.25 * 86_400_000);
    totals.set(balance.lotId, {
      lotId: balance.lotId,
      productId: balance.productId,
      sku: balance.product.sku,
      name: balance.product.name,
      dotCode: balance.lot.dotCode,
      ageYears: Math.round(age * 10) / 10,
      quantity: (existing?.quantity ?? 0) + Number(balance.quantity),
    });
  }
  return [...totals.values()].sort((a, b) => b.ageYears - a.ageYears);
}
