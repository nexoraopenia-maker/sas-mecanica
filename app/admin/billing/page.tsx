import { extendGraceAction, manualPaymentAction } from "@/app/actions/company";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { requirePlatformUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate, formatDateTime } from "@/lib/workshop/format";
import { getBillingOverview } from "@/server/services/subscription-billing";

export default async function AdminBillingPage() {
  const user = await requirePlatformUser();
  const t = es.adminBilling;
  const { atRisk, recent } = await getBillingOverview(user);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>

      <Card className="space-y-3">
        <CardTitle>{t.atRisk}</CardTitle>
        {atRisk.length === 0 ? <p className="text-sm text-muted-foreground">{t.none}</p> : null}
        <ul className="space-y-4">
          {atRisk.map((row) => (
            <li key={row.tenantId} className="space-y-2 text-sm" data-testid="at-risk">
              <p className="font-medium">
                {row.tenant} · {row.plan} (S/ {row.price}) · {es.subscription.status[row.status]}
              </p>
              <p className="text-muted-foreground">
                {t.periodEnd} {formatDate(row.periodEnd)} · {t.gracePeriodEnd}{" "}
                {formatDate(row.graceEndsAt)} · {row.retryCount} {t.retries}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {t.tenantId}: {row.tenantId}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t.manual}</CardTitle>
        <ActionForm
          action={manualPaymentAction}
          submitLabel={t.submitManual}
          className="grid gap-3 sm:grid-cols-3"
        >
          <div className="sm:col-span-3">
            <Label htmlFor="tenantId">{t.tenantId}</Label>
            <Input id="tenantId" name="tenantId" required />
          </div>
          <div>
            <Label htmlFor="amount">{t.amount}</Label>
            <Input id="amount" name="amount" inputMode="decimal" required />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="reference">{t.reference}</Label>
            <Input id="reference" name="reference" required minLength={3} maxLength={120} />
          </div>
        </ActionForm>
      </Card>

      <Card className="space-y-3">
        <CardTitle>{t.extend}</CardTitle>
        <ActionForm
          action={extendGraceAction}
          submitLabel={t.submitExtend}
          variant="outline"
          className="grid gap-3 sm:grid-cols-4"
        >
          <div className="sm:col-span-2">
            <Label htmlFor="g-tenantId">{t.tenantId}</Label>
            <Input id="g-tenantId" name="tenantId" required />
          </div>
          <div>
            <Label htmlFor="days">{t.days}</Label>
            <Input id="days" name="days" type="number" min={1} max={30} defaultValue={3} required />
          </div>
          <div className="sm:col-span-4">
            <Label htmlFor="reason">{t.reason}</Label>
            <Input id="reason" name="reason" required minLength={5} maxLength={200} />
          </div>
        </ActionForm>
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.recent}</CardTitle>
        <ul className="divide-y divide-border text-sm">
          {recent.map((p) => (
            <li key={p.id} className="py-2">
              {formatDateTime(p.paidAt ?? p.createdAt)} · {p.tenant} · {p.currency} {p.amount} ·{" "}
              {es.subscription.payStatus[p.status]} · {p.gateway}
              {p.reference ? ` · ${p.reference}` : ""}
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
