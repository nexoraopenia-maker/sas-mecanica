import { randomUUID } from "node:crypto";
import Link from "next/link";
import {
  debitNoteAction,
  resendDocumentAction,
  retryDocumentAction,
  returnSaleAction,
  voidSaleAction,
} from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL, PAYMENT_METHODS } from "@/lib/pos/cash";
import { formatDateTime } from "@/lib/workshop/format";
import { getSale } from "@/server/services/sales";

export default async function SalePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ nueva?: string; anulada?: string; devolucion?: string }>;
}) {
  const { id } = await params;
  const notice = await searchParams;
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const t = es.pos;
  const sale = await getSale(user, id);
  const canVoid = can(user, "pos:anular_venta") && sale.status === "COMPLETED";
  const returnable = sale.items.filter((i) => Number(i.quantity) - Number(i.returned) > 0);
  const mainDoc = sale.documents.find((d) => d.type === "BOLETA" || d.type === "FACTURA");

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {t.saleNumber} #{sale.number}
        </h1>
        <span className="rounded-full bg-muted px-3 py-1 text-sm" data-testid="sale-status">
          {sale.status === "VOIDED" ? t.status.VOIDED : t.paymentStatus[sale.paymentStatus]}
        </span>
      </div>
      {notice.nueva === "1" ? <Alert tone="success">Venta registrada.</Alert> : null}
      {notice.anulada === "1" ? <Alert tone="success">Venta anulada.</Alert> : null}
      {notice.devolucion ? <Alert tone="success">Devolución registrada.</Alert> : null}
      <p className="text-sm text-muted-foreground">
        {formatDateTime(sale.createdAt)} · {t.seller}: {sale.seller ?? "—"} ·{" "}
        {sale.customer?.name ?? t.noCustomer}
        {sale.vehicle ? ` · ${sale.vehicle.plate}` : ""}
        {sale.workOrderId ? (
          <>
            {" "}
            ·{" "}
            <Link className="underline" href={`/app/workshop/${sale.workOrderId}`}>
              OT
            </Link>
          </>
        ) : null}
      </p>
      {sale.voidReason ? (
        <Alert>
          {t.void}: {sale.voidReason}
        </Alert>
      ) : null}

      <Card className="space-y-3">
        <ul className="divide-y divide-border">
          {sale.items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-baseline justify-between gap-2 py-2 text-sm"
              data-testid="sale-item"
            >
              <span>
                {item.quantity} × {item.description}
                {item.serial ? ` · serie ${item.serial}` : ""}
                {item.dotCode ? ` · DOT ${item.dotCode}` : ""}
                {Number(item.returned) > 0 ? ` · ${item.returned} ${t.returned}` : ""}
              </span>
              <span>S/ {item.lineTotal}</span>
            </li>
          ))}
        </ul>
        <dl className="grid grid-cols-2 gap-1 text-sm sm:max-w-xs">
          <dt>{t.subtotal}</dt>
          <dd className="text-right">S/ {sale.subtotal}</dd>
          <dt>{t.tax}</dt>
          <dd className="text-right">S/ {sale.taxTotal}</dd>
          <dt className="font-semibold">{t.total}</dt>
          <dd className="text-right font-semibold">S/ {sale.total}</dd>
          <dt>{t.paid}</dt>
          <dd className="text-right">S/ {sale.paidTotal}</dd>
        </dl>
        <ul className="text-sm text-muted-foreground">
          {sale.payments.map((p) => (
            <li key={p.id}>
              {METHOD_LABEL[p.method]} · S/ {p.amount} {p.reference ? `· ${p.reference}` : ""}
            </li>
          ))}
        </ul>
        {sale.receivable ? (
          <p className="text-sm">
            {t.balance}: S/ {sale.receivable.balance} · {es.receivables.dueDate}{" "}
            {formatDateTime(sale.receivable.dueDate)} ·{" "}
            <Link className="underline" href="/app/receivables">
              {es.receivables.title}
            </Link>
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3 text-sm">
          <Link
            className="underline"
            href={`/app/sales/${id}/print?formato=ticket`}
            target="_blank"
          >
            {t.print} · {t.ticket}
          </Link>
          <Link className="underline" href={`/app/sales/${id}/print?formato=a4`} target="_blank">
            {t.print} · {t.a4}
          </Link>
        </div>
      </Card>

      {sale.documents.length > 0 ? (
        <Card className="space-y-3">
          <CardTitle>{es.billing.documents}</CardTitle>
          <ul className="space-y-3">
            {sale.documents.map((doc) => (
              <li key={doc.id} className="space-y-2 text-sm" data-testid="sale-document">
                <p>
                  {es.billing.type[doc.type]} {doc.number} · S/ {doc.total} ·{" "}
                  <strong>{es.billing.status[doc.status]}</strong>
                  {doc.noteReason ? ` · ${doc.noteReason}` : ""}
                </p>
                {doc.errorMessage ? <Alert tone="error">{doc.errorMessage}</Alert> : null}
                <div className="flex flex-wrap gap-2">
                  {can(user, "billing:editar") &&
                  (doc.status === "PENDING" || doc.status === "REJECTED") ? (
                    <ActionForm
                      action={retryDocumentAction}
                      submitLabel={es.billing.retry}
                      size="sm"
                      variant="outline"
                      className="inline"
                    >
                      <input type="hidden" name="documentId" value={doc.id} />
                    </ActionForm>
                  ) : null}
                  {can(user, "billing:crear") && doc.status === "ACCEPTED" && sale.customer ? (
                    <ActionForm
                      action={resendDocumentAction}
                      submitLabel={es.billing.resend}
                      size="sm"
                      variant="outline"
                      className="inline"
                    >
                      <input type="hidden" name="documentId" value={doc.id} />
                    </ActionForm>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {mainDoc?.status === "ACCEPTED" && can(user, "billing:editar") ? (
            <ActionForm
              action={debitNoteAction}
              submitLabel={es.billing.issueDebit}
              size="sm"
              variant="outline"
              className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-4"
            >
              <input type="hidden" name="documentId" value={mainDoc.id} />
              <input type="hidden" name="idempotencyKey" value={randomUUID()} />
              <div>
                <Label htmlFor="reasonCode">{es.billing.debitReason}</Label>
                <Select id="reasonCode" name="reasonCode" defaultValue="01">
                  <option value="01">Intereses por mora</option>
                  <option value="02">Aumento en el valor</option>
                  <option value="03">Penalidades</option>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="description">{es.billing.debitDescription}</Label>
                <Input id="description" name="description" required minLength={3} maxLength={200} />
              </div>
              <div>
                <Label htmlFor="amount">{es.billing.debitAmount}</Label>
                <Input id="amount" name="amount" inputMode="decimal" required />
              </div>
            </ActionForm>
          ) : null}
        </Card>
      ) : null}

      {canVoid && returnable.length > 0 ? (
        <Card className="space-y-3">
          <CardTitle>{t.returnItems}</CardTitle>
          <ActionForm
            action={returnSaleAction}
            submitLabel={t.submitReturn}
            variant="outline"
            className="space-y-3"
          >
            <input type="hidden" name="saleId" value={id} />
            <input type="hidden" name="idempotencyKey" value={randomUUID()} />
            {returnable.map((item) => (
              <div key={item.id} className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                <p className="text-sm">{item.description}</p>
                <div>
                  <Label htmlFor={`qty_${item.id}`}>{t.returnQty}</Label>
                  <Input
                    id={`qty_${item.id}`}
                    name={`qty_${item.id}`}
                    inputMode="decimal"
                    placeholder={`máx. ${Number(item.quantity) - Number(item.returned)}`}
                    className="max-w-32"
                  />
                </div>
                <label className="flex items-center gap-1 pb-3 text-xs">
                  <input
                    type="checkbox"
                    name={`restock_${item.id}`}
                    defaultChecked
                    className="size-5"
                  />
                  {t.restock}
                </label>
              </div>
            ))}
            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label htmlFor="resolution">{t.resolution}</Label>
                <Select id="resolution" name="resolution" defaultValue="REFUND">
                  <option value="REFUND">{t.refund}</option>
                  <option value="CREDIT_NOTE">{t.creditNote}</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="refundMethod">{t.method}</Label>
                <Select id="refundMethod" name="refundMethod" defaultValue="CASH">
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="reason">{es.cash.reason}</Label>
                <Input id="reason" name="reason" required minLength={5} maxLength={300} />
              </div>
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {canVoid ? (
        <Card className="space-y-3">
          <CardTitle>{t.void}</CardTitle>
          <ActionForm
            action={voidSaleAction}
            submitLabel={t.void}
            variant="destructive"
            size="sm"
            className="flex flex-wrap items-end gap-2"
          >
            <input type="hidden" name="saleId" value={id} />
            <div className="min-w-64 flex-1">
              <Label htmlFor="void-reason">{t.voidReason}</Label>
              <Input id="void-reason" name="reason" required minLength={5} maxLength={300} />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {sale.returns.length > 0 ? (
        <Card className="space-y-1 text-sm">
          <CardTitle>{t.returnItems}</CardTitle>
          {sale.returns.map((r) => (
            <p key={r.id}>
              #{r.number} · S/ {r.total} · {r.reason}
            </p>
          ))}
        </Card>
      ) : null}
    </>
  );
}
