import { cashMovementAction, closeCashAction, openCashAction } from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/pos/cash";
import { formatDateTime } from "@/lib/workshop/format";
import { getCurrentSession, listCashSessions } from "@/server/services/cash";

export default async function CashPage({
  searchParams,
}: {
  searchParams: Promise<{ cerrada?: string; dif?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "cash:ver");
  const t = es.cash;
  const notice = await searchParams;
  const [session, history] = await Promise.all([getCurrentSession(user), listCashSessions(user)]);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {notice.cerrada === "1" ? (
        <Alert tone="success">
          {t.result}: {t.difference} S/{" "}
          {/^-?\d+(\.\d{1,2})?$/.test(notice.dif ?? "") ? notice.dif : "0.00"}
        </Alert>
      ) : null}

      {!session ? (
        <Card className="space-y-3">
          <p>{t.closed}</p>
          {can(user, "cash:crear") ? (
            <ActionForm
              action={openCashAction}
              submitLabel={t.open}
              className="flex flex-wrap items-end gap-2"
            >
              <div>
                <Label htmlFor="openingAmount">{t.openingAmount}</Label>
                <Input
                  id="openingAmount"
                  name="openingAmount"
                  inputMode="decimal"
                  defaultValue="0"
                  required
                  className="max-w-40"
                />
              </div>
            </ActionForm>
          ) : null}
        </Card>
      ) : (
        <>
          <Card className="space-y-3">
            <p>
              {t.current} · {session.branchName} · {t.since} {formatDateTime(session.openedAt)}
            </p>
            <dl className="grid grid-cols-2 gap-1 text-sm sm:max-w-md">
              <dt>{t.expectedCash}</dt>
              <dd className="text-right font-semibold" data-testid="cash-expected">
                S/ {session.summary.expectedCash}
              </dd>
              {PAYMENT_METHODS.filter(
                (m) => m !== "CASH" && Number(session.summary.byMethod[m]) !== 0,
              ).map((m) => (
                <div key={m} className="contents">
                  <dt>{METHOD_LABEL[m]}</dt>
                  <dd className="text-right">S/ {session.summary.byMethod[m]}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card className="space-y-3">
            <CardTitle>{t.movement}</CardTitle>
            <ActionForm
              action={cashMovementAction}
              submitLabel={t.registerMovement}
              className="grid gap-3 sm:grid-cols-4"
            >
              <div>
                <Label htmlFor="type">Tipo</Label>
                <Select id="type" name="type" defaultValue="EXPENSE">
                  <option value="EXPENSE">{t.expense}</option>
                  <option value="INCOME">{t.income}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="amount">Monto</Label>
                <Input id="amount" name="amount" inputMode="decimal" required />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="reason">{t.reason}</Label>
                <Input id="reason" name="reason" required minLength={3} maxLength={200} />
              </div>
            </ActionForm>
            <ul className="space-y-1 text-sm">
              {session.movements.map((m) => (
                <li key={m.id}>
                  {formatDateTime(m.createdAt)} · {m.type === "INCOME" ? t.income : t.expense} S/{" "}
                  {m.amount} · {m.reason}
                </li>
              ))}
            </ul>
          </Card>

          {can(user, "cash:cerrar_caja") ? (
            <Card className="space-y-3">
              <CardTitle>{t.close}</CardTitle>
              <ActionForm
                action={closeCashAction}
                submitLabel={t.submitClose}
                variant="destructive"
                className="space-y-3"
              >
                <input type="hidden" name="sessionId" value={session.id} />
                <div className="grid gap-3 sm:grid-cols-3">
                  {PAYMENT_METHODS.map((m) => (
                    <div key={m}>
                      <Label htmlFor={m}>
                        {METHOD_LABEL[m]} · {t.counted}
                      </Label>
                      <Input
                        id={m}
                        name={m}
                        inputMode="decimal"
                        required={m === "CASH"}
                        placeholder={m === "CASH" ? "0.00" : `S/ ${session.summary.byMethod[m]}`}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <Label htmlFor="notes">{t.notes}</Label>
                  <Input id="notes" name="notes" maxLength={300} />
                </div>
              </ActionForm>
            </Card>
          ) : null}
        </>
      )}

      <Card className="space-y-2">
        <CardTitle>{t.history}</CardTitle>
        <ul className="divide-y divide-border text-sm">
          {history
            .filter((s) => s.status === "CLOSED")
            .map((s) => (
              <li key={s.id} className="py-2">
                {formatDateTime(s.openedAt)} → {formatDateTime(s.closedAt)} · {s.openedBy} ·{" "}
                {t.expected} S/ {s.expected} · {t.counted} S/ {s.counted} · {t.difference} S/{" "}
                {s.difference}
              </li>
            ))}
        </ul>
      </Card>
    </>
  );
}
