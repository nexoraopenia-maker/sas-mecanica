import Link from "next/link";
import { createTenantAction, createTenantQuickAction } from "@/app/actions/admin";
import { ModulePicker } from "@/components/admin/module-picker";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePlatformUser } from "@/lib/auth/guards";
import { groupStates } from "@/lib/modules";
import { es } from "@/lib/i18n/es";
import { listPlans } from "@/server/services/plans";
import { listTenants } from "@/server/services/tenants";

export default async function TenantsPage() {
  const user = await requirePlatformUser();
  const [tenants, plans] = await Promise.all([listTenants(user), listPlans(user)]);
  const activePlans = plans.filter((plan) => plan.isActive);
  const defaultPlan = activePlans[0];
  return (
    <>
      <h1 className="text-2xl font-semibold">{es.admin.tenantsTitle}</h1>
      {defaultPlan ? (
        <Card data-testid="quick-tenant">
          <CardTitle>Alta rápida de cuenta</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Crea la cuenta al instante con una contraseña temporal, sin RUC ni conexión a SUNAT. El
            cliente la cambia al entrar y completa el RUC oficial cuando quiera facturar.
          </p>
          <ActionForm
            action={createTenantQuickAction}
            submitLabel="Crear cuenta ahora"
            className="space-y-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="q-legalName">Nombre o razón social</Label>
                <Input id="q-legalName" name="legalName" required />
              </div>
              <div>
                <Label htmlFor="q-tradeName">{es.admin.tradeName}</Label>
                <Input id="q-tradeName" name="tradeName" />
              </div>
              <div>
                <Label htmlFor="q-adminName">{es.admin.adminName}</Label>
                <Input id="q-adminName" name="adminName" required />
              </div>
              <div>
                <Label htmlFor="q-adminEmail">{es.admin.adminEmail}</Label>
                <Input id="q-adminEmail" name="adminEmail" type="email" required />
              </div>
              <div>
                <Label htmlFor="q-temp">Contraseña temporal</Label>
                <Input
                  id="q-temp"
                  name="tempPassword"
                  autoComplete="off"
                  placeholder="Se genera sola si la dejas vacía"
                />
              </div>
              <div>
                <Label htmlFor="q-contactEmail">Correo corporativo (opcional)</Label>
                <Input id="q-contactEmail" name="contactEmail" type="email" />
              </div>
              <div>
                <Label htmlFor="q-taxId">RUC (opcional, se puede completar después)</Label>
                <Input id="q-taxId" name="taxId" inputMode="numeric" maxLength={11} />
              </div>
            </div>
            <ModulePicker
              selectablePlan
              plans={activePlans.map((p) => ({
                code: p.code,
                name: p.name,
                included: p.includedModules,
              }))}
              planCode={defaultPlan.code}
              businessType="MIXED"
              activeGroups={groupStates(defaultPlan.includedModules)
                .filter((state) => state.active)
                .map((state) => state.group.id)}
            />
          </ActionForm>
        </Card>
      ) : null}
      <details className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-muted-foreground">
          Alta formal con invitación por correo y RUC
        </summary>
        <Card className="mt-2">
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
      </details>
      <ul className="space-y-3">
        {tenants.map((tenant) => (
          <li key={tenant.id}>
            <Link href={`/admin/tenants/${tenant.id}`} className="block">
              <Card className="flex flex-wrap items-center justify-between gap-2 hover:bg-muted">
                <div>
                  <p className="font-medium">{tenant.tradeName ?? tenant.legalName}</p>
                  <p className="text-sm text-muted-foreground">
                    {tenant.taxId ?? "RUC pendiente"} · {tenant.plan.name} · {tenant._count.users}{" "}
                    usuarios
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
