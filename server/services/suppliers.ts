import { can, requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, softDeleteData, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError, PermissionDeniedError } from "@/lib/errors";
import { OPEN_STATUSES } from "@/lib/purchasing/state";
import {
  supplierProductSchema,
  supplierSchema,
  type SupplierInput,
  type SupplierProductInput,
} from "@/lib/validation/purchasing";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

function uniqueTaxId(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createSupplier(
  actor: AuthUser,
  input: SupplierInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "purchasing:crear");
  const data = supplierSchema.parse(input);
  // La lista blanca del agente es un guardrail: solo quien administra la IA la toca.
  if (data.aiWhitelisted) requirePermission(actor, "ai_agent:editar");
  try {
    return await withTenant(requireTenantId(actor), async (tx) => {
      const supplier = await tx.supplier.create({
        data: {
          name: data.name,
          taxId: data.taxId ?? null,
          contactName: data.contactName ?? null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          whatsapp: data.whatsapp ?? null,
          address: data.address ?? null,
          defaultLeadTimeDays: data.defaultLeadTimeDays ?? null,
          paymentTerms: data.paymentTerms ?? null,
          currency: data.currency,
          aiWhitelisted: data.aiWhitelisted ?? false,
          notes: data.notes ?? null,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "supplier.created",
        entityType: "supplier",
        entityId: supplier.id,
        after: { name: supplier.name, aiWhitelisted: supplier.aiWhitelisted },
      });
      return { id: supplier.id };
    });
  } catch (error) {
    if (uniqueTaxId(error))
      throw new ConflictError("SUPPLIER_TAX_ID", "Ya existe un proveedor con ese RUC");
    throw error;
  }
}

export async function updateSupplier(
  actor: AuthUser,
  supplierId: string,
  input: Partial<SupplierInput>,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "purchasing:editar");
  const data = supplierSchema.partial().parse(input);
  if (data.aiWhitelisted !== undefined) requirePermission(actor, "ai_agent:editar");
  try {
    await withTenant(requireTenantId(actor), async (tx) => {
      const before = await tx.supplier.findFirst({ where: { id: supplierId } });
      if (!before) throw new NotFoundError("Proveedor");
      const patch = Object.fromEntries(
        Object.entries(data).filter(([, value]) => value !== undefined),
      );
      const after = await tx.supplier.update({ where: { id: supplierId }, data: patch });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action:
          before.aiWhitelisted !== after.aiWhitelisted
            ? "supplier.whitelist_changed"
            : "supplier.updated",
        entityType: "supplier",
        entityId: supplierId,
        before: {
          aiWhitelisted: before.aiWhitelisted,
          defaultLeadTimeDays: before.defaultLeadTimeDays,
          whatsapp: before.whatsapp,
        },
        after: {
          aiWhitelisted: after.aiWhitelisted,
          defaultLeadTimeDays: after.defaultLeadTimeDays,
          whatsapp: after.whatsapp,
        },
      });
    });
  } catch (error) {
    if (uniqueTaxId(error))
      throw new ConflictError("SUPPLIER_TAX_ID", "Ya existe un proveedor con ese RUC");
    throw error;
  }
}

export async function listSuppliers(actor: AuthUser) {
  requirePermission(actor, "purchasing:ver");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.supplier.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        taxId: true,
        email: true,
        whatsapp: true,
        defaultLeadTimeDays: true,
        paymentTerms: true,
        aiWhitelisted: true,
        _count: { select: { products: true } },
      },
      orderBy: { name: "asc" },
    }),
  );
}

export async function deleteSupplier(
  actor: AuthUser,
  supplierId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "purchasing:eliminar");
  await withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.supplier.findFirst({ where: { id: supplierId } })))
      throw new NotFoundError("Proveedor");
    if (
      (await tx.purchaseOrder.count({ where: { supplierId, status: { in: OPEN_STATUSES } } })) > 0
    ) {
      throw new ConflictError("SUPPLIER_OPEN_ORDERS", "El proveedor tiene órdenes abiertas");
    }
    await tx.supplier.update({ where: { id: supplierId }, data: softDeleteData() });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "supplier.deleted",
      entityType: "supplier",
      entityId: supplierId,
    });
  });
}

/** Catálogo del proveedor: precio, plazo de entrega y preferencia. El historial de precios queda registrado. */
export async function upsertSupplierProduct(
  actor: AuthUser,
  input: SupplierProductInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "purchasing:editar");
  const data = supplierProductSchema.parse(input);
  if (data.price !== undefined && !can(actor, "purchasing:ver_costos_compra"))
    throw new PermissionDeniedError("purchasing:ver_costos_compra");

  return withTenant(requireTenantId(actor), async (tx) => {
    const [supplier, product] = await Promise.all([
      tx.supplier.findFirst({ where: { id: data.supplierId } }),
      tx.product.findFirst({ where: { id: data.productId, isStocked: true } }),
    ]);
    if (!supplier) throw new NotFoundError("Proveedor");
    if (!product) throw new NotFoundError("Producto");

    const existing = await tx.supplierProduct.findFirst({
      where: { supplierId: data.supplierId, productId: data.productId },
    });
    const fields = {
      supplierSku: data.supplierSku ?? existing?.supplierSku ?? null,
      leadTimeDays: data.leadTimeDays ?? existing?.leadTimeDays ?? null,
      minOrderQty: data.minOrderQty ?? existing?.minOrderQty?.toString() ?? null,
      isPreferred: data.isPreferred,
      isActive: true,
      ...(data.price !== undefined
        ? { lastPrice: data.price, lastPriceAt: new Date(), currency: supplier.currency }
        : {}),
    };
    const link = existing
      ? await tx.supplierProduct.update({ where: { id: existing.id }, data: fields })
      : await tx.supplierProduct.create({
          data: { supplierId: data.supplierId, productId: data.productId, ...fields },
        });
    if (data.isPreferred) {
      await tx.supplierProduct.updateMany({
        where: { productId: data.productId, id: { not: link.id }, isPreferred: true },
        data: { isPreferred: false },
      });
    }
    if (data.price !== undefined && !(existing?.lastPrice?.eq(data.price) ?? false)) {
      await tx.supplierPriceHistory.create({
        data: {
          supplierProductId: link.id,
          price: data.price,
          currency: supplier.currency,
          source: "MANUAL",
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "supplier.price_changed",
        entityType: "supplier_product",
        entityId: link.id,
        before: { price: existing?.lastPrice?.toString() ?? null },
        after: { price: data.price },
      });
    }
    return { id: link.id };
  });
}

export async function listSupplierProducts(actor: AuthUser, supplierId: string) {
  requirePermission(actor, "purchasing:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const rows = await withTenant(requireTenantId(actor), (tx) =>
    tx.supplierProduct.findMany({
      where: { supplierId, isActive: true },
      include: { product: { select: { sku: true, name: true } } },
      orderBy: { createdAt: "asc" },
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    productId: row.productId,
    sku: row.product.sku,
    name: row.product.name,
    supplierSku: row.supplierSku,
    leadTimeDays: row.leadTimeDays,
    minOrderQty: row.minOrderQty?.toString() ?? null,
    isPreferred: row.isPreferred,
    ...(canSeeCost ? { lastPrice: row.lastPrice?.toString() ?? null } : {}),
  }));
}
