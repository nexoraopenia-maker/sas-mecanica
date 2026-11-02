import {
  can,
  isOwnRecordsOnly,
  requirePermission,
  requireTenantId,
  type AuthUser,
} from "@/lib/auth/can";
import { Prisma, withTenant } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  vehicleSchema,
  vehicleUpdateSchema,
  plateSchema,
  type VehicleInput,
  type VehicleUpdateInput,
} from "@/lib/validation/workshop";
import { coverage, COVERAGE_LABEL } from "@/lib/workshop/warranty-math";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";

function isPlateTaken(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta ?? {})
      .toLowerCase()
      .includes("plate")
  );
}

/** Vincula un vehículo (por placa) a un cliente. Un cliente puede tener varios vehículos. */
export async function createVehicle(actor: AuthUser, input: VehicleInput, meta: RequestMeta = {}) {
  if (!can(actor, "customers:crear")) requirePermission(actor, "workshop:crear");
  const data = vehicleSchema.parse(input);
  try {
    return await withTenant(requireTenantId(actor), async (tx) => {
      if (!(await tx.customer.findFirst({ where: { id: data.customerId } })))
        throw new NotFoundError("Cliente");
      const vehicle = await tx.vehicle.create({
        data: {
          customerId: data.customerId,
          plate: data.plate,
          make: data.make ?? null,
          model: data.model ?? null,
          year: data.year ?? null,
          engine: data.engine ?? null,
          vin: data.vin ?? null,
          color: data.color ?? null,
          fuelType: data.fuelType ?? null,
          currentMileage: data.currentMileage ?? null,
        },
      });
      await recordAudit(tx, auditContextOf(actor, meta), {
        action: "vehicle.created",
        entityType: "vehicle",
        entityId: vehicle.id,
        after: { plate: vehicle.plate, customerId: data.customerId },
      });
      return { id: vehicle.id, plate: vehicle.plate };
    });
  } catch (error) {
    if (isPlateTaken(error))
      throw new ConflictError("PLATE_TAKEN", `La placa ${data.plate} ya está registrada`);
    throw error;
  }
}

/** El kilometraje solo sube. Bajarlo (error de digitación) exige motivo y queda auditado. */
export async function updateVehicle(
  actor: AuthUser,
  vehicleId: string,
  input: VehicleUpdateInput,
  meta: RequestMeta = {},
): Promise<void> {
  if (!can(actor, "customers:editar")) requirePermission(actor, "workshop:editar");
  const data = vehicleUpdateSchema.parse(input);
  await withTenant(requireTenantId(actor), async (tx) => {
    const before = await tx.vehicle.findFirst({ where: { id: vehicleId } });
    if (!before) throw new NotFoundError("Vehículo");
    if (
      data.currentMileage !== undefined &&
      before.currentMileage !== null &&
      data.currentMileage < before.currentMileage &&
      !data.mileageCorrectionReason
    ) {
      throw new ConflictError(
        "MILEAGE_DECREASE",
        `El kilometraje registrado es ${before.currentMileage}; para bajarlo indica el motivo de la corrección`,
      );
    }
    const { mileageCorrectionReason, ...fields } = data;
    const after = await tx.vehicle.update({
      where: { id: vehicleId },
      data: Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "vehicle.updated",
      entityType: "vehicle",
      entityId: vehicleId,
      before: { currentMileage: before.currentMileage, make: before.make, model: before.model },
      after: { currentMileage: after.currentMileage, make: after.make, model: after.model },
      ...(mileageCorrectionReason ? { reason: mileageCorrectionReason } : {}),
    });
  });
}

/** Cambio de propietario. Las garantías ya emitidas siguen a nombre de quien compró. */
export async function transferVehicle(
  actor: AuthUser,
  vehicleId: string,
  newCustomerId: string,
  reason: string,
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "customers:editar");
  if (reason.trim().length < 5)
    throw new ConflictError("REASON_REQUIRED", "Indica el motivo del cambio de propietario");
  await withTenant(requireTenantId(actor), async (tx) => {
    const [vehicle, customer] = await Promise.all([
      tx.vehicle.findFirst({ where: { id: vehicleId } }),
      tx.customer.findFirst({ where: { id: newCustomerId } }),
    ]);
    if (!vehicle) throw new NotFoundError("Vehículo");
    if (!customer) throw new NotFoundError("Cliente");
    if (
      await tx.workOrder.count({
        where: { vehicleId, status: { notIn: ["DELIVERED", "CANCELLED"] } },
      })
    ) {
      throw new ConflictError(
        "VEHICLE_OPEN_ORDERS",
        "El vehículo tiene una orden de trabajo abierta",
      );
    }
    await tx.vehicle.update({ where: { id: vehicleId }, data: { customerId: newCustomerId } });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "vehicle.transferred",
      entityType: "vehicle",
      entityId: vehicleId,
      before: { customerId: vehicle.customerId },
      after: { customerId: newCustomerId },
      reason,
    });
  });
}

/** Búsqueda por placa en cualquier formato (abc-123, ABC 123...). */
export async function findVehicleByPlate(actor: AuthUser, plateInput: string) {
  requirePermission(actor, "workshop:ver");
  const plate = plateSchema.parse(plateInput);
  return withTenant(requireTenantId(actor), async (tx) => {
    const vehicle = await tx.vehicle.findFirst({
      where: { plate },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            docType: true,
            docNumber: true,
            phone: true,
            whatsapp: true,
          },
        },
      },
    });
    if (!vehicle) return null;
    if (
      isOwnRecordsOnly(actor) &&
      !(await tx.workOrder.findFirst({
        where: { vehicleId: vehicle.id, assignedMechanicId: actor.userId },
        select: { id: true },
      }))
    )
      return null;
    return vehicle;
  });
}

export interface VehicleHistory {
  vehicle: {
    id: string;
    plate: string;
    make: string | null;
    model: string | null;
    year: number | null;
    currentMileage: number | null;
  };
  customer: { id: string; name: string };
  openWorkOrders: Array<{ id: string; number: number; status: string }>;
  mileageTimeline: Array<{
    at: Date;
    mileage: number;
    workOrderNumber: number;
    kind: "INGRESO" | "SALIDA";
  }>;
  services: Array<{
    workOrderNumber: number;
    date: Date;
    mileage: number | null;
    description: string;
    mechanicId: string | null;
  }>;
  partsInstalled: Array<{
    workOrderNumber: number;
    date: Date;
    sku: string | null;
    name: string;
    quantity: string;
    serial: string | null;
    dotCode: string | null;
    lotCode: string | null;
  }>;
  warranties: Array<{
    id: string;
    description: string;
    status: string;
    expiresAt: Date | null;
    expiresAtMileage: number | null;
    covered: boolean;
    reasons: string[];
  }>;
  upcomingMaintenance: Array<{
    id: string;
    description: string;
    dueDate: Date | null;
    dueMileage: number | null;
    status: string;
  }>;
}

/**
 * Historial técnico por vehículo: kilometraje a lo largo del tiempo, servicios realizados,
 * repuestos instalados (con la serie de la batería o el DOT de la llanta), garantías vigentes
 * y próximas mantenciones. Un mecánico solo lo ve si trabajó en ese vehículo.
 */
export async function getVehicleHistory(
  actor: AuthUser,
  vehicleId: string,
  now: Date = new Date(),
): Promise<VehicleHistory> {
  requirePermission(actor, "workshop:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!vehicle) throw new NotFoundError("Vehículo");
    if (
      isOwnRecordsOnly(actor) &&
      !(await tx.workOrder.findFirst({
        where: { vehicleId, assignedMechanicId: actor.userId },
        select: { id: true },
      }))
    )
      throw new NotFoundError("Vehículo");

    const orders = await tx.workOrder.findMany({
      where: { vehicleId },
      orderBy: { receivedAt: "desc" },
      include: { items: { include: { product: { select: { sku: true, name: true } } } } },
    });
    const movementIds = orders.flatMap((o) =>
      o.items.flatMap((i) => (i.consumptionMovementId ? [i.consumptionMovementId] : [])),
    );
    const movements = await tx.kardexMovement.findMany({
      where: { id: { in: movementIds } },
      include: {
        serial: { select: { serial: true } },
        lot: { select: { code: true, dotCode: true } },
      },
    });
    const movementById = new Map(movements.map((m) => [m.id, m]));

    const delivered = orders.filter((o) => o.status === "DELIVERED");
    const [warranties, reminders] = await Promise.all([
      tx.warranty.findMany({ where: { vehicleId }, orderBy: { startsAt: "desc" } }),
      tx.maintenanceReminder.findMany({
        where: { vehicleId, status: { in: ["PENDING", "NOTIFIED"] } },
        orderBy: [{ dueDate: "asc" }],
      }),
    ]);

    return {
      vehicle: {
        id: vehicle.id,
        plate: vehicle.plate,
        make: vehicle.make,
        model: vehicle.model,
        year: vehicle.year,
        currentMileage: vehicle.currentMileage,
      },
      customer: vehicle.customer,
      openWorkOrders: orders
        .filter((o) => !["DELIVERED", "CANCELLED"].includes(o.status))
        .map((o) => ({ id: o.id, number: o.number, status: o.status })),
      mileageTimeline: orders
        .flatMap((o) => [
          ...(o.mileageIn !== null
            ? [
                {
                  at: o.receivedAt,
                  mileage: o.mileageIn,
                  workOrderNumber: o.number,
                  kind: "INGRESO" as const,
                },
              ]
            : []),
          ...(o.mileageOut !== null && o.deliveredAt
            ? [
                {
                  at: o.deliveredAt,
                  mileage: o.mileageOut,
                  workOrderNumber: o.number,
                  kind: "SALIDA" as const,
                },
              ]
            : []),
        ])
        .sort((a, b) => b.at.getTime() - a.at.getTime()),
      services: delivered.flatMap((o) =>
        o.items
          .filter((i) => i.type === "LABOR" && i.approvalStatus === "APPROVED")
          .map((i) => ({
            workOrderNumber: o.number,
            date: o.deliveredAt ?? o.receivedAt,
            mileage: o.mileageOut ?? o.mileageIn,
            description: i.description,
            mechanicId: o.assignedMechanicId,
          })),
      ),
      partsInstalled: orders.flatMap((o) =>
        o.items
          .filter((i) => i.type === "PART" && i.partStatus === "ISSUED")
          .map((i) => {
            const movement = i.consumptionMovementId
              ? movementById.get(i.consumptionMovementId)
              : undefined;
            return {
              workOrderNumber: o.number,
              date: o.deliveredAt ?? o.receivedAt,
              sku: i.product?.sku ?? null,
              name: i.description,
              quantity: i.quantity.toString(),
              serial: movement?.serial?.serial ?? null,
              dotCode: movement?.lot?.dotCode ?? null,
              lotCode: movement?.lot?.code ?? null,
            };
          }),
      ),
      warranties: warranties.map((w) => {
        const check = coverage(w, { now, mileage: vehicle.currentMileage });
        return {
          id: w.id,
          description: w.description,
          status: w.status,
          expiresAt: w.expiresAt,
          expiresAtMileage: w.expiresAtMileage,
          covered: check.covered,
          reasons: check.reasons.map((r) => COVERAGE_LABEL[r]),
        };
      }),
      upcomingMaintenance: reminders.map((r) => ({
        id: r.id,
        description: r.description,
        dueDate: r.dueDate,
        dueMileage: r.dueMileage,
        status: r.status,
      })),
    };
  });
}
