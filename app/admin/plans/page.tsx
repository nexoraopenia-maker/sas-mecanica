import { updatePlanAction } from "@/app/actions/admin";
import { ActionForm } from "@/components/forms/action-form";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { requirePlatformUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { listPlans } from "@/server/services/plans";

export default async function PlansPage() {
  const user = await requirePlatformUser();
  const plans = await listPlans(user);
  const numberField = (name: string, label: string, value: number | null) => (
    <div>
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="number"
        min={0}
        defaultValue={value ?? ""}
        placeholder={es.admin.unlimited}
      />
    </div>
  );
  return (
    <>
      <h1 className="text-2xl font-semibold">{es.admin.plansTitle}</h1>
      <p className="text-sm text-muted-foreground">
        {es.admin.unlimited}. Los límites se aplican en el backend en la siguiente operación del
        tenant.
      </p>
      {plans.map((plan) => (
        <Card key={plan.id}>
          <h2 className="mb-3 text-lg font-semibold">
            {plan.name}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              · {plan._count.tenants} empresas
            </span>
          </h2>
          <ActionForm
            action={updatePlanAction}
            submitLabel="Guardar plan"
            variant="outline"
            className="grid gap-4 sm:grid-cols-3"
          >
            <input type="hidden" name="planId" value={plan.id} />
            <div>
              <Label htmlFor={`price-${plan.id}`}>{es.admin.price}</Label>
              <Input
                id={`price-${plan.id}`}
                name="priceMonthly"
                type="number"
                min={0}
                step="0.01"
                defaultValue={plan.priceMonthly.toString()}
                required
              />
            </div>
            {numberField("maxBranches", es.admin.maxBranches, plan.maxBranches)}
            {numberField("maxUsers", es.admin.maxUsers, plan.maxUsers)}
            {numberField("maxWarehouses", es.admin.maxWarehouses, plan.maxWarehouses)}
            {numberField("monthlyAiTokens", es.admin.aiTokens, plan.monthlyAiTokens)}
          </ActionForm>
        </Card>
      ))}
    </>
  );
}
