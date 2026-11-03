import { updateInvoiceSettingsAction } from "@/app/actions/sales";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can, type AuthUser } from "@/lib/auth/can";
import { es } from "@/lib/i18n/es";
import { getInvoiceSettings } from "@/server/services/billing";

/** Pestaña «Facturación»: series, proveedor OSE, formato de ticket y crédito. */
export async function BillingTab({ user }: { user: AuthUser }) {
  const t = es.billing;
  const settings = await getInvoiceSettings(user);
  const canEdit = can(user, "billing:editar");
  return (
    <>
      {settings.provider === "NONE" ? <Alert>{t.noProviderWarning}</Alert> : null}
      {!canEdit ? <Alert>{t.readOnly}</Alert> : null}
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
                    {...(name === "boletaSeries"
                      ? { pattern: "B[0-9]{3}", title: "Formato B### (p. ej. B001)" }
                      : name === "facturaSeries"
                        ? { pattern: "F[0-9]{3}", title: "Formato F### (p. ej. F001)" }
                        : {})}
                  />
                  {settings.seriesInUse[settings[name]] ? (
                    <p className="mt-1 text-xs text-warning" data-testid={`series-used-${name}`}>
                      {settings.seriesInUse[settings[name]]} {t.seriesUsed}
                    </p>
                  ) : null}
                </div>
              ))}
              <div>
                <Label htmlFor="ticketWidthMm">{t.ticketWidth}</Label>
                <Select
                  id="ticketWidthMm"
                  name="ticketWidthMm"
                  defaultValue={String(settings.ticketWidthMm)}
                >
                  <option value="80">80 mm</option>
                  <option value="58">58 mm</option>
                </Select>
              </div>
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
            {Object.keys(settings.seriesInUse).length > 0 ? (
              <label className="flex items-start gap-3 text-sm" data-testid="confirm-series">
                <input type="checkbox" name="confirmSeriesChange" className="mt-1 size-5" />
                <span>{t.confirmSeries}</span>
              </label>
            ) : null}
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
