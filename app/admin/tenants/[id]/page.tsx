import { notFound } from "next/navigation";
import {
  changePlanAction,
  resetTenantAdminPasswordAction,
  startImpersonationAction,
  tenantStatusAction,
  updateTenantFiscalAction,
  updateTenantModulesAction,
} from "@/app/actions/admin";
import { ModulePicker } from "@/components/admin/module-picker";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePlatformUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/errors";
import { es } from "@/lib/i18n/es";
import { listPlans } from "@/server/services/plans";
import { groupStates } from "@/lib/modules";
import { getTenantDetail, getTenantModules } from "@/server/services/tenants";

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePlatformUser();
  const { id } = await params;
  const tenant = await getTenantDetail(user, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const [plans, modules] = await Promise.all([listPlans(user), getTenantModules(user, id)]);
  const states = groupStates(
    modules.plan.includedModules,
    modules.disabledModules,
    modules.enabledModules,
  );
  // `id` único por formulario (varios formularios comparten la página).
  const reason = (id: string) => (
    <div>
      <Label htmlFor={`reason-${id}`}>{es.admin.reason}</Label>
      <Input id={`reason-${id}`} name="reason" minLength={5} required />
    </div>
  );

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{tenant.tradeName ?? tenant.legalName}</h1>
        <p className="text-sm text-muted-foreground">
          {tenant.legalName} ·{" "}
          {tenant.taxId ? `${tenant.taxIdType} ${tenant.taxId}` : "RUC pendiente"} ·{" "}
          {es.admin.statuses[tenant.status]} · {tenant.plan.name}
        </p>
        {!modules.fiscal.ready ? (
          <p className="mt-1 text-sm text-warning" data-testid="fiscal-pending">
            Facturación electrónica desactivada: falta el RUC oficial. Ventas con nota de venta
            hasta completarlo.
          </p>
        ) : null}
        {tenant.suspendedReason ? (
          <p className="mt-1 text-sm text-danger">{tenant.suspendedReason}</p>
        ) : null}
      </div>
      <Card>
        <CardTitle>Datos</CardTitle>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">País / moneda</dt>
            <dd>
              {tenant.country} · {tenant.currency}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Impuesto</dt>
            <dd>
              {tenant.settings?.taxName}{" "}
              {tenant.settings ? `${Number(tenant.settings.taxRate) * 100}%` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Usuarios / sucursales</dt>
            <dd>
              {tenant._count.users} / {tenant._count.branches}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Retención al cancelar</dt>
            <dd>{tenant.retentionDays} días</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Contacto</dt>
            <dd>{tenant.contactEmail ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Dirección</dt>
            <dd>{tenant.address ?? "—"}</dd>
          </div>
        </dl>
      </Card>
      {tenant.deletedAt ? null : (
        <>
          <Card data-testid="modules-card">
            <CardTitle>Rubros y módulos activos</CardTitle>
            <p className="mb-3 text-sm text-muted-foreground">
              Plan {modules.plan.name}: lo que el plan no incluye aparece bloqueado. Lo que apagues
              desaparece de los menús y botones del cliente.
            </p>
            <ActionForm action={updateTenantModulesAction} submitLabel="Guardar módulos">
              <input type="hidden" name="tenantId" value={tenant.id} />
              <ModulePicker
                plans={plans
                  .filter((p) => p.code === modules.plan.code)
                  .map((p) => ({ code: p.code, name: p.name, included: p.includedModules }))}
                planCode={modules.plan.code}
                businessType={modules.businessType}
                activeGroups={states.filter((state) => state.active).map((state) => state.group.id)}
              />
              {reason("modules")}
            </ActionForm>
          </Card>
          <Card data-testid="fiscal-card">
            <CardTitle>Datos fiscales</CardTitle>
            <p className="mb-3 text-sm text-muted-foreground">
              {modules.fiscal.taxId
                ? `RUC ${modules.fiscal.taxId} · ${modules.fiscal.billingEmail ?? "sin correo corporativo"}`
                : "Cuenta creada sin RUC: completa el RUC oficial y el correo corporativo cuando el cliente quiera activar la facturación electrónica."}
            </p>
            <ActionForm
              action={updateTenantFiscalAction}
              submitLabel="Guardar datos fiscales"
              variant="outline"
              className="grid gap-4 sm:grid-cols-2"
            >
              <input type="hidden" name="tenantId" value={tenant.id} />
              <div>
                <Label htmlFor="fiscal-taxId">RUC oficial</Label>
                <Input
                  id="fiscal-taxId"
                  name="taxId"
                  inputMode="numeric"
                  maxLength={11}
                  defaultValue={modules.fiscal.taxId ?? ""}
                />
              </div>
              <div>
                <Label htmlFor="fiscal-email">Correo corporativo</Label>
                <Input
                  id="fiscal-email"
                  name="corporateEmail"
                  type="email"
                  defaultValue={modules.fiscal.billingEmail ?? ""}
                />
              </div>
              <div className="sm:col-span-2">{reason("fiscal")}</div>
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>Acceso del administrador</CardTitle>
            <p className="mb-3 text-sm text-muted-foreground">
              Genera una contraseña temporal nueva (la ves una sola vez). Se revocan sus sesiones y
              deberá cambiarla al entrar.
            </p>
            <ActionForm
              action={resetTenantAdminPasswordAction}
              submitLabel="Generar contraseña temporal"
              variant="outline"
            >
              <input type="hidden" name="tenantId" value={tenant.id} />
              {reason("password")}
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>{es.admin.changePlan}</CardTitle>
            <ActionForm
              action={changePlanAction}
              submitLabel={es.admin.changePlan}
              variant="outline"
            >
              <input type="hidden" name="tenantId" value={tenant.id} />
              <Select name="planCode" defaultValue={tenant.plan.code} aria-label={es.admin.plan}>
                {plans
                  .filter((plan) => plan.isActive)
                  .map((plan) => (
                    <option key={plan.id} value={plan.code}>
                      {plan.name}
                    </option>
                  ))}
              </Select>
              {reason("plan")}
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>{es.admin.impersonate}</CardTitle>
            <p className="mb-3 text-sm text-muted-foreground">{es.admin.impersonateHelp}</p>
            <ActionForm
              action={startImpersonationAction}
              submitLabel={es.admin.impersonate}
              variant="outline"
            >
              <input type="hidden" name="tenantId" value={tenant.id} />
              {reason("support")}
            </ActionForm>
          </Card>
          <Card>
            <CardTitle>Estado</CardTitle>
            <div className="grid gap-6 sm:grid-cols-2">
              {tenant.status === "ACTIVE" ? (
                <ActionForm
                  action={tenantStatusAction}
                  submitLabel={es.admin.suspend}
                  variant="destructive"
                >
                  <input type="hidden" name="tenantId" value={tenant.id} />
                  <input type="hidden" name="intent" value="suspend" />
                  {reason("suspend")}
                </ActionForm>
              ) : null}
              {tenant.status === "SUSPENDED" ? (
                <ActionForm
                  action={tenantStatusAction}
                  submitLabel={es.admin.reactivate}
                  variant="outline"
                >
                  <input type="hidden" name="tenantId" value={tenant.id} />
                  <input type="hidden" name="intent" value="reactivate" />
                  {reason("reactivate")}
                </ActionForm>
              ) : null}
              <ActionForm
                action={tenantStatusAction}
                submitLabel={es.admin.delete}
                variant="destructive"
              >
                <input type="hidden" name="tenantId" value={tenant.id} />
                <input type="hidden" name="intent" value="delete" />
                {reason("delete")}
              </ActionForm>
            </div>
          </Card>
        </>
      )}
    </>
  );
}
