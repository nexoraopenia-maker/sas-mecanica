import { requirePermission, requireTenantId, type AuthUser } from "@/lib/auth/can";
import { withTenant, type TenantTx } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { reminderSchema, type ReminderInput } from "@/lib/validation/workshop";
import { messages } from "@/lib/workshop/messages";
import { isReminderDue } from "@/lib/workshop/reminders-math";
import { auditContextOf, recordAudit, type RequestMeta } from "./audit";
import { companyName, notifyCustomer } from "./customer-notify";

export async function createReminder(
  actor: AuthUser,
  input: ReminderInput,
  meta: RequestMeta = {},
) {
  requirePermission(actor, "workshop:editar");
  const data = reminderSchema.parse(input);
  return withTenant(requireTenantId(actor), async (tx) => {
    if (!(await tx.vehicle.findFirst({ where: { id: data.vehicleId }, select: { id: true } })))
      throw new NotFoundError("Vehículo");
    const reminder = await tx.maintenanceReminder.create({
      data: {
        vehicleId: data.vehicleId,
        description: data.description,
        dueDate: data.dueDate ?? null,
        dueMileage: data.dueMileage ?? null,
        intervalMonths: data.intervalMonths ?? null,
        intervalKm: data.intervalKm ?? null,
      },
    });
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: "reminder.created",
      entityType: "maintenance_reminder",
      entityId: reminder.id,
      after: { vehicleId: data.vehicleId, description: data.description },
    });
    return { id: reminder.id };
  });
}

export async function completeReminder(
  actor: AuthUser,
  reminderId: string,
  status: "DONE" | "CANCELLED",
  meta: RequestMeta = {},
): Promise<void> {
  requirePermission(actor, "workshop:editar");
  await withTenant(requireTenantId(actor), async (tx) => {
    const moved = await tx.maintenanceReminder.updateMany({
      where: { id: reminderId, status: { in: ["PENDING", "NOTIFIED"] } },
      data: { status },
    });
    if (moved.count !== 1)
      throw new ConflictError("REMINDER_STATE", "El recordatorio no existe o ya está cerrado");
    await recordAudit(tx, auditContextOf(actor, meta), {
      action: status === "DONE" ? "reminder.done" : "reminder.cancelled",
      entityType: "maintenance_reminder",
      entityId: reminderId,
    });
  });
}

export async function listReminders(
  actor: AuthUser,
  filter: { vehicleId?: string; open?: boolean } = {},
) {
  requirePermission(actor, "workshop:ver");
  return withTenant(requireTenantId(actor), async (tx) => {
    const rows = await tx.maintenanceReminder.findMany({
      where: {
        ...(filter.vehicleId ? { vehicleId: filter.vehicleId } : {}),
        ...(filter.open ? { status: { in: ["PENDING", "NOTIFIED"] } } : {}),
      },
      include: {
        vehicle: {
          select: { plate: true, currentMileage: true, customer: { select: { name: true } } },
        },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      take: 200,
    });
    return rows.map((r) => ({
      id: r.id,
      vehicleId: r.vehicleId,
      plate: r.vehicle.plate,
      customer: r.vehicle.customer.name,
      description: r.description,
      dueDate: r.dueDate,
      dueMileage: r.dueMileage,
      currentMileage: r.vehicle.currentMileage,
      status: r.status,
      lastNotifiedAt: r.lastNotifiedAt,
    }));
  });
}

export interface ReminderJobSummary {
  due: number;
  notified: number;
}

/**
 * Avisa al cliente cuando un mantenimiento está por vencer (7 días o 500 km antes). Cada
 * recordatorio se avisa una sola vez (clave idempotente) y pasa a NOTIFIED.
 */
export async function processReminders(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<ReminderJobSummary> {
  const open = await tx.maintenanceReminder.findMany({
    where: { status: "PENDING" },
    include: {
      vehicle: {
        select: {
          plate: true,
          currentMileage: true,
          customerId: true,
          customer: { select: { name: true } },
        },
      },
    },
  });
  const due = open.filter((r) => isReminderDue(r, r.vehicle.currentMileage, now));
  if (due.length === 0) return { due: 0, notified: 0 };
  const company = await companyName(tx);
  let notified = 0;
  for (const reminder of due) {
    const when = [
      reminder.dueDate
        ? `antes del ${reminder.dueDate.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}`
        : null,
      reminder.dueMileage ? `a los ${reminder.dueMileage.toLocaleString("es-PE")} km` : null,
    ]
      .filter(Boolean)
      .join(" o ");
    const result = await notifyCustomer(tx, {
      customerId: reminder.vehicle.customerId,
      key: `reminder:${reminder.id}`,
      relatedType: "maintenance_reminder",
      relatedId: reminder.id,
      body: messages.maintenanceReminder({
        customer: reminder.vehicle.customer.name,
        company,
        plate: reminder.vehicle.plate,
        description: reminder.description,
        due: when,
      }),
    });
    await tx.notification.createMany({
      data: [
        {
          kind: "reminder.due",
          severity: "INFO",
          title: `Mantenimiento por vencer: ${reminder.vehicle.plate}`,
          body: `${reminder.description} · ${reminder.vehicle.customer.name}`,
          data: { reminderId: reminder.id, whatsapp: result },
          dedupeKey: `reminder:${reminder.id}`,
        },
      ],
      skipDuplicates: true,
    });
    await tx.maintenanceReminder.update({
      where: { id: reminder.id },
      data: { status: "NOTIFIED", lastNotifiedAt: now },
    });
    if (result === "QUEUED" || result === "SIMULATED") notified += 1;
  }
  return { due: due.length, notified };
}
