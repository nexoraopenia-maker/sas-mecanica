import Link from "next/link";
import { createVehicleAction } from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate, formatKm, formatMoney } from "@/lib/workshop/format";
import { getCustomer } from "@/server/services/customers";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTenantUser();
  requirePermission(user, "customers:ver");
  const t = es.customers;
  const w = es.workshop;
  const customer = await getCustomer(user, id);

  return (
    <>
      <h1 className="text-2xl font-semibold">{customer.name}</h1>
      <p className="text-sm text-muted-foreground">
        {customer.docType} {customer.docNumber} ·{" "}
        {customer.whatsapp ?? customer.phone ?? "sin teléfono"}
        {customer.email ? ` · ${customer.email}` : ""} · {t.activeWarranties}:{" "}
        {customer.activeWarranties}
      </p>

      <Card className="space-y-3">
        <CardTitle>{t.vehicles}</CardTitle>
        <ul className="divide-y divide-border">
          {customer.vehicles.map((vehicle) => (
            <li
              key={vehicle.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
            >
              <p>
                <span className="font-medium">{vehicle.plate}</span> ·{" "}
                {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(" ")} ·{" "}
                {formatKm(vehicle.currentMileage)}
              </p>
              <Link className="text-sm underline" href={`/app/vehicles/${vehicle.id}`}>
                {t.history}
              </Link>
            </li>
          ))}
        </ul>
        {can(user, "customers:editar") || can(user, "workshop:crear") ? (
          <ActionForm
            action={createVehicleAction}
            submitLabel={t.submitVehicle}
            className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3"
          >
            <input type="hidden" name="customerId" value={id} />
            <div>
              <Label htmlFor="plate">{w.plate}</Label>
              <Input id="plate" name="plate" required maxLength={10} autoCapitalize="characters" />
            </div>
            <div>
              <Label htmlFor="make">{w.make}</Label>
              <Input id="make" name="make" />
            </div>
            <div>
              <Label htmlFor="model">{w.model}</Label>
              <Input id="model" name="model" />
            </div>
            <div>
              <Label htmlFor="year">{w.year}</Label>
              <Input
                id="year"
                name="year"
                type="number"
                inputMode="numeric"
                min={1950}
                max={2100}
              />
            </div>
            <div>
              <Label htmlFor="currentMileage">{t.currentMileage}</Label>
              <Input
                id="currentMileage"
                name="currentMileage"
                type="number"
                inputMode="numeric"
                min={0}
              />
            </div>
          </ActionForm>
        ) : null}
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.orders}</CardTitle>
        <ul className="space-y-1 text-sm">
          {customer.orders.map((order) => (
            <li key={order.id}>
              <Link className="underline" href={`/app/workshop/${order.id}`}>
                OT #{order.number}
              </Link>{" "}
              · {order.vehicle.plate} · {w.status[order.status]} · {formatDate(order.receivedAt)} ·{" "}
              {formatMoney(order.total.toString())}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
