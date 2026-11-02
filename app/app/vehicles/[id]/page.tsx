import Link from "next/link";
import { closeReminderAction, createReminderAction } from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate, formatKm } from "@/lib/workshop/format";
import { getVehicleHistory } from "@/server/services/vehicles";

export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTenantUser();
  requirePermission(user, "workshop:ver");
  const t = es.vehicles;
  const history = await getVehicleHistory(user, id);
  const { vehicle } = history;

  return (
    <>
      <h1 className="text-2xl font-semibold">
        {vehicle.plate} · {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ")}
      </h1>
      <p className="text-sm text-muted-foreground">
        {history.customer.name} · {t.mileage}: {formatKm(vehicle.currentMileage)}
      </p>
      {history.openWorkOrders.length > 0 ? (
        <p className="text-sm">
          {t.openOrders}:{" "}
          {history.openWorkOrders.map((o) => (
            <Link key={o.id} className="mr-2 underline" href={`/app/workshop/${o.id}`}>
              OT #{o.number}
            </Link>
          ))}
        </p>
      ) : null}

      <Card className="space-y-2">
        <CardTitle>{t.upcoming}</CardTitle>
        {history.upcomingMaintenance.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noData}</p>
        ) : null}
        <ul className="space-y-2 text-sm">
          {history.upcomingMaintenance.map((reminder) => (
            <li key={reminder.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>
                {reminder.description} · {reminder.dueDate ? formatDate(reminder.dueDate) : ""}{" "}
                {reminder.dueMileage ? formatKm(reminder.dueMileage) : ""}
              </span>
              {can(user, "workshop:editar") ? (
                <span className="flex gap-2">
                  <ActionForm
                    action={closeReminderAction}
                    submitLabel={t.done}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="reminderId" value={reminder.id} />
                    <input type="hidden" name="vehicleId" value={id} />
                    <input type="hidden" name="status" value="DONE" />
                  </ActionForm>
                  <ActionForm
                    action={closeReminderAction}
                    submitLabel={t.cancelReminder}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="reminderId" value={reminder.id} />
                    <input type="hidden" name="vehicleId" value={id} />
                    <input type="hidden" name="status" value="CANCELLED" />
                  </ActionForm>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
        {can(user, "workshop:editar") ? (
          <ActionForm
            action={createReminderAction}
            submitLabel={t.submitReminder}
            className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3"
          >
            <input type="hidden" name="vehicleId" value={id} />
            <div className="sm:col-span-3">
              <Label htmlFor="description">{t.reminderDesc}</Label>
              <Input id="description" name="description" required minLength={3} maxLength={200} />
            </div>
            <div>
              <Label htmlFor="dueDate">{t.dueDate}</Label>
              <Input id="dueDate" name="dueDate" type="date" />
            </div>
            <div>
              <Label htmlFor="dueMileage">{t.dueMileage}</Label>
              <Input id="dueMileage" name="dueMileage" type="number" inputMode="numeric" min={0} />
            </div>
          </ActionForm>
        ) : null}
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.services}</CardTitle>
        {history.services.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noData}</p>
        ) : null}
        <ul className="space-y-1 text-sm">
          {history.services.map((service, index) => (
            <li key={`${service.workOrderNumber}-${index}`}>
              {formatDate(service.date)} · OT #{service.workOrderNumber} ·{" "}
              {formatKm(service.mileage)} · {service.description}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.parts}</CardTitle>
        {history.partsInstalled.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noData}</p>
        ) : null}
        <ul className="space-y-1 text-sm">
          {history.partsInstalled.map((part, index) => (
            <li key={`${part.workOrderNumber}-${index}`}>
              {formatDate(part.date)} · OT #{part.workOrderNumber} · {part.quantity} × {part.name}
              {part.serial ? ` · ${t.serial} ${part.serial}` : ""}
              {part.dotCode ? ` · ${t.dot} ${part.dotCode}` : ""}
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.warranties}</CardTitle>
        {history.warranties.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noData}</p>
        ) : null}
        <ul className="space-y-1 text-sm">
          {history.warranties.map((warranty) => (
            <li key={warranty.id}>
              {warranty.description} ·{" "}
              {es.warranties.status[warranty.status as keyof typeof es.warranties.status] ??
                warranty.status}{" "}
              · {formatDate(warranty.expiresAt)}
              {warranty.expiresAtMileage ? ` / ${formatKm(warranty.expiresAtMileage)}` : ""} ·{" "}
              {warranty.covered
                ? es.warranties.covered
                : `${es.warranties.notCovered}: ${warranty.reasons.join(", ")}`}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
