import { randomUUID } from "node:crypto";
import Link from "next/link";
import { quoteStatusAction, quoteToSaleAction, quoteToWorkOrderAction } from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/pos/cash";
import { formatDate } from "@/lib/workshop/format";
import { getQuote } from "@/server/services/quotes";

export default async function QuotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const t = es.quotes;
  const quote = await getQuote(user, id);
  const convertible = ["DRAFT", "SENT", "ACCEPTED"].includes(quote.status);
  const idempotencyKey = randomUUID();

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">Cotización #{quote.number}</h1>
        <span className="rounded-full bg-muted px-3 py-1 text-sm" data-testid="quote-status">
          {t.status[quote.status as keyof typeof t.status]}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {quote.customer?.name ?? es.pos.noCustomer}{" "}
        {quote.vehicle ? `· ${quote.vehicle.plate}` : ""} · {t.validUntil}{" "}
        {formatDate(quote.validUntil)}
      </p>
      {quote.sales.length > 0 || quote.workOrders.length > 0 ? (
        <p className="text-sm">
          {t.convertedTo}:{" "}
          {quote.sales.map((s) => (
            <Link key={s.id} className="mr-2 underline text-primary" href={`/app/sales/${s.id}`}>
              Venta #{s.number}
            </Link>
          ))}
          {quote.workOrders.map((o) => (
            <Link key={o.id} className="mr-2 underline text-primary" href={`/app/workshop/${o.id}`}>
              OT #{o.number}
            </Link>
          ))}
        </p>
      ) : null}

      <Card className="space-y-3">
        <ul className="divide-y divide-border">
          {quote.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
            >
              <span>
                {item.quantity} × {item.description}
              </span>
              <span>
                S/ {Number(item.unitPrice).toFixed(2)}
                {Number(item.discount) > 0 ? ` − ${item.discount}` : ""}
              </span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 text-sm sm:max-w-xs">
          <dt>{es.pos.subtotal}</dt>
          <dd className="text-right">S/ {quote.subtotal}</dd>
          <dt>{es.pos.tax}</dt>
          <dd className="text-right">S/ {quote.taxTotal}</dd>
          <dt className="font-semibold">{es.pos.total}</dt>
          <dd className="text-right font-semibold">S/ {quote.total}</dd>
        </dl>
        {can(user, "pos:crear") && ["DRAFT", "SENT", "ACCEPTED"].includes(quote.status) ? (
          <div className="flex flex-wrap gap-2">
            {quote.status === "DRAFT" ? (
              <ActionForm
                action={quoteStatusAction}
                submitLabel={t.markSent}
                size="sm"
                variant="outline"
                className="inline"
              >
                <input type="hidden" name="quoteId" value={id} />
                <input type="hidden" name="status" value="SENT" />
              </ActionForm>
            ) : null}
            {quote.status !== "ACCEPTED" ? (
              <ActionForm
                action={quoteStatusAction}
                submitLabel={t.markAccepted}
                size="sm"
                variant="outline"
                className="inline"
              >
                <input type="hidden" name="quoteId" value={id} />
                <input type="hidden" name="status" value="ACCEPTED" />
              </ActionForm>
            ) : null}
            <ActionForm
              action={quoteStatusAction}
              submitLabel={t.markRejected}
              size="sm"
              variant="outline"
              className="inline"
            >
              <input type="hidden" name="quoteId" value={id} />
              <input type="hidden" name="status" value="REJECTED" />
            </ActionForm>
          </div>
        ) : null}
      </Card>

      {convertible && can(user, "pos:crear") ? (
        <Card className="space-y-3">
          <CardTitle>{t.toSale}</CardTitle>
          <ActionForm action={quoteToSaleAction} submitLabel={t.toSale} className="space-y-3">
            <input type="hidden" name="quoteId" value={id} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            {quote.items
              .filter((i) => i.trackingMode === "SERIAL")
              .map((i) => (
                <div key={i.id}>
                  <Label htmlFor={`serials_${i.id}`}>
                    {es.pos.serials}: {i.description}
                  </Label>
                  <textarea
                    id={`serials_${i.id}`}
                    name={`serials_${i.id}`}
                    rows={2}
                    className="w-full rounded-lg border border-border bg-input px-3 py-2"
                  />
                </div>
              ))}
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="documentType">{es.pos.document}</Label>
                <Select id="documentType" name="documentType" defaultValue="BOLETA">
                  <option value="BOLETA">{es.pos.boleta}</option>
                  <option value="FACTURA">{es.pos.factura}</option>
                  <option value="NOTA_VENTA">{es.pos.saleNote}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="method">{es.pos.method}</Label>
                <Select id="method" name="method" defaultValue="CASH">
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="amount">{es.pos.amount}</Label>
                <Input id="amount" name="amount" inputMode="decimal" defaultValue={quote.total} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="isCredit" className="size-5" />
              {es.pos.credit}
            </label>
          </ActionForm>
        </Card>
      ) : null}

      {convertible && quote.vehicle && can(user, "workshop:crear") ? (
        <Card className="space-y-3">
          <CardTitle>{t.toWorkOrder}</CardTitle>
          <ActionForm
            action={quoteToWorkOrderAction}
            submitLabel={t.toWorkOrder}
            variant="outline"
            className="grid gap-3 sm:grid-cols-3"
          >
            <input type="hidden" name="quoteId" value={id} />
            <div>
              <Label htmlFor="mileageIn">{t.mileage}</Label>
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
              />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
