import { approveDraftAction, rejectDraftAction, runAgentAction } from "@/app/actions/purchasing";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { VIOLATION_LABELS } from "@/lib/ai/guardrails";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { listDrafts, listRuns } from "@/server/services/ai-drafts";
import { getAiSettings } from "@/server/services/ai-settings";

export default async function AiPage({
  searchParams,
}: {
  searchParams: Promise<{ aprobada?: string; sim?: string; rechazada?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "ai_agent:ver");
  const t = es.ai;
  const notice = await searchParams;
  const [drafts, runs, settings] = await Promise.all([
    listDrafts(user),
    listRuns(user, 10),
    getAiSettings(user),
  ]);
  const canApprove = can(user, "ai_agent:autorizar_pedidos_ia") && can(user, "purchasing:crear");
  const usage = settings.usage;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
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
          {usage.tokens.toLocaleString("es-PE")} {t.tokens}
          {usage.tokenCap !== null ? ` / ${usage.tokenCap.toLocaleString("es-PE")}` : ""} · US${" "}
          {usage.costUsd.toFixed(4)}
          {usage.costCapUsd !== null ? ` / ${usage.costCapUsd.toFixed(2)}` : ""} · {settings.model}{" "}
          · {settings.mode === "AUTOMATIC" ? es.settings.modeAuto : es.settings.modeDraft}
        </p>
        {usage.exhausted ? (
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
                      <span className="block text-xs text-muted-foreground">{item.rationale}</span>
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
                  <ActionForm action={rejectDraftAction} submitLabel={t.reject} variant="outline">
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
  );
}
