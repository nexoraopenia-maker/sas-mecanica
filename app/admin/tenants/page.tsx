import Link from "next/link";
import { createTenantAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePlatformUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { listPlans } from "@/server/services/plans";
import { listTenants } from "@/server/services/tenants";

export default async function TenantsPage() {
  const user = await requirePlatformUser();
  const [tenants, plans] = await Promise.all([listTenants(user), listPlans(user)]);
  return (
    <>
      <h1 className="text-2xl font-semibold">{es.admin.tenantsTitle}</h1>
      <Card>
        <CardTitle>{es.admin.newTenant}</CardTitle>
        <ActionForm
          action={createTenantAction}
          submitLabel={es.admin.createSubmit}
          className="grid gap-4 sm:grid-cols-2"
        >
          <div>
            <Label htmlFor="legalName">{es.admin.legalName}</Label>
            <Input id="legalName" name="legalName" required />
          </div>
          <div>
            <Label htmlFor="tradeName">{es.admin.tradeName}</Label>
            <Input id="tradeName" name="tradeName" />
          </div>
          <div>
            <Label htmlFor="taxId">{es.admin.taxId}</Label>
            <Input id="taxId" name="taxId" inputMode="numeric" required />
          </div>
          <div>
            <Label htmlFor="planCode">{es.admin.plan}</Label>
            <Select id="planCode" name="planCode" required>
              {plans
                .filter((plan) => plan.isActive)
                .map((plan) => (
                  <option key={plan.id} value={plan.code}>
                    {plan.name}
                  </option>
                ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="adminName">{es.admin.adminName}</Label>
            <Input id="adminName" name="adminName" required />
          </div>
          <div>
            <Label htmlFor="adminEmail">{es.admin.adminEmail}</Label>
            <Input id="adminEmail" name="adminEmail" type="email" required />
          </div>
        </ActionForm>
      </Card>
      <ul className="space-y-3">
        {tenants.map((tenant) => (
          <li key={tenant.id}>
            <Link href={`/admin/tenants/${tenant.id}`} className="block">
              <Card className="flex flex-wrap items-center justify-between gap-2 hover:bg-muted">
                <div>
                  <p className="font-medium">{tenant.tradeName ?? tenant.legalName}</p>
                  <p className="text-sm text-muted-foreground">
                    {tenant.taxId} · {tenant.plan.name} · {tenant._count.users} usuarios
                  </p>
                </div>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {es.admin.statuses[tenant.status]}
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
