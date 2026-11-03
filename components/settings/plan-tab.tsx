import { cancelSubscriptionAction, startCheckoutAction } from "@/app/actions/company";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { can, type AuthUser } from "@/lib/auth/can";
import { getEnv } from "@/lib/env";
import { planChangeWhatsappUrl, salesWhatsappUrl } from "@/lib/sales-whatsapp";
import { PlanLimits } from "@/components/settings/plan-limits";
import { getPlanOverview } from "@/server/services/plan-overview";
import { es } from "@/lib/i18n/es";
import { formatDate, formatDateTime } from "@/lib/workshop/format";
import { getSubscriptionView } from "@/server/services/subscription-billing";

export async function PlanTab({
  user,
  notice,
}: {
  user: AuthUser;
  notice: { pago?: string; simulado?: string };
}) {
  const t = es.subscription;
  const view = await getSubscriptionView(user);
  const canEdit = can(user, "settings:editar");
  const owes =
    view.status === "GRACE" ||
    view.status === "PAST_DUE" ||
    view.status === "SUSPENDED" ||
    view.dueAmount !== null;
  const overview = await getPlanOverview(user);
  const tenantName = user.tenantName ?? es.app.name;
  const whatsapp = view.isDemo
    ? salesWhatsappUrl(getEnv().NEXT_PUBLIC_SALES_WHATSAPP, tenantName)
    : planChangeWhatsappUrl(getEnv().NEXT_PUBLIC_SALES_WHATSAPP, tenantName, view.plan.name);

  return (
    <>
      <PlanLimits overview={overview} whatsapp={whatsapp} isDemo={view.isDemo} />

      {notice.pago === "ok" ? <Alert tone="success">{t.paid}</Alert> : null}
      {notice.pago === "cancelado" ? <Alert>{t.cancelled}</Alert> : null}
      {notice.simulado && view.gateway === "SIMULATED" ? <Alert>{t.simulated}</Alert> : null}
      {view.isDemo ? <Alert>{t.demo}</Alert> : null}

      <Card className="space-y-3" data-testid="subscription-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-lg font-semibold">
            {t.plan} {view.plan.name} · {view.plan.currency} {view.plan.price}
          </p>
          <span
            className="rounded-full bg-muted px-3 py-1 text-sm"
            data-testid="subscription-status"
          >
            {t.status[view.status]}
          </span>
        </div>
        {view.currentPeriodEnd ? (
          <p className="text-sm">
            {t.renewsOn} {formatDate(view.currentPeriodEnd)}
            {view.daysToRenewal !== null ? ` (${view.daysToRenewal} ${t.daysLeft})` : ""}
          </p>
        ) : null}
        {view.graceEndsAt ? (
          <p className="text-sm text-danger">
            {t.graceUntil} {formatDate(view.graceEndsAt)} ({view.graceDaysLeft} {t.daysLeft})
          </p>
        ) : null}
        {view.dueAmount ? (
          <p className="text-sm" data-testid="amount-due">
            {t.amountDue}: {view.plan.currency} {view.dueAmount}
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          {view.autoChargeReady ? t.autoCharge : view.canPayOnline ? t.manualPay : t.noGateway}
        </p>
        {view.cancelAtPeriodEnd ? <Alert>{t.cancelNote}</Alert> : null}

        {canEdit && !view.isDemo && view.canPayOnline && view.status !== "CANCELED" ? (
          <ActionForm
            action={startCheckoutAction}
            submitLabel={t.pay}
            pendingLabel="Preparando el pago…"
            className="inline"
          />
        ) : null}
        {canEdit && !view.isDemo && (view.status === "ACTIVE" || view.status === "PAST_DUE") ? (
          <ActionForm
            action={cancelSubscriptionAction}
            submitLabel={view.cancelAtPeriodEnd ? t.keep : t.cancel}
            variant="outline"
            size="sm"
            className="inline"
          >
            <input type="hidden" name="cancel" value={view.cancelAtPeriodEnd ? "0" : "1"} />
          </ActionForm>
        ) : null}
        {owes && !view.canPayOnline && !view.isDemo ? (
          <Alert tone="error">{t.noGateway}</Alert>
        ) : null}
      </Card>

      <Card className="space-y-2">
        <CardTitle>{t.history}</CardTitle>
        <ul className="divide-y divide-border text-sm">
          {view.payments.map((p) => (
            <li
              key={p.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2"
              data-testid="payment-row"
            >
              <span>
                {p.paidAt ? formatDateTime(p.paidAt) : formatDateTime(p.createdAt)} · {p.currency}{" "}
                {p.amount}
              </span>
              <span>
                {t.payStatus[p.status]}
                {p.failureMessage ? ` · ${p.failureMessage}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
