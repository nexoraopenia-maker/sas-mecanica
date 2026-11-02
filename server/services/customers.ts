import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { Prisma, softDeleteData, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  customerSchema,
  customerUpdateSchema,
  type CustomerInput,
  type CustomerUpdateInput,
} from "@/lib/validation/workshop";
import { normalizeDocument, normalizeWhatsapp } from "@/lib/workshop/documents";
import { normalizePlate } from "@/lib/workshop/plate";
import { OPEN_WORK_ORDER_STATUSES } from "@/lib/workshop/state";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

function isDuplicateDocument(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function createCustomer(
  actor: AuthUser,
  input: CustomerInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "customers:crear");
  const data = customerSchema.parse(input);
  try {
    return await withTenant(requireTenantId(actor), async (tx) => {
      const customer = await tx.customer.create({
        data: {
          docType: data.docType,
          docNumber: data.docNumber,
          name: data.name,
          email: data.email ?? null,
          phone: data.phone ?? null,
          whatsapp: data.whatsapp ?? null,
          whatsappOptIn: data.whatsappOptIn,
          address: data.address ?? null,
          notes: data.notes ?? null,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "customer.created",
        entityType: "customer",
        entityId: customer.id,
        after: { name: customer.name, docType: data.docType },
      });
      return { id: customer.id };
    });
  } catch (error) {
    if (isDuplicateDocument(error))
      throw new ConflictError("CUSTOMER_DOCUMENT", "Ya existe un cliente con ese documento");
    throw error;
  }
}

export async function updateCustomer(
  actor: AuthUser,
  customerId: string,
  input: CustomerUpdateInput,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "customers:editar");
  const data = customerUpdateSchema.parse(input);
  try {
    await withTenant(requireTenantId(actor), async (tx) => {
      const before = await tx.customer.findFirst({ where: { id: customerId } });
      if (!before) throw new NotFoundError("Cliente");
      const docType = data.docType ?? before.docType;
      const patch = {
        ...(data.docType !== undefined || data.docNumber !== undefined
          ? {
              docType,
              docNumber: normalizeDocument(docType, data.docNumber ?? before.docNumber ?? ""),
            }
          : {}),
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.whatsapp !== undefined
          ? { whatsapp: data.whatsapp ? normalizeWhatsapp(data.whatsapp) : null }
          : {}),
        ...(data.whatsappOptIn !== undefined ? { whatsappOptIn: data.whatsappOptIn } : {}),
        ...(data.address !== undefined ? { address: data.address } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
      };
      const after = await tx.customer.update({ where: { id: customerId }, data: patch });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action:
          before.whatsappOptIn !== after.whatsappOptIn
            ? "customer.consent_changed"
            : "customer.updated",
        entityType: "customer",
        entityId: customerId,
        before: {
          name: before.name,
          docNumber: before.docNumber,
          whatsappOptIn: before.whatsappOptIn,
        },
        after: { name: after.name, docNumber: after.docNumber, whatsappOptIn: after.whatsappOptIn },
      });
    });
  } catch (error) {
    if (isDuplicateDocument(error))
      throw new ConflictError("CUSTOMER_DOCUMENT", "Ya existe un cliente con ese documento");
    throw error;
  }
}

export async function deleteCustomer(
  actor: AuthUser,
  customerId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "customers:eliminar");
  await withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.customer.findFirst({ where: { id: customerId } })))
      throw new NotFoundError("Cliente");
    if (
      (await tx.workOrder.count({
        where: { customerId, status: { in: OPEN_WORK_ORDER_STATUSES } },
      })) > 0
    ) {
      throw new ConflictError(
        "CUSTOMER_OPEN_ORDERS",
        "El cliente tiene órdenes de trabajo abiertas",
      );
    }
    await tx.customer.update({ where: { id: customerId }, data: softDeleteData() });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "customer.deleted",
      entityType: "customer",
      entityId: customerId,
    });
  });
}

/** Búsqueda por nombre, documento, teléfono/WhatsApp o placa de alguno de sus vehículos. */
export async function searchCustomers(actor: AuthUser, query: string, limit = 30) {
  requirePermission(actor, "customers:ver");
  const q = query.trim();
  if (q.length < 2) return [];
  const digits = q.replace(/\D/g, "");
  const plate = normalizePlate(q);
  return withTenant(requireTenantId(actor), (tx) =>
    tx.customer.findMany({
      where: {
        OR: [
          { name: { contains: q, mode: "insensitive" } },
          { docNumber: { contains: q.replace(/[\s.-]/g, ""), mode: "insensitive" } },
          ...(digits.length >= 6
            ? [{ phone: { contains: digits } }, { whatsapp: { contains: digits } }]
            : []),
          ...(plate.length >= 3 ? [{ vehicles: { some: { plate: { contains: plate } } } }] : []),
        ],
      },
      select: {
        id: true,
        name: true,
        docType: true,
        docNumber: true,
        phone: true,
        whatsapp: true,
        vehicles: { select: { id: true, plate: true, make: true, model: true } },
      },
      orderBy: { name: "asc" },
      take: limit,
    }),
  );
}

export async function getCustomer(actor: AuthUser, customerId: string) {
  requirePermission(actor, "customers:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: customerId },
      include: { vehicles: { orderBy: { createdAt: "asc" } } },
    });
    if (!customer) throw new NotFoundError("Cliente");
    const [orders, warranties] = await Promise.all([
      tx.workOrder.findMany({
        where: { customerId },
        orderBy: { receivedAt: "desc" },
        take: 20,
        select: {
          id: true,
          number: true,
          status: true,
          receivedAt: true,
          total: true,
          vehicle: { select: { plate: true } },
        },
      }),
      tx.warranty.count({ where: { customerId, status: "ACTIVE" } }),
    ]);
    return {
      ...customer,
      creditLimit: customer.creditLimit.toString(),
      orders,
      activeWarranties: warranties,
    };
  });
}
