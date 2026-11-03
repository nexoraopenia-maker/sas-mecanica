import { ZodError } from "zod";
import { registerPurchaseInvoiceAction, voidPurchaseInvoiceAction } from "@/app/actions/ple";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { limaYearMonth, pleDate } from "@/lib/ple/format";
import { PURCHASE_DOC_TYPES } from "@/lib/ple/spec";
import { listPurchaseInvoices, previewPle } from "@/server/services/ple";

const MONTHS = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

export default async function PlePage({
  searchParams,
}: {
  searchParams: Promise<{ anio?: string; mes?: string }>;
}) {
  const query = await searchParams;
  const user = await requireTenantUser();
  requirePermission(user, "reports:ver");
  const t = es.ple;
  const now = limaYearMonth(new Date());
  const input = { year: query.anio ?? now.year, month: query.mes ?? now.month };
  let preview: Awaited<ReturnType<typeof previewPle>> | null = null;
  let periodError: string | null = null;
  try {
    preview = await previewPle(user, input);
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    periodError = error.issues[0]?.message ?? "Periodo inválido";
  }
  const invoices =
    preview && can(user, "purchasing:ver") ? await listPurchaseInvoices(user, input) : [];
  const qs = preview ? `anio=${preview.period.year}&mes=${preview.period.month}` : "";
  const years = Array.from({ length: 6 }, (_, i) => now.year - i);

  return (
    <div className="space-y-4" data-testid="ple">
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      <p className="text-sm text-muted-foreground">{t.intro}</p>
      <Alert tone="info">{t.sireNote}</Alert>

      <Card>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="anio">{t.year}</Label>
            <Select id="anio" name="anio" defaultValue={String(preview?.period.year ?? now.year)}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="mes">{t.month}</Label>
            <Select id="mes" name="mes" defaultValue={String(preview?.period.month ?? now.month)}>
              {MONTHS.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <Button type="submit" data-testid="ple-show">
            {t.show}
          </Button>
        </form>
      </Card>

      {periodError ? <Alert tone="error">{periodError}</Alert> : null}
      {preview ? (
        <>
          {!preview.ruc ? <Alert tone="error">{t.noRuc}</Alert> : null}
          {preview.isDemoRuc ? <Alert tone="info">{t.demoRuc}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Card data-testid="ple-sales">
              <CardTitle>{t.sales}</CardTitle>
              <p data-testid="ple-sales-rows">
                {preview.sales.rows} {t.rows} · S/ {preview.sales.total}
              </p>
              {preview.sales.rows === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noRows}</p>
              ) : null}
              {preview.sales.excludedPending > 0 ? (
                <p className="text-sm text-warning" data-testid="ple-excluded-pending">
                  {preview.sales.excludedPending} {t.excludedPending}
                </p>
              ) : null}
              {preview.sales.excludedRejected > 0 ? (
                <p className="text-sm text-warning" data-testid="ple-excluded-rejected">
                  {preview.sales.excludedRejected} {t.excludedRejected}
                </p>
              ) : null}
              {preview.ruc && !preview.isDemoRuc ? (
                <a
                  className="mt-3 inline-flex h-12 items-center rounded-lg border border-border px-4 text-sm"
                  href={`/app/reports/ple/export?libro=14.1&${qs}`}
                  data-testid="ple-download-ventas"
                >
                  {t.download}
                </a>
              ) : null}
            </Card>
            <Card data-testid="ple-purchases">
              <CardTitle>{t.purchases}</CardTitle>
              <p data-testid="ple-purchases-rows">
                {preview.purchases.rows} {t.rows} · S/ {preview.purchases.total}
              </p>
              {preview.purchases.rows === 0 ? (
                <p className="text-sm text-muted-foreground">{t.noRows}</p>
              ) : null}
              {preview.ruc && !preview.isDemoRuc ? (
                <a
                  className="mt-3 inline-flex h-12 items-center rounded-lg border border-border px-4 text-sm"
                  href={`/app/reports/ple/export?libro=8.1&${qs}`}
                  data-testid="ple-download-compras"
                >
                  {t.download}
                </a>
              ) : null}
            </Card>
          </div>

          {can(user, "purchasing:crear") ? (
            <Card>
              <CardTitle>{t.registerTitle}</CardTitle>
              <ActionForm
                action={registerPurchaseInvoiceAction}
                submitLabel="Registrar comprobante"
                className="grid gap-3 sm:grid-cols-3"
              >
                <div>
                  <Label htmlFor="docTypeCode">Tipo</Label>
                  <Select id="docTypeCode" name="docTypeCode" defaultValue="01">
                    {PURCHASE_DOC_TYPES.map((code) => (
                      <option key={code} value={code}>
                        {code}
                      </option>
                    ))}
                  </Select>
                </div>
                <div>
                  <Label htmlFor="series">Serie</Label>
                  <Input id="series" name="series" required maxLength={20} />
                </div>
                <div>
                  <Label htmlFor="number">Número</Label>
                  <Input id="number" name="number" required maxLength={20} />
                </div>
                <div>
                  <Label htmlFor="issueDate">Emisión</Label>
                  <Input id="issueDate" name="issueDate" type="date" required />
                </div>
                <div>
                  <Label htmlFor="supplierDocNumber">RUC del proveedor</Label>
                  <Input id="supplierDocNumber" name="supplierDocNumber" maxLength={15} />
                </div>
                <div>
                  <Label htmlFor="supplierName">Proveedor</Label>
                  <Input id="supplierName" name="supplierName" maxLength={100} />
                </div>
                <div>
                  <Label htmlFor="taxedBase">Base imponible</Label>
                  <Input id="taxedBase" name="taxedBase" inputMode="decimal" required />
                </div>
                <div>
                  <Label htmlFor="igv">IGV</Label>
                  <Input id="igv" name="igv" inputMode="decimal" required />
                </div>
                <div>
                  <Label htmlFor="exemptTotal">Exonerado</Label>
                  <Input id="exemptTotal" name="exemptTotal" inputMode="decimal" defaultValue="0" />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="givesTaxCredit" defaultChecked /> Da derecho a
                  crédito fiscal
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="paidWithBankMethod" /> Pagado con medio bancarizado
                </label>
              </ActionForm>
            </Card>
          ) : null}

          <Card data-testid="ple-invoices">
            <CardTitle>{t.listTitle}</CardTitle>
            {invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.empty}</p>
            ) : (
              <ul className="divide-y divide-border">
                {invoices.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <span>
                      {pleDate(inv.issueDate)} · {inv.docTypeCode} {inv.series}-{inv.number} ·{" "}
                      {inv.supplierName ?? "—"} · S/ {inv.total.toFixed(2)}
                    </span>
                    {can(user, "purchasing:eliminar") ? (
                      <ActionForm
                        action={voidPurchaseInvoiceAction}
                        submitLabel={t.void}
                        variant="outline"
                        className="flex flex-wrap items-center gap-2"
                      >
                        <input type="hidden" name="id" value={inv.id} />
                        <Input name="reason" placeholder={t.voidReason} required className="w-56" />
                      </ActionForm>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}
    </div>
  );
}
