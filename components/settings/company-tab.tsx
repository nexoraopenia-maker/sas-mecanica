import {
  removeLogoAction,
  updateOperationsAction,
  updateProfileAction,
  uploadLogoAction,
} from "@/app/actions/company";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, type AuthUser } from "@/lib/auth/can";
import { LOGO_MAX_BYTES, LOGO_MAX_SIDE, LOGO_MIN_SIDE } from "@/lib/branding/logo";
import { es } from "@/lib/i18n/es";
import { getTenantLogoUrl } from "@/server/services/branding";
import { getCompanySettings } from "@/server/services/company-settings";

/** Pestaña «Datos del taller»: perfil, logo y parámetros operativos. */
export async function CompanyTab({ user }: { user: AuthUser }) {
  const company = await getCompanySettings(user);
  const logoUrl = await getTenantLogoUrl(user);
  const canEdit = can(user, "settings:editar");
  return (
    <>
      <Card>
        <CardTitle>{es.company.profile}</CardTitle>
        <ActionForm
          action={updateProfileAction}
          submitLabel={es.company.saveProfile}
          className="grid gap-4 sm:grid-cols-2"
        >
          <div>
            <Label htmlFor="legalName">{es.company.legalName}</Label>
            <Input
              id="legalName"
              name="legalName"
              defaultValue={company.profile.legalName}
              required
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="tradeName">{es.company.tradeName}</Label>
            <Input
              id="tradeName"
              name="tradeName"
              defaultValue={company.profile.tradeName ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="taxId">{es.company.taxId}</Label>
            <Input
              id="taxId"
              name="taxId"
              defaultValue={company.profile.taxId ?? ""}
              inputMode="numeric"
              disabled={!can(user, "settings:editar") || company.locks.taxId}
            />
            {company.locks.taxId ? (
              <p className="mt-1 text-xs text-muted-foreground">{es.company.taxIdLocked}</p>
            ) : null}
          </div>
          <div>
            <Label htmlFor="phone">{es.company.phone}</Label>
            <Input
              id="phone"
              name="phone"
              defaultValue={company.profile.phone ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="address">{es.company.address}</Label>
            <Input
              id="address"
              name="address"
              defaultValue={company.profile.address ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="contactName">{es.company.contactName}</Label>
            <Input
              id="contactName"
              name="contactName"
              defaultValue={company.profile.contactName ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="contactEmail">{es.company.contactEmail}</Label>
            <Input
              id="contactEmail"
              name="contactEmail"
              type="email"
              defaultValue={company.profile.contactEmail ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="billingEmail">{es.company.billingEmail}</Label>
            <Input
              id="billingEmail"
              name="billingEmail"
              type="email"
              defaultValue={company.profile.billingEmail ?? ""}
              disabled={!can(user, "settings:editar")}
            />
          </div>
        </ActionForm>
      </Card>
      <Card>
        <CardTitle>{es.company.operations}</CardTitle>
        <ActionForm
          action={updateOperationsAction}
          submitLabel={es.company.saveOps}
          className="grid gap-4 sm:grid-cols-3"
        >
          <div>
            <Label htmlFor="taxName">{es.company.taxName}</Label>
            <Input
              id="taxName"
              name="taxName"
              defaultValue={company.operations.taxName}
              required
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="taxPercent">{es.company.taxPercent}</Label>
            <Input
              id="taxPercent"
              name="taxPercent"
              inputMode="decimal"
              defaultValue={String(Number(company.operations.taxRate) * 100)}
              required
              disabled={!can(user, "settings:editar")}
            />
          </div>
          {company.locks.pricesIncludeTax && company.operations.pricesIncludeTax ? (
            <input type="hidden" name="pricesIncludeTax" value="on" />
          ) : null}
          <label className="flex min-h-12 items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              name="pricesIncludeTax"
              defaultChecked={company.operations.pricesIncludeTax}
              disabled={!can(user, "settings:editar") || company.locks.pricesIncludeTax}
              className="size-5"
            />
            {es.company.pricesIncludeTax}
            {company.locks.pricesIncludeTax ? (
              <span className="text-xs text-muted-foreground"> ({es.company.pricesLocked})</span>
            ) : null}
          </label>
          <label className="flex min-h-12 items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="allowNegativeStock"
              defaultChecked={company.operations.allowNegativeStock}
              disabled={!can(user, "settings:editar")}
              className="size-5"
            />
            {es.company.allowNegative}
          </label>
          <div>
            <Label htmlFor="tireMaxAgeYears">{es.company.tireMaxAge}</Label>
            <Input
              id="tireMaxAgeYears"
              name="tireMaxAgeYears"
              type="number"
              min={1}
              max={15}
              defaultValue={company.operations.tireMaxAgeYears}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="rotationWindowDays">{es.company.rotationWindow}</Label>
            <Input
              id="rotationWindowDays"
              name="rotationWindowDays"
              type="number"
              min={7}
              max={180}
              defaultValue={company.operations.rotationWindowDays}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="deadStockDays">{es.company.deadStock}</Label>
            <Input
              id="deadStockDays"
              name="deadStockDays"
              type="number"
              min={7}
              max={730}
              defaultValue={company.operations.deadStockDays}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="aiMinutesSavedPerLine">{es.company.aiMinutes}</Label>
            <Input
              id="aiMinutesSavedPerLine"
              name="aiMinutesSavedPerLine"
              type="number"
              min={0}
              max={240}
              defaultValue={company.operations.aiMinutesSavedPerLine}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="staffHourlyCost">{es.company.hourlyCost}</Label>
            <Input
              id="staffHourlyCost"
              name="staffHourlyCost"
              inputMode="decimal"
              defaultValue={company.operations.staffHourlyCost}
              disabled={!can(user, "settings:editar")}
            />
          </div>
          <div>
            <Label htmlFor="usdExchangeRate">{es.company.usdRate}</Label>
            <Input
              id="usdExchangeRate"
              name="usdExchangeRate"
              inputMode="decimal"
              defaultValue={company.operations.usdExchangeRate}
              disabled={!can(user, "settings:editar")}
            />
          </div>
        </ActionForm>
      </Card>

      <Card data-testid="logo-card">
        <CardTitle>{es.company.logo}</CardTitle>
        <div className="flex flex-wrap items-center gap-4">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt={es.company.logo}
              className="h-20 w-auto max-w-56 rounded-lg border border-border bg-paper p-2"
              data-testid="logo-preview"
            />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="logo-empty">
              {es.company.logoEmpty}
            </p>
          )}
          {canEdit ? (
            <div className="space-y-3">
              <ActionForm
                action={uploadLogoAction}
                submitLabel={es.company.logoUpload}
                className="flex flex-wrap items-end gap-3"
              >
                <div>
                  <Label htmlFor="logo">{es.company.logoFile}</Label>
                  <Input
                    id="logo"
                    name="logo"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    required
                  />
                </div>
              </ActionForm>
              {logoUrl ? (
                <ActionForm
                  action={removeLogoAction}
                  submitLabel={es.company.logoRemove}
                  variant="outline"
                  size="sm"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {es.company.logoHelp(LOGO_MAX_BYTES / 1_048_576, LOGO_MIN_SIDE, LOGO_MAX_SIDE)}
        </p>
      </Card>
    </>
  );
}
