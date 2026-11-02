import {
  resendDocumentAction,
  retryDocumentAction,
  updateInvoiceSettingsAction,
} from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDateTime } from "@/lib/workshop/format";
import { getInvoiceSettings, listDocuments } from "@/server/services/billing";

const STATUSES = ["PENDING", "ACCEPTED", "REJECTED", "VOIDED"] as const;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "billing:ver");
  const t = es.billing;
  const { estado } = await searchParams;
  const status = STATUSES.find((s) => s === estado);
  const [documents, settings] = await Promise.all([
    listDocuments(user, status ? { status } : {}),
    getInvoiceSettings(user),
  ]);
  const canEdit = can(user, "billing:editar");

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {settings.provider === "NONE" ? <Alert>{t.noProviderWarning}</Alert> : null}

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Estado">
        <a className="rounded-full bg-muted px-3 py-2" href="/app/billing">
          {es.workshop.all}
        </a>
        {STATUSES.map((s) => (
          <a key={s} className="rounded-full bg-muted px-3 py-2" href={`/app/billing?estado=${s}`}>
            {t.status[s]}
          </a>
        ))}
      </nav>

      <h2 className="text-xl font-semibold">{t.documents}</h2>
      {documents.length === 0 ? <p className="text-muted-foreground">{t.none}</p> : null}
      <ul className="space-y-3">
        {documents.map((doc) => (
          <li key={doc.id}>
            <Card className="space-y-2" data-testid="billing-document">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {t.type[doc.type]} {doc.number} · S/ {doc.total}
                </p>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {t.status[doc.status]}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {formatDateTime(doc.issueDate)} {doc.saleNumber ? `· Venta #${doc.saleNumber}` : ""}{" "}
                {doc.attempts > 0 ? `· ${doc.attempts} ${t.attempts}` : ""}
                {doc.noteReason ? ` · ${doc.noteReason}` : ""}
              </p>
              {doc.errorMessage ? <Alert tone="error">{doc.errorMessage}</Alert> : null}
              <div className="flex flex-wrap gap-2">
                {canEdit && (doc.status === "PENDING" || doc.status === "REJECTED") ? (
                  <ActionForm
                    action={retryDocumentAction}
                    submitLabel={t.retry}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="documentId" value={doc.id} />
                  </ActionForm>
                ) : null}
                {can(user, "billing:crear") && doc.status === "ACCEPTED" ? (
                  <ActionForm
                    action={resendDocumentAction}
                    submitLabel={t.resend}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="documentId" value={doc.id} />
                  </ActionForm>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {canEdit ? (
        <Card>
          <CardTitle>{t.settings}</CardTitle>
          <ActionForm
            action={updateInvoiceSettingsAction}
            submitLabel={t.save}
            className="space-y-4"
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="provider">{t.provider}</Label>
                <Select id="provider" name="provider" defaultValue={settings.provider}>
                  <option value="NONE">{t.providerNone}</option>
                  <option value="SIMULATED">{t.providerSimulated}</option>
                  <option value="HTTP">{t.providerHttp}</option>
                </Select>
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="baseUrl">{t.baseUrl}</Label>
                <Input
                  id="baseUrl"
                  name="baseUrl"
                  defaultValue={settings.baseUrl ?? ""}
                  placeholder="https://"
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="token">{t.token}</Label>
                <Input
                  id="token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  placeholder={settings.tokenMask ?? ""}
                />
                <p className="mt-1 text-xs text-muted-foreground">{t.tokenKeep}</p>
              </div>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input type="checkbox" name="clearToken" className="size-5" />
                {t.clearToken}
              </label>
            </div>
            <div className="grid gap-3 sm:grid-cols-4">
              {(
                [
                  "boletaSeries",
                  "facturaSeries",
                  "creditNoteBoletaSeries",
                  "creditNoteFacturaSeries",
                  "debitNoteBoletaSeries",
                  "debitNoteFacturaSeries",
                  "saleNoteSeries",
                ] as const
              ).map((name) => (
                <div key={name}>
                  <Label htmlFor={name}>{t[name]}</Label>
                  <Input
                    id={name}
                    name={name}
                    defaultValue={settings[name]}
                    maxLength={4}
                    required
                  />
                </div>
              ))}
              <div>
                <Label htmlFor="defaultCreditDays">{t.defaultCreditDays}</Label>
                <Input
                  id="defaultCreditDays"
                  name="defaultCreditDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={settings.defaultCreditDays}
                  required
                />
              </div>
              <div>
                <Label htmlFor="cashTolerance">{t.cashTolerance}</Label>
                <Input
                  id="cashTolerance"
                  name="cashTolerance"
                  inputMode="decimal"
                  defaultValue={settings.cashTolerance}
                  required
                />
              </div>
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
