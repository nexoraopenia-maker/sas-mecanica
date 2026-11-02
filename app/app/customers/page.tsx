import Link from "next/link";
import { createCustomerAction } from "@/app/actions/workshop";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { searchCustomers } from "@/server/services/customers";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "customers:ver");
  const t = es.customers;
  const w = es.workshop;
  const { q = "" } = await searchParams;
  const customers = await searchCustomers(user, q);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      <form className="flex flex-col gap-2 sm:flex-row" role="search">
        <Input name="q" defaultValue={q} placeholder={t.search} aria-label={t.search} />
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>
      {q.trim().length >= 2 && customers.length === 0 ? (
        <p className="text-muted-foreground">{t.none}</p>
      ) : null}
      <ul className="space-y-3">
        {customers.map((customer) => (
          <li key={customer.id}>
            <Link href={`/app/customers/${customer.id}`} className="block" data-testid="customer">
              <Card className="space-y-1 hover:bg-muted/40">
                <p className="font-medium">{customer.name}</p>
                <p className="text-sm text-muted-foreground">
                  {customer.docType} {customer.docNumber} ·{" "}
                  {customer.whatsapp ?? customer.phone ?? "sin teléfono"}
                </p>
                <p className="text-sm">{customer.vehicles.map((v) => v.plate).join(", ")}</p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>

      {can(user, "customers:crear") ? (
        <Card>
          <CardTitle>{t.newCustomer}</CardTitle>
          <ActionForm
            action={createCustomerAction}
            submitLabel={t.submit}
            className="grid gap-3 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="docType">{w.docType}</Label>
              <Select id="docType" name="docType" defaultValue="DNI">
                <option value="DNI">DNI</option>
                <option value="RUC">RUC</option>
                <option value="CE">CE</option>
                <option value="PASSPORT">Pasaporte</option>
                <option value="OTHER">Otro</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="docNumber">{w.docNumber}</Label>
              <Input id="docNumber" name="docNumber" required inputMode="numeric" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="name">{t.name}</Label>
              <Input id="name" name="name" required minLength={2} maxLength={200} />
            </div>
            <div>
              <Label htmlFor="phone">{t.phone}</Label>
              <Input id="phone" name="phone" inputMode="tel" />
            </div>
            <div>
              <Label htmlFor="whatsapp">{w.whatsapp}</Label>
              <Input id="whatsapp" name="whatsapp" inputMode="tel" />
            </div>
            <div>
              <Label htmlFor="email">{t.email}</Label>
              <Input id="email" name="email" type="email" />
            </div>
            <div>
              <Label htmlFor="address">{t.address}</Label>
              <Input id="address" name="address" />
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="optIn" defaultChecked className="size-5" />
              {w.optIn}
            </label>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
