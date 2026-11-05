import {
  approveDraftAction,
  automationSwitchesAction,
  rejectDraftAction,
  runAgentAction,
  testMessageAction,
  updateAiSettingsAction,
  updateChannelsAction,
} from "@/app/actions/purchasing";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { VIOLATION_LABELS } from "@/lib/ai/guardrails";
import { getAppUrl } from "@/lib/app-url";
import { can, type AuthUser } from "@/lib/auth/can";
import { es } from "@/lib/i18n/es";
import { listDrafts, listRuns } from "@/server/services/ai-drafts";
import {
  getAiSettings,
  getAutomationSwitches,
  getChannelSettings,
} from "@/server/services/ai-settings";

/** Pestaña «IA y canales»: interruptores, bandeja del agente de compras, claves y canales. */
export async function AiTab({
  user,
  notice,
}: {
  user: AuthUser;
  notice: { aprobada?: string; sim?: string; rechazada?: string };
}) {
  const t = es.ai;
  const ts = es.settings;
  const sw = await getAutomationSwitches(user);
  const canAi = can(user, "ai_agent:ver");
  const [drafts, runs, ai, channels] = await Promise.all([
    canAi ? listDrafts(user) : [],
    canAi ? listRuns(user, 10) : [],
    canAi ? getAiSettings(user) : null,
    can(user, "settings:ver") ? getChannelSettings(user) : null,
  ]);
  const canApprove = can(user, "ai_agent:autorizar_pedidos_ia") && can(user, "purchasing:crear");
  const canSwitch = can(user, "ai_agent:editar") || can(user, "settings:editar");

  return (
    <>
      <Card data-testid="automation-switches">
        <CardTitle>{ts.switchesTitle}</CardTitle>
        <ActionForm
          action={automationSwitchesAction}
          submitLabel={ts.switchesSave}
          className="space-y-3"
        >
          {can(user, "ai_agent:editar") ? (
            <>
              <input type="hidden" name="aiPresent" value="1" />
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="aiAgentEnabled"
                  defaultChecked={sw.aiAgentEnabled}
                  disabled={!canSwitch}
                  className="mt-1 size-5"
                />
                <span>
                  <span className="font-medium">{ts.switchAgent}</span>
                  <span className="block text-sm text-muted-foreground">{ts.switchAgentHelp}</span>
                </span>
              </label>
            </>
          ) : null}
          {can(user, "whatsapp:editar") ? (
            <>
              <input type="hidden" name="whatsappPresent" value="1" />
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="whatsappNoticesEnabled"
                  defaultChecked={sw.whatsappNoticesEnabled}
                  disabled={!canSwitch}
                  className="mt-1 size-5"
                />
                <span>
                  <span className="font-medium">{ts.switchWhatsapp}</span>
                  <span className="block text-sm text-muted-foreground">
                    {ts.switchWhatsappHelp}
                  </span>
                </span>
              </label>
            </>
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="whatsapp-off">
              {ts.whatsappOff}
            </p>
          )}
          {can(user, "ai_agent:editar") ? (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name="humanApproval"
                defaultChecked={sw.humanApproval}
                disabled={!canSwitch}
                className="mt-1 size-5"
              />
              <span>
                <span className="font-medium">{ts.switchApproval}</span>
                <span className="block text-sm text-muted-foreground">{ts.switchApprovalHelp}</span>
              </span>
            </label>
          ) : null}
        </ActionForm>
      </Card>

      {ai ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">{t.title}</h2>
            {can(user, "ai_agent:editar") ? (
              <ActionForm
                action={runAgentAction}
                submitLabel={t.run}
                pendingLabel="El agente está analizando…"
                className="shrink-0"
              />
            ) : null}
          </div>

          {notice.aprobada && /^\d+$/.test(notice.aprobada) ? (
            <Alert tone="success">
              Orden de compra #{notice.aprobada} creada (
              {notice.sim === "1" ? "envío simulado en demo" : "en cola de envío al proveedor"}).
            </Alert>
          ) : null}
          {notice.rechazada ? <Alert tone="success">Borrador rechazado.</Alert> : null}

          <Card data-testid="ai-usage">
            <CardTitle>{t.usage}</CardTitle>
            <p className="text-sm">
              {ai.usage.tokens.toLocaleString("es-PE")} {t.tokens}
              {ai.usage.tokenCap !== null
                ? ` / ${ai.usage.tokenCap.toLocaleString("es-PE")}`
                : ""}{" "}
              · US$ {ai.usage.costUsd.toFixed(4)}
              {ai.usage.costCapUsd !== null ? ` / ${ai.usage.costCapUsd.toFixed(2)}` : ""} ·{" "}
              {ai.model} · {ai.mode === "AUTOMATIC" ? es.settings.modeAuto : es.settings.modeDraft}
            </p>
            {ai.usage.exhausted ? (
              <p className="mt-2 text-sm font-medium text-danger">
                Presupuesto agotado: el agente está detenido.
              </p>
            ) : null}
          </Card>

          <h2 className="text-xl font-semibold">{t.inbox}</h2>
          {drafts.length === 0 ? <p className="text-muted-foreground">{t.emptyInbox}</p> : null}
          <ul className="space-y-4">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <Card className="space-y-3" data-testid="draft">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{draft.supplier}</p>
                      <p className="text-xs text-muted-foreground">
                        {draft.simulated ? `${t.simulated} · ` : ""}
                        {draft.model} ·{" "}
                        {draft.whitelisted ? "Lista blanca" : "Fuera de la lista blanca"}
                      </p>
                    </div>
                    {draft.total ? (
                      <p className="text-lg font-semibold">
                        {draft.currency} {Number(draft.total).toFixed(2)}
                      </p>
                    ) : null}
                  </div>
                  {draft.violations.length > 0 ? (
                    <div
                      role="alert"
                      className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning"
                    >
                      <strong>{t.violations}</strong>
                      <ul className="list-disc pl-5">
                        {draft.violations.map((violation) => (
                          <li key={violation}>{VIOLATION_LABELS[violation]}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <ul className="space-y-1 text-sm">
                    {draft.items.map((item) => (
                      <li key={item.productId}>
                        <strong>{item.quantity} u.</strong> {item.name}{" "}
                        <span className="text-muted-foreground">({item.sku})</span>
                        {item.unitPrice ? ` · ${Number(item.unitPrice).toFixed(2)} c/u` : ""}
                        {item.rationale ? (
                          <span className="block text-xs text-muted-foreground">
                            {item.rationale}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  <pre className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                    {draft.message}
                  </pre>
                  {canApprove ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <ActionForm
                        action={approveDraftAction}
                        submitLabel={t.approve}
                        pendingLabel="Enviando…"
                      >
                        <input type="hidden" name="draftId" value={draft.id} />
                        {draft.violations.length > 0 ? (
                          <label className="flex min-h-12 items-center gap-2 text-sm">
                            <input type="checkbox" name="confirm" className="size-5" />
                            {t.confirm}
                          </label>
                        ) : null}
                      </ActionForm>
                      <ActionForm
                        action={rejectDraftAction}
                        submitLabel={t.reject}
                        variant="outline"
                      >
                        <input type="hidden" name="draftId" value={draft.id} />
                        <div>
                          <Label htmlFor={`reason-${draft.id}`}>{t.rejectReason}</Label>
                          <Input id={`reason-${draft.id}`} name="reason" minLength={5} required />
                        </div>
                      </ActionForm>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>

          <Card>
            <CardTitle>{t.runs}</CardTitle>
            <ul className="space-y-1 text-sm">
              {runs.map((run) => (
                <li key={run.id}>
                  {run.startedAt.toLocaleString("es-PE", { timeZone: "America/Lima" })} ·{" "}
                  {t.status[run.status]} ·{" "}
                  {run.simulated
                    ? t.simulated
                    : `${run.promptTokens + run.completionTokens} ${t.tokens} · US$ ${Number(run.costUsd).toFixed(4)}`}
                  {run.error ? (
                    <span className="block text-xs text-muted-foreground">{run.error}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </Card>
        </>
      ) : null}

      {ai ? (
        <Card>
          <CardTitle>{ts.ai}</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground" data-testid="api-key-state">
            {ts.apiKey}: {ai.apiKeyMasked ?? "no configurada"}
          </p>
          <ActionForm
            action={updateAiSettingsAction}
            submitLabel={ts.save}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div className="sm:col-span-2">
              <Label htmlFor="apiKey">{ts.apiKey}</Label>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                autoComplete="off"
                placeholder="sk-..."
              />
              <p className="mt-1 text-xs text-muted-foreground">{ts.apiKeyHelp}</p>
            </div>
            <label className="flex min-h-12 items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="clearApiKey" className="size-5" />
              {ts.clearKey}
            </label>
            <div>
              <Label htmlFor="model">{ts.model}</Label>
              <Input id="model" name="model" defaultValue={ai.model} />
            </div>
            <div>
              <Label htmlFor="mode">{ts.mode}</Label>
              <Select id="mode" name="mode" defaultValue={ai.mode}>
                <option value="DRAFT_APPROVAL">{ts.modeDraft}</option>
                <option value="AUTOMATIC">{ts.modeAuto}</option>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="tone">{ts.tone}</Label>
              <Input id="tone" name="tone" defaultValue={ai.tone ?? ""} />
            </div>
            <div>
              <Label htmlFor="monthlyTokenCap">{ts.tokenCap}</Label>
              <Input
                id="monthlyTokenCap"
                name="monthlyTokenCap"
                inputMode="numeric"
                defaultValue={ai.monthlyTokenCap ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="monthlyCostCapUsd">{ts.costCap}</Label>
              <Input
                id="monthlyCostCapUsd"
                name="monthlyCostCapUsd"
                inputMode="decimal"
                defaultValue={ai.monthlyCostCapUsd ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxOrderAmount">{ts.maxAmount}</Label>
              <Input
                id="maxOrderAmount"
                name="maxOrderAmount"
                inputMode="decimal"
                defaultValue={ai.maxOrderAmount ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxQtyPerSku">{ts.maxQty}</Label>
              <Input
                id="maxQtyPerSku"
                name="maxQtyPerSku"
                inputMode="decimal"
                defaultValue={ai.maxQtyPerSku ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="maxOrdersPerDay">{ts.maxOrders}</Label>
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
          <CardTitle>{ts.channels}</CardTitle>
          <p className="mb-3 text-xs text-muted-foreground">
            {ts.inboundUrl}: {getAppUrl()}/api/webhooks/supplier/{user.tenantId}
          </p>
          <ActionForm
            action={updateChannelsAction}
            submitLabel={ts.save}
            className="grid gap-4 sm:grid-cols-2"
          >
            <div>
              <Label htmlFor="whatsappProvider">{ts.provider}</Label>
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
              <Label htmlFor="whatsappWebhookUrl">{ts.webhookUrl}</Label>
              <Input
                id="whatsappWebhookUrl"
                name="whatsappWebhookUrl"
                defaultValue={channels.whatsappWebhookUrl ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="whatsappApiKey">
                {ts.waKey} ({channels.whatsappApiKeyMasked ?? "sin clave"})
              </Label>
              <Input id="whatsappApiKey" name="whatsappApiKey" type="password" autoComplete="off" />
            </div>
            <label className="flex min-h-12 items-center gap-2 text-sm">
              <input type="checkbox" name="rotateInboundSecret" className="size-5" />
              {ts.rotateSecret}
            </label>
            <div>
              <Label htmlFor="smtpHost">{ts.smtpHost}</Label>
              <Input id="smtpHost" name="smtpHost" defaultValue={channels.smtpHost ?? ""} />
            </div>
            <div>
              <Label htmlFor="smtpPort">{ts.smtpPort}</Label>
              <Input
                id="smtpPort"
                name="smtpPort"
                inputMode="numeric"
                defaultValue={channels.smtpPort ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="smtpUser">{ts.smtpUser}</Label>
              <Input id="smtpUser" name="smtpUser" defaultValue={channels.smtpUser ?? ""} />
            </div>
            <div>
              <Label htmlFor="smtpPassword">
                {ts.smtpPassword} ({channels.smtpPasswordMasked ?? "sin clave"})
              </Label>
              <Input id="smtpPassword" name="smtpPassword" type="password" autoComplete="off" />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="smtpFromAddress">{ts.smtpFrom}</Label>
              <Input
                id="smtpFromAddress"
                name="smtpFromAddress"
                defaultValue={channels.smtpFromAddress ?? ""}
              />
            </div>
            <input type="hidden" name="smtpSecure" value="on" />
          </ActionForm>
          <h3 className="mb-2 mt-6 font-medium">{ts.sendTest}</h3>
          <ActionForm
            action={testMessageAction}
            submitLabel={ts.sendTest}
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
              <Label htmlFor="test-to">{ts.testTo}</Label>
              <Input id="test-to" name="to" required />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
