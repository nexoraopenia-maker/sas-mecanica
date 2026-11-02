import Link from "next/link";
import { receptionAction } from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDateTime, formatMoney } from "@/lib/workshop/format";
import { RECEPTION_CHECKLIST } from "@/lib/workshop/reception-checklist";
import { listWorkOrders } from "@/server/services/work-orders";

const STATUSES = Object.keys(es.workshop.status) as Array<keyof typeof es.workshop.status>;

export default async function WorkshopPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string; q?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "workshop:ver");
  const t = es.workshop;
  const filter = await searchParams;
  const status = STATUSES.find((s) => s === filter.estado);
  const orders = await listWorkOrders(user, { ...(status ? { status } : {}), q: filter.q });

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>

      <form className="flex flex-col gap-2 sm:flex-row" role="search">
        <Input
          name="q"
          defaultValue={filter.q ?? ""}
          placeholder={t.search}
          aria-label={t.search}
        />
        <Select
          name="estado"
          defaultValue={status ?? ""}
          aria-label="Estado"
          className="sm:max-w-56"
        >
          <option value="">{t.all}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {t.status[s]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>

      {orders.length === 0 ? <p className="text-muted-foreground">{t.noOrders}</p> : null}
      <ul className="space-y-3">
        {orders.map((order) => (
          <li key={order.id}>
            <Link href={`/app/workshop/${order.id}`} className="block" data-testid="work-order">
              <Card className="space-y-1 hover:bg-muted/40">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    OT #{order.number} · {order.plate} {order.vehicle ? `· ${order.vehicle}` : ""}
                  </p>
                  <span className="rounded-full bg-muted px-3 py-1 text-sm">
                    {t.status[order.status]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {order.customer} · {order.mechanic ?? t.unassigned} ·{" "}
                  {formatDateTime(order.receivedAt)} · {formatMoney(order.total)}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      {can(user, "workshop:crear") ? (
        <Card>
          <CardTitle>{t.newOrder}</CardTitle>
          <ActionForm
            action={receptionAction}
            submitLabel={t.submitReception}
            className="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="plate">{t.plate}</Label>
                <Input
                  id="plate"
                  name="plate"
                  required
                  maxLength={10}
                  autoCapitalize="characters"
                />
              </div>
              <div>
                <Label htmlFor="mileageIn">{t.mileageIn}</Label>
                <Input
                  id="mileageIn"
                  name="mileageIn"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  required
                />
              </div>
              <div>
                <Label htmlFor="fuel">{t.fuel}</Label>
                <Input
                  id="fuel"
                  name="fuel"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={8}
                  defaultValue={4}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="complaint">{t.complaint}</Label>
              <Input id="complaint" name="complaint" required minLength={3} maxLength={1000} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="promisedAt">{t.promisedAt}</Label>
                <Input id="promisedAt" name="promisedAt" type="datetime-local" />
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" name="confirmLowerMileage" className="size-5" />
                {t.confirmLower}
              </label>
            </div>
            <div>
              <Label htmlFor="photos">{t.intakePhotos}</Label>
              <input
                id="photos"
                name="photos"
                type="file"
                multiple
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="block w-full text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">{t.evidenceNote}</p>
            </div>
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="mb-1 text-sm font-medium">{t.checklist}</legend>
              {RECEPTION_CHECKLIST.map((entry) => (
                <label key={entry.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name={entry.id} className="size-5" />
                  {entry.label}
                </label>
              ))}
            </fieldset>
            {can(user, "customers:crear") ? (
              <fieldset className="space-y-3 rounded-lg border border-border p-3">
                <legend className="px-1 text-sm text-muted-foreground">{t.newCustomerHelp}</legend>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label htmlFor="docType">{t.docType}</Label>
                    <Select id="docType" name="docType" defaultValue="DNI">
                      <option value="DNI">DNI</option>
                      <option value="RUC">RUC</option>
                      <option value="CE">CE</option>
                      <option value="PASSPORT">Pasaporte</option>
                      <option value="OTHER">Otro</option>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="docNumber">{t.docNumber}</Label>
                    <Input id="docNumber" name="docNumber" inputMode="numeric" />
                  </div>
                  <div>
                    <Label htmlFor="customerName">{t.customerName}</Label>
                    <Input id="customerName" name="customerName" />
                  </div>
                  <div>
                    <Label htmlFor="whatsapp">{t.whatsapp}</Label>
                    <Input id="whatsapp" name="whatsapp" inputMode="tel" />
                  </div>
                  <div>
                    <Label htmlFor="make">{t.make}</Label>
                    <Input id="make" name="make" />
                  </div>
                  <div>
                    <Label htmlFor="model">{t.model}</Label>
                    <Input id="model" name="model" />
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="optIn" defaultChecked className="size-5" />
                  {t.optIn}
                </label>
              </fieldset>
            ) : null}
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
