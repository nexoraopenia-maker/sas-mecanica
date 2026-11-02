import {
  testMessageAction,
  updateAiSettingsAction,
  updateChannelsAction,
} from "@/app/actions/purchasing";
import { updateOperationsAction, updateProfileAction } from "@/app/actions/company";
import { ActionForm } from "@/components/forms/action-form";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { can } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { getAppUrl } from "@/lib/app-url";
import { es } from "@/lib/i18n/es";
import { getAiSettings, getChannelSettings } from "@/server/services/ai-settings";
import { getCompanySettings } from "@/server/services/company-settings";

export default async function SettingsPage() {
  const user = await requireTenantUser();
  const t = es.settings;
  const [company, ai, channels] = await Promise.all([
    can(user, "settings:ver") ? getCompanySettings(user) : null,
    can(user, "ai_agent:ver") ? getAiSettings(user) : null,
    can(user, "settings:ver") ? getChannelSettings(user) : null,
  ]);

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>

      {company ? (
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
              <div>
                <Label htmlFor="ticketWidthMm">{es.company.ticketWidth}</Label>
                <Select
                  id="ticketWidthMm"
                  name="ticketWidthMm"
                  defaultValue={String(company.operations.ticketWidthMm)}
                  disabled={!can(user, "settings:editar")}
                >
                  <option value="80">80</option>
                  <option value="58">58</option>
                </Select>
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
                  <span className="text-xs text-muted-foreground">
                    {" "}
                    ({es.company.pricesLocked})
                  </span>
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
        </>
      ) : null}

      {ai ? (
        <Card>
          <CardTitle>{t.ai}</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground" data-testid="api-key-state">
            {t.apiKey}: {ai.apiKeyMasked ?? "no configurada"}
          </p>
          <ActionForm
            action={updateAiSettingsAction}
            submitLabel={t.save}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <Label htmlFor="apiKey">{t.apiKey}</Label>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
              />
              <p className="mt-1 text-xs text-muted-foreground">{t.apiKeyHelp}</p>
            </div>
            <label className="flex min-h-12 items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="clearApiKey" className="size-5" />
              {t.clearKey}
            </label>
            <div>
              <Label htmlFor="model">{t.model}</Label>
              <Input id="model" name="model" defaultValue={ai.model} />
            </div>
            <div>
              <Label htmlFor="mode">{t.mode}</Label>
              <Select id="mode" name="mode" defaultValue={ai.mode}>
                <option value="DRAFT_APPROVAL">{t.modeDraft}</option>
                <option value="AUTOMATIC">{t.modeAuto}</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="tone">{t.tone}</Label>
              <Input id="tone" name="tone" defaultValue={ai.tone ?? ""} />
            </div>
            <div>
              <Label htmlFor="monthlyTokenCap">{t.tokenCap}</Label>
              <Input
                id="monthlyTokenCap"
                name="monthlyTokenCap"
                inputMode="numeric"
                defaultValue={ai.monthlyTokenCap ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="monthlyCostCapUsd">{t.costCap}</Label>
              <Input
                id="monthlyCostCapUsd"
                name="monthlyCostCapUsd"
                inputMode="decimal"
                defaultValue={ai.monthlyCostCapUsd ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxOrderAmount">{t.maxAmount}</Label>
              <Input
                id="maxOrderAmount"
                name="maxOrderAmount"
                inputMode="decimal"
                defaultValue={ai.maxOrderAmount ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxQtyPerSku">{t.maxQty}</Label>
              <Input
                id="maxQtyPerSku"
                name="maxQtyPerSku"
                inputMode="decimal"
                defaultValue={ai.maxQtyPerSku ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxOrdersPerDay">{t.maxOrders}</Label>
              <Input
                id="maxOrdersPerDay"
                name="maxOrdersPerDay"
                inputMode="numeric"
                defaultValue={ai.maxOrdersPerDay}
              />
            </div>
          </ActionForm>
        </Card>
      ) : null}

      {channels ? (
        <Card>
          <CardTitle>{t.channels}</CardTitle>
          <p className="mb-3 text-xs text-muted-foreground">
            {t.inboundUrl}: {getAppUrl()}/api/webhooks/supplier/{user.tenantId}
          </p>
          <ActionForm
            action={updateChannelsAction}
            submitLabel={t.save}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="whatsappProvider">{t.provider}</Label>
              <Select
                id="whatsappProvider"
                name="whatsappProvider"
                defaultValue={channels.whatsappProvider ?? ""}
              >
                <option value="">—</option>
                <option value="N8N">n8n</option>
                <option value="EVOLUTION">Evolution API</option>
                <option value="BUSINESS">WhatsApp Business</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="whatsappWebhookUrl">{t.webhookUrl}</Label>
              <Input
                id="whatsappWebhookUrl"
                name="whatsappWebhookUrl"
                defaultValue={channels.whatsappWebhookUrl ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="whatsappApiKey">
                {t.waKey} ({channels.whatsappApiKeyMasked ?? "sin clave"})
              </Label>
              <Input id="whatsappApiKey" name="whatsappApiKey" type="password" autoComplete="off" />
            </div>
            <label className="flex min-h-12 items-center gap-2 text-sm">
              <input type="checkbox" name="rotateInboundSecret" className="size-5" />
              {t.rotateSecret}
            </label>
            <div>
              <Label htmlFor="smtpHost">{t.smtpHost}</Label>
              <Input id="smtpHost" name="smtpHost" defaultValue={channels.smtpHost ?? ""} />
            </div>
            <div>
              <Label htmlFor="smtpPort">{t.smtpPort}</Label>
              <Input
                id="smtpPort"
                name="smtpPort"
                inputMode="numeric"
                defaultValue={channels.smtpPort ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="smtpUser">{t.smtpUser}</Label>
              <Input id="smtpUser" name="smtpUser" defaultValue={channels.smtpUser ?? ""} />
            </div>
            <div>
              <Label htmlFor="smtpPassword">
                {t.smtpPassword} ({channels.smtpPasswordMasked ?? "sin clave"})
              </Label>
              <Input id="smtpPassword" name="smtpPassword" type="password" autoComplete="off" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="smtpFromAddress">{t.smtpFrom}</Label>
              <Input
                id="smtpFromAddress"
                name="smtpFromAddress"
                defaultValue={channels.smtpFromAddress ?? ""}
              />
            </div>
            <input type="hidden" name="smtpSecure" value="on" />
          </ActionForm>
          <h3 className="mb-2 mt-6 font-medium">{t.sendTest}</h3>
          <ActionForm
            action={testMessageAction}
            submitLabel={t.sendTest}
            variant="outline"
            className="grid gap-4 sm:grid-cols-3"
          >
            <div>
              <Label htmlFor="test-channel">Canal</Label>
              <Select id="test-channel" name="channel">
                <option value="WHATSAPP">WhatsApp</option>
                <option value="EMAIL">Correo</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="test-to">{t.testTo}</Label>
              <Input id="test-to" name="to" required />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
