import { randomUUID } from "node:crypto";
import Link from "next/link";
import { collectReceivableAction } from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/pos/cash";
import { LIGHT_LABEL, type Light } from "@/lib/pos/receivable-light";
import { formatDate } from "@/lib/workshop/format";
import { listReceivables } from "@/server/services/receivables";

const LIGHT_STYLE: Record<Light, string> = {
  GREEN: "bg-green-100 text-green-800",
  AMBER: "bg-amber-100 text-amber-800",
  RED: "bg-red-100 text-red-800",
};
const DOT: Record<Light, string> = {
  GREEN: "bg-green-600",
  AMBER: "bg-amber-500",
  RED: "bg-red-600",
};

function LightBadge({ light, testId }: { light: Light; testId?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${LIGHT_STYLE[light]}`}
      data-testid={testId}
      data-light={light}
    >
      <span className={`size-2.5 rounded-full ${DOT[light]}`} aria-hidden="true" />
      {LIGHT_LABEL[light]}
    </span>
  );
}

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ cobrado?: string; q?: string; empresas?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const t = es.receivables;
  const notice = await searchParams;
  const onlyCompanies = notice.empresas === "1";
  const { items, byCustomer, aging, totalOutstanding } = await listReceivables(user, {
    onlyCompanies,
    q: notice.q,
  });

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {notice.cobrado && /^\d+(\.\d{1,2})?$/.test(notice.cobrado) ? (
        <Alert tone="success">Pago registrado. Saldo de la cuenta: S/ {notice.cobrado}</Alert>
      ) : null}

      <form className="grid gap-2 sm:grid-cols-[1fr_auto_auto]" role="search">
        <Input
          name="q"
          defaultValue={notice.q ?? ""}
          placeholder={t.searchCustomer}
          aria-label={t.searchCustomer}
        />
        <label className="flex min-h-12 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="empresas"
            value="1"
            defaultChecked={onlyCompanies}
            className="size-5"
          />
          {t.onlyCompanies}
        </label>
        <Button type="submit" variant="outline">
          Filtrar
        </Button>
      </form>

      <Card className="space-y-2">
        <p className="text-lg font-semibold" data-testid="outstanding">
          {t.outstanding}: S/ {totalOutstanding}
        </p>
        <dl className="grid grid-cols-2 gap-1 text-sm sm:grid-cols-5">
          {(Object.keys(t.aging) as Array<keyof typeof t.aging>).map((bucket) => (
            <div key={bucket}>
              <dt className="text-muted-foreground">{t.aging[bucket]}</dt>
              <dd>S/ {aging[bucket]}</dd>
            </div>
          ))}
        </dl>
      </Card>

      {byCustomer.length > 0 ? (
        <Card className="space-y-2">
          <CardTitle>{t.byCompany}</CardTitle>
          <ul className="divide-y divide-border text-sm">
            {byCustomer.map((c) => (
              <li
                key={c.customerId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
                data-testid="receivable-company"
              >
                <span>
                  {c.customer} · {c.count} {c.count === 1 ? t.invoice : t.invoices}
                </span>
                <span className="flex items-center gap-3">
                  <strong>S/ {c.balance}</strong>
                  <LightBadge light={c.light} />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {items.length === 0 ? <p className="text-muted-foreground">{t.none}</p> : null}
      <ul className="space-y-3">
        {items.map((r) => (
          <li key={r.id}>
            <Card className="space-y-2" data-testid="receivable">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {r.customer} ·{" "}
                  <Link className="underline" href={`/app/sales/${r.saleId}`}>
                    Venta #{r.saleNumber}
                  </Link>
                </p>
                <LightBadge light={r.light} testId="receivable-light" />
              </div>
              <p className="text-sm text-muted-foreground">
                {es.pos.balance} S/ {r.balance} de S/ {r.total} · {t.dueDate}{" "}
                {formatDate(r.dueDate)}
                {r.daysOverdue > 0
                  ? ` · ${r.daysOverdue} ${t.daysOverdue}`
                  : r.daysToDue >= 0
                    ? ` · ${t.dueIn} ${r.daysToDue} ${t.days}`
                    : ""}{" "}
                · {t.status[r.status]}
              </p>
              {can(user, "cash:crear") ? (
                <ActionForm
                  action={collectReceivableAction}
                  submitLabel={t.registerPayment}
                  size="sm"
                  className="grid gap-2 sm:grid-cols-4"
                >
                  <input type="hidden" name="receivableId" value={r.id} />
                  <input type="hidden" name="idempotencyKey" value={randomUUID()} />
                  <div>
                    <Label htmlFor={`m-${r.id}`}>{es.pos.method}</Label>
                    <Select id={`m-${r.id}`} name="method" defaultValue="CASH">
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>
                          {METHOD_LABEL[m]}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor={`a-${r.id}`}>{t.collectAmount}</Label>
                    <Input
                      id={`a-${r.id}`}
                      name="amount"
                      inputMode="decimal"
                      defaultValue={r.balance}
                      required
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label htmlFor={`r-${r.id}`}>{t.reference}</Label>
                    <Input id={`r-${r.id}`} name="reference" maxLength={80} />
                  </div>
                </ActionForm>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </>
  );
}
