import { randomUUID } from "node:crypto";
import {
  can,
  isOwnRecordsOnly,
  requirePermission,
  requireTenantId,
  type AuthUser,
} from "@/lib/auth/can";
import { nextSequence, Prisma, withTenant, type TenantTx, type WorkOrderStatus } from "@/lib/db";
import {
  ConflictError,
  InsufficientStockError,
  NotFoundError,
  PermissionDeniedError,
} from "@/lib/errors";
import { buildStoragePath } from "@/lib/security/storage-path";
import {
  customerSchema,
  deliverSchema,
  receptionSchema,
  workItemSchema,
  type ReceptionInput,
  type WorkItemInput,
} from "@/lib/validation/workshop";
import { MAX_PHOTO_BYTES, EXTENSION, sniffImage } from "@/lib/workshop/image";
import { messages } from "@/lib/workshop/messages";
import {
  DEFAULT_OIL_INTERVAL_KM,
  DEFAULT_OIL_INTERVAL_MONTHS,
  nextDue,
} from "@/lib/workshop/reminders-math";
import { canTransition, EDITABLE_STATUSES, WORK_ORDER_LABEL } from "@/lib/workshop/state";
import { computeTotals } from "@/lib/workshop/totals";
import { BUCKETS, getStorage } from "@/server/integrations/storage";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { companyName, notifyCustomer } from "./customer-notify";
import { applyMovement, type AppliedMovement } from "./inventory";
import { registerWarranty } from "./warranties";

const ZERO = new Prisma.Decimal(0);

type Db = TenantTx;

/** OT visible para el usuario: un mecánico solo accede a las que tiene asignadas. */
export async function loadOrder(tx: Db, actor: AuthUser, workOrderId: string) {
  const order = await tx.workOrder.findFirst({
    where: { id: workOrderId },
    include: {
      vehicle: { select: { id: true, plate: true, make: true, model: true, currentMileage: true } },
      customer: { select: { id: true, name: true } },
    },
  });
  if (!order || (isOwnRecordsOnly(actor) && order.assignedMechanicId !== actor.userId))
    throw new NotFoundError("Orden de trabajo");
  return order;
}

/** Cambia el estado con comprobación de la máquina de estados y registro en el historial. */
export async function changeStatus(
  tx: Db,
  order: { id: string; status: WorkOrderStatus },
  to: WorkOrderStatus,
  by: { userId: string | null; note?: string },
): Promise<void> {
  if (!canTransition(order.status, to))
    throw new ConflictError(
      "WO_STATE",
      `No se puede pasar de «${WORK_ORDER_LABEL[order.status]}» a «${WORK_ORDER_LABEL[to]}»`,
    );
  const moved = await tx.workOrder.updateMany({
    where: { id: order.id, status: order.status },
    data: { status: to },
  });
  if (moved.count !== 1)
    throw new ConflictError("WO_STATE", "La orden cambió de estado; recarga la pantalla");
  await tx.workOrderStatusHistory.create({
    data: {
      workOrderId: order.id,
      fromStatus: order.status,
      toStatus: to,
      changedById: by.userId,
      note: by.note ?? null,
    },
  });
}

/** Recalcula subtotal, impuesto y total de la cuenta mixta con el impuesto configurado del tenant. */
export async function recalcTotals(
  tx: Db,
  workOrderId: string,
): Promise<{ subtotal: string; taxTotal: string; total: string }> {
  const [items, settings] = await Promise.all([
    tx.workOrderItem.findMany({ where: { workOrderId } }),
    tx.tenantSettings.findFirstOrThrow({ select: { taxRate: true } }),
  ]);
  const totals = computeTotals(
    items.map((item) => ({
      quantity: Number(item.quantity),
      unitPrice: Number(item.unitPrice),
      discount: Number(item.discount),
      taxable: item.taxAffectation === "TAXED",
      approvalStatus: item.approvalStatus,
      returned: item.partStatus === "RETURNED",
    })),
    Number(settings.taxRate),
  );
  await tx.workOrder.update({
    where: { id: workOrderId },
    data: {
      subtotal: totals.subtotal.toFixed(2),
      taxTotal: totals.taxTotal.toFixed(2),
      total: totals.total.toFixed(2),
    },
  });
  return {
    subtotal: totals.subtotal.toFixed(2),
    taxTotal: totals.taxTotal.toFixed(2),
    total: totals.total.toFixed(2),
  };
}

// ---------------------------------------------------------------------------
// Recepción
// ---------------------------------------------------------------------------

/**
 * Recepción digital. Busca el vehículo por placa (o lo da de alta con su cliente), valida el
 * kilometraje contra el último registrado, guarda el checklist de ingreso y abre la OT.
 */
export async function createWorkOrder(
  actor: AuthUser,
  input: ReceptionInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "workshop:crear");
  const data = receptionSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    let vehicle = data.vehicleId
      ? await tx.vehicle.findFirst({ where: { id: data.vehicleId } })
      : data.plate
        ? await tx.vehicle.findFirst({ where: { plate: data.plate } })
        : null;

    if (!vehicle) {
      if (data.vehicleId) throw new NotFoundError("Vehículo");
      if (!data.plate) throw new NotFoundError("Vehículo");
      let customerId = data.customerId;
      if (!customerId) {
        if (!data.newCustomer)
          throw new ConflictError(
            "VEHICLE_NOT_FOUND",
            `La placa ${data.plate} no está registrada: indica el cliente para darla de alta`,
          );
        requirePermission(actor, "customers:crear");
        const customer = customerSchema.parse(data.newCustomer);
        const existing = await tx.customer.findFirst({
          where: { docType: customer.docType, docNumber: customer.docNumber },
        });
        customerId =
          existing?.id ??
          (
            await tx.customer.create({
              data: {
                docType: customer.docType,
                docNumber: customer.docNumber,
                name: customer.name,
                email: customer.email ?? null,
                phone: customer.phone ?? null,
                whatsapp: customer.whatsapp ?? null,
                whatsappOptIn: customer.whatsappOptIn,
                address: customer.address ?? null,
                notes: customer.notes ?? null,
              },
            })
          ).id;
      } else if (!(await tx.customer.findFirst({ where: { id: customerId } }))) {
        throw new NotFoundError("Cliente");
      }
      vehicle = await tx.vehicle.create({
        data: {
          customerId,
          plate: data.plate,
          make: data.newVehicle?.make ?? null,
          model: data.newVehicle?.model ?? null,
          year: data.newVehicle?.year ?? null,
          engine: data.newVehicle?.engine ?? null,
          color: data.newVehicle?.color ?? null,
          currentMileage: data.mileageIn,
        },
      });
    }

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
    const lowerMileage = vehicle.currentMileage !== null && data.mileageIn < vehicle.currentMileage;
    if (lowerMileage && !data.confirmLowerMileage) {
      throw new ConflictError(
        "MILEAGE_LOWER",
        `El kilometraje ingresado (${data.mileageIn}) es menor al último registrado (${vehicle.currentMileage}). Verifica el tablero y confirma.`,
      );
    }

    const branch = data.branchId
      ? await tx.branch.findFirst({ where: { id: data.branchId } })
      : ((await tx.branch.findFirst({ where: { isMain: true } })) ??
        (await tx.branch.findFirst({ orderBy: { createdAt: "asc" } })));
    if (!branch) throw new NotFoundError("Sucursal");

    const number = await nextSequence(tx, "WO");
    const order = await tx.workOrder.create({
      data: {
        number,
        branchId: branch.id,
        customerId: vehicle.customerId,
        vehicleId: vehicle.id,
        mileageIn: data.mileageIn,
        fuelLevelEighths: data.fuelLevelEighths,
        complaint: data.complaint,
        promisedAt: data.promisedAt ?? null,
        createdById: actor.userId,
        ...(isOwnRecordsOnly(actor) ? { assignedMechanicId: actor.userId } : {}),
        checklist: {
          create: data.checklist.map((entry) => ({
            category: entry.category,
            label: entry.label,
            checked: entry.checked,
            value: entry.value ?? null,
            notes: entry.notes ?? null,
          })),
        },
        statusHistory: {
          create: { toStatus: "RECEIVED", changedById: actor.userId, note: "Recepción digital" },
        },
      },
    });
    if (vehicle.currentMileage === null || data.mileageIn > vehicle.currentMileage)
      await tx.vehicle.update({
        where: { id: vehicle.id },
        data: { currentMileage: data.mileageIn },
      });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.created",
      entityType: "work_order",
      entityId: order.id,
      after: {
        number,
        plate: vehicle.plate,
        mileageIn: data.mileageIn,
        lowerMileageConfirmed: lowerMileage,
      },
      ...(lowerMileage
        ? { reason: "Kilometraje menor al registrado, confirmado por el usuario" }
        : {}),
    });
    return {
      id: order.id,
      number,
      vehicleId: vehicle.id,
      customerId: vehicle.customerId,
      plate: vehicle.plate,
    };
  });
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function listWorkOrders(
  actor: AuthUser,
  filter: { status?: WorkOrderStatus; q?: string; limit?: number } = {},
) {
  requirePermission(actor, "workshop:ver");
  const q = filter.q?.trim();
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.workOrder.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(isOwnRecordsOnly(actor) ? { assignedMechanicId: actor.userId } : {}),
        ...(q
          ? {
              OR: [
                { vehicle: { plate: { contains: q.toUpperCase().replace(/[\s\-._]/g, "") } } },
                { customer: { name: { contains: q, mode: "insensitive" as const } } },
                ...(/^\d+$/.test(q) ? [{ number: Number(q) }] : []),
              ],
            }
          : {}),
      },
      include: {
        vehicle: { select: { plate: true, make: true, model: true } },
        customer: { select: { name: true } },
        assignedMechanic: { select: { name: true } },
      },
      orderBy: [{ receivedAt: "desc" }],
      take: filter.limit ?? 100,
    });
    return rows.map((o) => ({
      id: o.id,
      number: o.number,
      status: o.status,
      plate: o.vehicle.plate,
      vehicle: [o.vehicle.make, o.vehicle.model].filter(Boolean).join(" "),
      customer: o.customer.name,
      mechanic: o.assignedMechanic?.name ?? null,
      receivedAt: o.receivedAt,
      promisedAt: o.promisedAt,
      total: o.total.toFixed(2),
    }));
  });
}

export async function getWorkOrder(actor: AuthUser, workOrderId: string) {
  requirePermission(actor, "workshop:ver");
  const canSeeCost = can(actor, "purchasing:ver_costos_compra");
  const detail = await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    const [items, checklist, photos, history, mechanic, sale] = await Promise.all([
      tx.workOrderItem.findMany({
        where: { workOrderId },
        include: { product: { select: { sku: true, name: true, trackingMode: true } } },
        orderBy: { createdAt: "asc" },
      }),
      tx.workOrderChecklistItem.findMany({ where: { workOrderId } }),
      tx.workOrderPhoto.findMany({ where: { workOrderId }, orderBy: { takenAt: "asc" } }),
      tx.workOrderStatusHistory.findMany({ where: { workOrderId }, orderBy: { changedAt: "asc" } }),
      order.assignedMechanicId
        ? tx.user.findFirst({
            where: { id: order.assignedMechanicId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      tx.sale.findFirst({
        where: { workOrderId, status: { not: "VOIDED" } },
        select: {
          id: true,
          number: true,
          isCredit: true,
          total: true,
          receivable: { select: { balance: true, dueDate: true, status: true } },
        },
      }),
    ]);
    return { order, items, checklist, photos, history, mechanic, sale };
  });
  const storage = getStorage();
  const photos = await Promise.all(
    detail.photos.map(async (photo) => ({
      id: photo.id,
      kind: photo.kind,
      caption: photo.caption,
      takenAt: photo.takenAt,
      url: await storage.signedUrl(BUCKETS.photos, photo.storagePath, 300),
    })),
  );
  const { order } = detail;
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    vehicle: order.vehicle,
    customer: order.customer,
    mechanic: detail.mechanic,
    sale: detail.sale
      ? {
          id: detail.sale.id,
          number: detail.sale.number,
          isCredit: detail.sale.isCredit,
          total: detail.sale.total.toFixed(2),
          balance: detail.sale.receivable?.balance.toFixed(2) ?? null,
          dueDate: detail.sale.receivable?.dueDate ?? null,
          receivableStatus: detail.sale.receivable?.status ?? null,
        }
      : null,
    mileageIn: order.mileageIn,
    mileageOut: order.mileageOut,
    fuelLevelEighths: order.fuelLevelEighths,
    complaint: order.complaint,
    diagnosis: order.diagnosis,
    receivedAt: order.receivedAt,
    promisedAt: order.promisedAt,
    deliveredAt: order.deliveredAt,
    approvedAt: order.approvedAt,
    approvedByName: order.approvedByName,
    approvalMethod: order.approvalMethod,
    approvalPending: Boolean(order.approvalTokenHash),
    approvalExpiresAt: order.approvalTokenExpiresAt,
    currentApprovalRound: order.currentApprovalRound,
    subtotal: order.subtotal.toFixed(2),
    taxTotal: order.taxTotal.toFixed(2),
    total: order.total.toFixed(2),
    items: detail.items.map((item) => ({
      id: item.id,
      type: item.type,
      description: item.description,
      sku: item.product?.sku ?? null,
      trackingMode: item.product?.trackingMode ?? null,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
      discount: item.discount.toString(),
      approvalStatus: item.approvalStatus,
      approvalRound: item.approvalRound,
      partStatus: item.partStatus,
      productId: item.productId,
      ...(canSeeCost ? { unitCost: item.unitCost.toString() } : {}),
    })),
    checklist: detail.checklist,
    photos,
    history: detail.history,
  };
}

// ---------------------------------------------------------------------------
// Asignación y diagnóstico
// ---------------------------------------------------------------------------

export async function assignMechanic(
  actor: AuthUser,
  workOrderId: string,
  mechanicId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  if (isOwnRecordsOnly(actor)) throw new PermissionDeniedError("workshop:asignar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (["DELIVERED", "CANCELLED"].includes(order.status))
      throw new ConflictError("WO_STATE", "La orden ya está cerrada");
    const mechanic = await tx.user.findFirst({
      where: {
        id: mechanicId,
        status: "ACTIVE",
        role: {
          is: {
            deletedAt: null,
            OR: [
              { key: "mechanic" },
              { permissions: { some: { permission: { module: "WORKSHOP", action: "editar" } } } },
            ],
          },
        },
      },
    });
    if (!mechanic)
      throw new ConflictError(
        "NOT_A_MECHANIC",
        "Ese usuario no puede ser asignado a órdenes de trabajo",
      );
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { assignedMechanicId: mechanicId },
    });
    await tx.notification.create({
      data: {
        userId: mechanicId,
        kind: "workorder.assigned",
        severity: "INFO",
        title: `Te asignaron la OT #${order.number}`,
        body: `${order.vehicle.plate} · ${order.complaint ?? ""}`.slice(0, 200),
        data: { workOrderId },
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.assigned",
      entityType: "work_order",
      entityId: workOrderId,
      before: { mechanicId: order.assignedMechanicId },
      after: { mechanicId },
    });
  });
}

/** Usuarios activos que pueden recibir órdenes (rol Mecánico o con permiso de editar el taller). */
export async function listAssignableMechanics(actor: AuthUser) {
  requirePermission(actor, "workshop:editar");
  return withTenant(requireTenantId(actor), (tx) =>
    tx.user.findMany({
      where: {
        status: "ACTIVE",
        role: {
          is: {
            deletedAt: null,
            OR: [
              { key: "mechanic" },
              { permissions: { some: { permission: { module: "WORKSHOP", action: "editar" } } } },
            ],
          },
        },
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  );
}

export async function startDiagnosis(
  actor: AuthUser,
  workOrderId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    await changeStatus(tx, order, "DIAGNOSING", { userId: actor.userId });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.diagnosis_started",
      entityType: "work_order",
      entityId: workOrderId,
    });
  });
}

export async function saveDiagnosis(
  actor: AuthUser,
  workOrderId: string,
  diagnosis: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  const text = diagnosis.trim();
  if (text.length < 3 || text.length > 2000 || text.includes("\u0000"))
    throw new ConflictError(
      "DIAGNOSIS_INVALID",
      "El diagnóstico debe tener entre 3 y 2000 caracteres",
    );
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (!EDITABLE_STATUSES.includes(order.status))
      throw new ConflictError("WO_STATE", "La orden ya no admite cambios");
    await tx.workOrder.update({ where: { id: workOrderId }, data: { diagnosis: text } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.diagnosis_saved",
      entityType: "work_order",
      entityId: workOrderId,
      before: { diagnosis: order.diagnosis },
      after: { diagnosis: text },
    });
  });
}

// ---------------------------------------------------------------------------
// Ítems: mano de obra + repuestos, con rondas de aprobación
// ---------------------------------------------------------------------------

/**
 * Agrega mano de obra o un repuesto (solicitud de repuesto, también para el mecánico).
 * Tras una aprobación previa, todo trabajo nuevo abre una RONDA nueva que el cliente debe
 * aprobar: el presupuesto aprobado nunca cambia en silencio. Precios y descuentos fuera del
 * catálogo exigen el permiso de descuentos.
 */
export async function addItem(
  actor: AuthUser,
  workOrderId: string,
  input: WorkItemInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "workshop:editar");
  const data = workItemSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (!EDITABLE_STATUSES.includes(order.status))
      throw new ConflictError(
        "WO_STATE",
        `La orden está «${WORK_ORDER_LABEL[order.status]}» y ya no admite ítems; reábrela si hace falta`,
      );

    const product = data.productId
      ? await tx.product.findFirst({ where: { id: data.productId } })
      : null;
    if (data.productId && !product) throw new NotFoundError("Producto");
    if (data.type === "PART" && (!product || !product.isStocked))
      throw new ConflictError(
        "PART_REQUIRES_PRODUCT",
        "Un repuesto debe ser un producto con stock del catálogo",
      );
    if (data.type === "LABOR" && product && product.isStocked)
      throw new ConflictError(
        "LABOR_PRODUCT",
        "La mano de obra usa un servicio del catálogo, no un producto con stock",
      );

    const description = (data.description ?? product?.name ?? "").trim();
    if (!description) throw new ConflictError("DESCRIPTION_REQUIRED", "Describe el trabajo");
    const unitPrice = data.unitPrice ?? product?.salePrice.toString();
    if (unitPrice === undefined)
      throw new ConflictError("PRICE_REQUIRED", "Indica el precio de la mano de obra");
    const customPrice =
      data.unitPrice !== undefined && (!product || !product.salePrice.eq(data.unitPrice));
    const discount = data.discount ?? "0";
    if (
      (customPrice || new Prisma.Decimal(discount).gt(0)) &&
      !can(actor, "pos:aplicar_descuentos")
    )
      throw new PermissionDeniedError("pos:aplicar_descuentos");
    if (new Prisma.Decimal(discount).gt(new Prisma.Decimal(unitPrice).times(data.quantity)))
      throw new ConflictError("DISCOUNT_TOO_HIGH", "El descuento supera el valor de la línea");

    // Ronda de aprobación.
    const [pending, decided] = await Promise.all([
      tx.workOrderItem.count({ where: { workOrderId, approvalStatus: "PENDING" } }),
      tx.workOrderItem.count({
        where: { workOrderId, approvalStatus: { in: ["APPROVED", "REJECTED"] } },
      }),
    ]);
    let round = order.currentApprovalRound;
    let opensNewRound = false;
    if (pending === 0 && decided > 0) {
      round += 1;
      opensNewRound = true;
      await tx.workOrder.update({
        where: { id: workOrderId },
        data: {
          currentApprovalRound: round,
          approvalTokenHash: null,
          approvalTokenExpiresAt: null,
        },
      });
    }
    if (opensNewRound || (pending > 0 && ["IN_REPAIR", "AWAITING_PARTS"].includes(order.status))) {
      if (["IN_REPAIR", "AWAITING_PARTS"].includes(order.status))
        await changeStatus(tx, order, "AWAITING_APPROVAL", {
          userId: actor.userId,
          note: "Trabajo adicional pendiente de aprobación del cliente",
        });
    }

    const policyId =
      data.type === "LABOR" ? (data.warrantyPolicyId ?? product?.warrantyPolicyId ?? null) : null;
    if (policyId && !(await tx.warrantyPolicy.findFirst({ where: { id: policyId } })))
      throw new NotFoundError("Política de garantía");
    const item = await tx.workOrderItem.create({
      data: {
        workOrderId,
        type: data.type,
        productId: product?.id ?? null,
        description,
        quantity: data.quantity,
        unitPrice,
        discount,
        taxAffectation: product?.taxAffectation ?? "TAXED",
        approvalRound: round,
        approvalStatus: "PENDING",
        partStatus: data.type === "PART" ? "REQUESTED" : "NOT_APPLICABLE",
        mechanicId: data.type === "LABOR" && isOwnRecordsOnly(actor) ? actor.userId : null,
        warrantyPolicyId: policyId,
      },
    });
    const totals = await recalcTotals(tx, workOrderId);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: data.type === "PART" ? "workorder.part_requested" : "workorder.labor_added",
      entityType: "work_order",
      entityId: workOrderId,
      after: {
        itemId: item.id,
        description,
        quantity: data.quantity,
        unitPrice,
        discount,
        round,
        total: totals.total,
      },
    });
    return { id: item.id, round, opensNewRound, total: totals.total };
  });
}

export async function removeItem(
  actor: AuthUser,
  workOrderId: string,
  itemId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    const item = await tx.workOrderItem.findFirst({ where: { id: itemId, workOrderId } });
    if (!item) throw new NotFoundError("Ítem");
    if (!EDITABLE_STATUSES.includes(order.status))
      throw new ConflictError("WO_STATE", "La orden ya no admite cambios");
    if (item.approvalStatus === "APPROVED" || item.partStatus === "ISSUED")
      throw new ConflictError(
        "ITEM_LOCKED",
        "Un ítem aprobado o con repuesto entregado no se puede quitar",
      );
    await tx.workOrderItem.delete({ where: { id: itemId } });
    await recalcTotals(tx, workOrderId);
    // Si ya no queda nada por aprobar, el enlace pendiente pierde sentido.
    if (
      (await tx.workOrderItem.count({ where: { workOrderId, approvalStatus: "PENDING" } })) === 0 &&
      order.status === "AWAITING_APPROVAL"
    ) {
      await tx.workOrder.update({
        where: { id: workOrderId },
        data: { approvalTokenHash: null, approvalTokenExpiresAt: null },
      });
      await changeStatus(tx, order, order.approvedAt ? "IN_REPAIR" : "DIAGNOSING", {
        userId: actor.userId,
        note: "Sin ítems pendientes de aprobación",
      });
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.item_removed",
      entityType: "work_order",
      entityId: workOrderId,
      before: { itemId, description: item.description, quantity: item.quantity.toString() },
    });
  });
}

// ---------------------------------------------------------------------------
// Repuestos: entrega desde el almacén (kardex) y devolución
// ---------------------------------------------------------------------------

async function defaultWarehouse(tx: Db, branchId: string, preferred?: string) {
  if (preferred) return tx.warehouse.findFirst({ where: { id: preferred, isActive: true } });
  return (
    (await tx.warehouse.findFirst({ where: { branchId, isDefault: true, isActive: true } })) ??
    (await tx.warehouse.findFirst({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { code: "asc" }],
    }))
  );
}

export interface IssuePartResult {
  replayed: boolean;
  movements: number;
}

/**
 * El almacén entrega el repuesto de un ítem APROBADO: sale del kardex (FEFO en llantas, serie
 * en baterías) y queda la serie/DOT vinculado a la OT. Sin stock, la OT pasa a «Esperando
 * repuesto» y se avisa. Idempotente: una segunda entrega del mismo ítem no descuenta otra vez.
 */
export async function issuePart(
  actor: AuthUser,
  workOrderId: string,
  itemId: string,
  options: { warehouseId?: string; serials?: string[]; lotId?: string } = {},
  meta: RequestMeta = {},
): Promise<IssuePartResult> {
  requirePermission(actor, "inventory:editar");
  const tenantId = requireTenantId(actor);
  try {
    return await withTenant(tenantId, async (tx) => {
      const order = await tx.workOrder.findFirst({ where: { id: workOrderId } });
      if (!order) throw new NotFoundError("Orden de trabajo");
      if (["DELIVERED", "CANCELLED"].includes(order.status))
        throw new ConflictError("WO_STATE", "La orden está cerrada");
      const item = await tx.workOrderItem.findFirst({
        where: { id: itemId, workOrderId, type: "PART" },
        include: { product: true },
      });
      if (!item?.product) throw new NotFoundError("Repuesto de la orden");
      if (item.partStatus === "ISSUED") return { replayed: true, movements: 0 };
      if (item.approvalStatus !== "APPROVED")
        throw new ConflictError(
          "ITEM_NOT_APPROVED",
          "El cliente aún no aprobó este repuesto: no se puede entregar",
        );
      if (item.partStatus !== "REQUESTED")
        throw new ConflictError("ITEM_STATE", "El repuesto no está pendiente de entrega");

      const warehouse = await defaultWarehouse(tx, order.branchId, options.warehouseId);
      if (!warehouse) throw new NotFoundError("Almacén");
      const serial = item.product.trackingMode === "SERIAL";
      const outcome = await applyMovement(tx, {
        warehouseId: warehouse.id,
        productId: item.product.id,
        type: "WORK_ORDER_CONSUMPTION",
        ...(serial ? { serials: options.serials } : { quantity: item.quantity.toString() }),
        ...(options.lotId ? { lotId: options.lotId } : {}),
        referenceType: "work_order",
        referenceId: workOrderId,
        idempotencyKey: `wo-issue:${item.id}`,
        createdById: actor.userId,
      });
      const claimed = await tx.workOrderItem.updateMany({
        where: { id: item.id, partStatus: "REQUESTED" },
        data: {
          partStatus: "ISSUED",
          consumptionMovementId: outcome.movements[0]?.id ?? null,
          unitCost: weightedCost(outcome.movements).toString(),
        },
      });
      if (claimed.count !== 1) return { replayed: true, movements: 0 };

      if (order.status === "AWAITING_PARTS") {
        const missing = await tx.workOrderItem.count({
          where: { workOrderId, type: "PART", approvalStatus: "APPROVED", partStatus: "REQUESTED" },
        });
        const pending = await tx.workOrderItem.count({
          where: { workOrderId, approvalStatus: "PENDING" },
        });
        if (missing === 0 && pending === 0)
          await changeStatus(tx, order, "IN_REPAIR", {
            userId: actor.userId,
            note: "Repuestos completos",
          });
      }
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "workorder.part_issued",
        entityType: "work_order",
        entityId: workOrderId,
        after: {
          itemId,
          productId: item.product.id,
          quantity: item.quantity.toString(),
          warehouseId: warehouse.id,
          movements: outcome.movements.length,
        },
      });
      return { replayed: outcome.replayed, movements: outcome.movements.length };
    });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      // Sin stock: la OT espera el repuesto y se avisa al almacén (en una transacción aparte, la anterior se revirtió).
      await withTenant(tenantId, async (tx) => {
        const order = await tx.workOrder.findFirst({ where: { id: workOrderId } });
        const item = await tx.workOrderItem.findFirst({ where: { id: itemId } });
        if (order && order.status === "IN_REPAIR")
          await changeStatus(tx, order, "AWAITING_PARTS", {
            userId: actor.userId,
            note: "Sin stock del repuesto solicitado",
          });
        if (order && item) {
          await tx.notification.createMany({
            data: [
              {
                kind: "workorder.part_missing",
                severity: "WARNING",
                title: `Falta repuesto para la OT #${order.number}`,
                body: `${item.description}: no hay stock suficiente.`,
                data: { workOrderId, itemId },
                dedupeKey: `part-missing:${itemId}`,
              },
            ],
            skipDuplicates: true,
          });
        }
      });
    }
    throw error;
  }
}

function weightedCost(movements: AppliedMovement[]): Prisma.Decimal {
  let value = ZERO;
  let qty = ZERO;
  for (const movement of movements) {
    const q = new Prisma.Decimal(movement.quantityDelta).abs();
    value = value.plus(new Prisma.Decimal(movement.unitCost ?? 0).times(q));
    qty = qty.plus(q);
  }
  return qty.gt(0) ? value.div(qty).toDecimalPlaces(4) : ZERO;
}

/** Devuelve al almacén un repuesto entregado y no usado: reingresa por el kardex y deja de cobrarse. */
async function returnPartInTx(
  tx: Db,
  actor: AuthUser,
  itemId: string,
  reason: string,
): Promise<void> {
  const item = await tx.workOrderItem.findFirst({
    where: { id: itemId, type: "PART", partStatus: "ISSUED" },
  });
  if (!item || !item.productId)
    throw new ConflictError("ITEM_STATE", "El repuesto no está entregado");
  const originals = await tx.kardexMovement.findMany({
    where: {
      OR: [
        { idempotencyKey: `wo-issue:${item.id}` },
        { idempotencyKey: { startsWith: `wo-issue:${item.id}#` } },
      ],
    },
  });
  for (const [index, original] of originals.entries()) {
    const serial = original.serialId
      ? await tx.serialNumber.findFirst({ where: { id: original.serialId } })
      : null;
    await applyMovement(tx, {
      warehouseId: original.warehouseId,
      productId: item.productId,
      type: "WORK_ORDER_RETURN",
      ...(serial
        ? { serials: [serial.serial] }
        : { quantity: new Prisma.Decimal(original.quantityDelta).abs().toString() }),
      ...(original.lotId ? { lotId: original.lotId } : {}),
      unitCost: original.unitCost?.toString() ?? "0",
      reason,
      referenceType: "work_order",
      referenceId: original.referenceId ?? undefined,
      idempotencyKey: `wo-return:${item.id}:${index}`,
      createdById: actor.userId,
    });
  }
  await tx.workOrderItem.update({ where: { id: item.id }, data: { partStatus: "RETURNED" } });
}

export async function returnPart(
  actor: AuthUser,
  workOrderId: string,
  itemId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "inventory:editar");
  if (reason.trim().length < 5)
    throw new ConflictError("REASON_REQUIRED", "Indica el motivo de la devolución");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await tx.workOrder.findFirst({ where: { id: workOrderId } });
    if (!order) throw new NotFoundError("Orden de trabajo");
    if (["DELIVERED", "CANCELLED"].includes(order.status))
      throw new ConflictError("WO_STATE", "La orden está cerrada");
    await returnPartInTx(tx, actor, itemId, reason);
    await recalcTotals(tx, workOrderId);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.part_returned",
      entityType: "work_order",
      entityId: workOrderId,
      after: { itemId },
      reason,
    });
  });
}

// ---------------------------------------------------------------------------
// Ejecución, entrega y cancelación
// ---------------------------------------------------------------------------

/** Tras aprobar, el mecánico arranca la reparación (si faltan repuestos queda esperándolos). */
export async function startRepair(
  actor: AuthUser,
  workOrderId: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (await tx.workOrderItem.count({ where: { workOrderId, approvalStatus: "PENDING" } }))
      throw new ConflictError(
        "APPROVAL_PENDING",
        "Hay trabajos pendientes de aprobación del cliente",
      );
    if (!(await tx.workOrderItem.count({ where: { workOrderId, approvalStatus: "APPROVED" } })))
      throw new ConflictError("NOT_APPROVED", "El cliente aún no aprobó el presupuesto");
    const missing = await tx.workOrderItem.count({
      where: { workOrderId, type: "PART", approvalStatus: "APPROVED", partStatus: "REQUESTED" },
    });
    await changeStatus(tx, order, missing > 0 ? "AWAITING_PARTS" : "IN_REPAIR", {
      userId: actor.userId,
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.repair_started",
      entityType: "work_order",
      entityId: workOrderId,
    });
  });
}

/** «Lista para entrega»: exige que no queden aprobaciones ni repuestos pendientes; avisa al cliente. */
export async function markReady(actor: AuthUser, workOrderId: string, meta: RequestMeta = {}) {
  requirePermission(actor, "workshop:editar");
  return withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (order.status !== "IN_REPAIR")
      throw new ConflictError("WO_STATE", "Solo una orden «En reparación» puede pasar a lista");
    if (await tx.workOrderItem.count({ where: { workOrderId, approvalStatus: "PENDING" } }))
      throw new ConflictError(
        "APPROVAL_PENDING",
        "Hay trabajos pendientes de aprobación del cliente",
      );
    if (
      await tx.workOrderItem.count({
        where: { workOrderId, type: "PART", approvalStatus: "APPROVED", partStatus: "REQUESTED" },
      })
    )
      throw new ConflictError("PARTS_PENDING", "Hay repuestos aprobados sin entregar");
    await changeStatus(tx, order, "READY", { userId: actor.userId });
    const notified = await notifyCustomer(tx, {
      customerId: order.customerId,
      key: `wo-ready:${workOrderId}`,
      relatedType: "work_order",
      relatedId: workOrderId,
      body: messages.vehicleReady({
        customer: order.customer.name,
        company: await companyName(tx),
        plate: order.vehicle.plate,
      }),
    });
    await tx.notification.createMany({
      data: [
        {
          kind: "workorder.ready",
          severity: "INFO",
          title: `OT #${order.number} lista para entrega`,
          body: `${order.vehicle.plate} · ${order.customer.name}`,
          data: { workOrderId },
          dedupeKey: `wo-ready:${workOrderId}`,
        },
      ],
      skipDuplicates: true,
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.ready",
      entityType: "work_order",
      entityId: workOrderId,
      after: { customerNotified: notified },
    });
    return { customerNotified: notified };
  });
}

export async function reopen(
  actor: AuthUser,
  workOrderId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  if (reason.trim().length < 5)
    throw new ConflictError("REASON_REQUIRED", "Indica por qué se reabre la orden");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    await changeStatus(tx, order, "IN_REPAIR", { userId: actor.userId, note: reason });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.reopened",
      entityType: "work_order",
      entityId: workOrderId,
      reason,
    });
  });
}

/**
 * Entrega del vehículo: registra el kilometraje de salida, ACTIVA LAS GARANTÍAS (repuestos con la
 * serie de la batería o el DOT de la llanta, y mano de obra con su política) y programa el
 * próximo cambio de aceite si se usó lubricante. Cobro y comprobante: Fase 6.
 */
export async function deliverWorkOrder(
  actor: AuthUser,
  input: { workOrderId: string; mileageOut: number | string; notes?: string },
  meta: RequestMeta = {},
  now: Date = new Date(),
) {
  requirePermission(actor, "workshop:editar");
  if (isOwnRecordsOnly(actor)) throw new PermissionDeniedError("workshop:entregar");
  const data = deliverSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, data.workOrderId);
    if (order.status !== "READY")
      throw new ConflictError("WO_STATE", "Solo una orden «Lista para entrega» se puede entregar");
    if (order.mileageIn !== null && data.mileageOut < order.mileageIn)
      throw new ConflictError(
        "MILEAGE_OUT",
        `El kilometraje de salida no puede ser menor al de ingreso (${order.mileageIn})`,
      );

    await changeStatus(tx, order, "DELIVERED", { userId: actor.userId, note: data.notes });
    await tx.workOrder.update({
      where: { id: order.id },
      data: { deliveredAt: now, mileageOut: data.mileageOut },
    });
    if (order.vehicle.currentMileage === null || data.mileageOut > order.vehicle.currentMileage)
      await tx.vehicle.update({
        where: { id: order.vehicleId },
        data: { currentMileage: data.mileageOut },
      });

    const items = await tx.workOrderItem.findMany({
      where: { workOrderId: order.id, approvalStatus: "APPROVED" },
      include: { product: true },
    });
    let warranties = 0;
    let reminders = 0;
    let oilChange = false;
    for (const item of items) {
      if (item.type === "PART" && item.partStatus === "ISSUED" && item.product) {
        if (item.product.kind === "LUBRICANT") oilChange = true;
        if (!item.product.warrantyPolicyId) continue;
        const movement = item.consumptionMovementId
          ? await tx.kardexMovement.findFirst({ where: { id: item.consumptionMovementId } })
          : null;
        const created = await registerWarranty(tx, {
          source: "WORK_ORDER_ITEM",
          customerId: order.customerId,
          vehicleId: order.vehicleId,
          productId: item.product.id,
          policyId: item.product.warrantyPolicyId,
          workOrderItemId: item.id,
          serialId: movement?.serialId ?? null,
          lotId: movement?.lotId ?? null,
          description: `${item.description} (OT #${order.number})`,
          startsAt: now,
          startMileage: data.mileageOut,
        });
        if (created) warranties += 1;
      } else if (item.type === "LABOR" && item.warrantyPolicyId) {
        const created = await registerWarranty(tx, {
          source: "WORK_ORDER_ITEM",
          customerId: order.customerId,
          vehicleId: order.vehicleId,
          productId: item.productId,
          policyId: item.warrantyPolicyId,
          workOrderItemId: item.id,
          description: `Mano de obra: ${item.description} (OT #${order.number})`,
          startsAt: now,
          startMileage: data.mileageOut,
        });
        if (created) warranties += 1;
      }
    }
    if (oilChange) {
      await tx.maintenanceReminder.updateMany({
        where: {
          vehicleId: order.vehicleId,
          description: "Cambio de aceite",
          status: { in: ["PENDING", "NOTIFIED"] },
        },
        data: { status: "DONE" },
      });
      const due = nextDue(
        { date: now, mileage: data.mileageOut },
        { months: DEFAULT_OIL_INTERVAL_MONTHS, km: DEFAULT_OIL_INTERVAL_KM },
      );
      await tx.maintenanceReminder.create({
        data: {
          vehicleId: order.vehicleId,
          description: "Cambio de aceite",
          dueDate: due.dueDate,
          dueMileage: due.dueMileage,
          intervalMonths: DEFAULT_OIL_INTERVAL_MONTHS,
          intervalKm: DEFAULT_OIL_INTERVAL_KM,
          sourceWorkOrderId: order.id,
        },
      });
      reminders += 1;
    }
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.delivered",
      entityType: "work_order",
      entityId: order.id,
      after: { mileageOut: data.mileageOut, total: order.total.toString(), warranties, reminders },
    });
    return { warranties, reminders };
  });
}

/** Cancela la OT. Si ya se entregaron repuestos, hay que devolverlos (o pedir la devolución automática). */
export async function cancelWorkOrder(
  actor: AuthUser,
  workOrderId: string,
  reason: string,
  options: { returnParts?: boolean } = {},
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  if (reason.trim().length < 5)
    throw new ConflictError("REASON_REQUIRED", "Indica el motivo de la cancelación");
  await withTenant(requireTenantId(actor), async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    const issued = await tx.workOrderItem.findMany({
      where: { workOrderId, type: "PART", partStatus: "ISSUED" },
    });
    if (issued.length > 0) {
      if (!options.returnParts)
        throw new ConflictError(
          "PARTS_ISSUED",
          `Hay ${issued.length} repuesto(s) entregado(s): devuélvelos al almacén o cancela devolviéndolos`,
        );
      requirePermission(actor, "inventory:editar");
      for (const item of issued)
        await returnPartInTx(
          tx,
          actor,
          item.id,
          `Cancelación de la OT #${order.number}: ${reason}`,
        );
    }
    await changeStatus(tx, order, "CANCELLED", { userId: actor.userId, note: reason });
    await tx.workOrder.update({
      where: { id: workOrderId },
      data: { approvalTokenHash: null, approvalTokenExpiresAt: null },
    });
    await recalcTotals(tx, workOrderId);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.cancelled",
      entityType: "work_order",
      entityId: workOrderId,
      reason,
      after: { returnedParts: issued.length },
    });
  });
}

// ---------------------------------------------------------------------------
// Fotos
// ---------------------------------------------------------------------------

/**
 * Sube una foto de recepción/daños/avance. Se valida el contenido REAL del archivo (JPG, PNG o
 * WebP, máx. 5 MB) y se guarda bajo `{tenantId}/work-orders/{OT}/...` en un bucket privado.
 */
export async function addPhoto(
  actor: AuthUser,
  workOrderId: string,
  input: {
    kind: "INTAKE" | "DAMAGE" | "PROGRESS" | "DELIVERY";
    caption?: string;
    bytes: Uint8Array;
  },
  meta: RequestMeta = {},
) {
  requirePermission(actor, "workshop:editar");
  const tenantId = requireTenantId(actor);
  if (input.bytes.length === 0 || input.bytes.length > MAX_PHOTO_BYTES)
    throw new ConflictError("PHOTO_SIZE", "La foto debe pesar entre 1 byte y 5 MB");
  const type = sniffImage(input.bytes);
  if (!type) throw new ConflictError("PHOTO_TYPE", "Solo se aceptan fotos JPG, PNG o WebP");
  const caption = input.caption?.trim().slice(0, 200) || null;
  if (caption?.includes("\u0000")) throw new ConflictError("PHOTO_CAPTION", "Descripción inválida");

  return withTenant(tenantId, async (tx) => {
    const order = await loadOrder(tx, actor, workOrderId);
    if (order.status === "CANCELLED")
      throw new ConflictError("WO_STATE", "La orden está cancelada");
    if ((await tx.workOrderPhoto.count({ where: { workOrderId } })) >= 40)
      throw new ConflictError("PHOTO_LIMIT", "Máximo 40 fotos por orden");
    const path = buildStoragePath(
      tenantId,
      "work-orders",
      workOrderId,
      `${randomUUID()}.${EXTENSION[type]}`,
    );
    const photo = await tx.workOrderPhoto.create({
      data: {
        workOrderId,
        kind: input.kind,
        storagePath: path,
        caption,
        uploadedById: actor.userId,
      },
    });
    // Si la subida falla, la transacción se revierte y no queda la fila huérfana.
    await getStorage().put(BUCKETS.photos, path, input.bytes, type);
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "workorder.photo_added",
      entityType: "work_order",
      entityId: workOrderId,
      after: { photoId: photo.id, kind: input.kind, bytes: input.bytes.length },
    });
    return { id: photo.id };
  });
}
