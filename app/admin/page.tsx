import { Card, CardTitle } from "@/components/ui/card";
import { requirePlatformUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { getPlatformMetrics } from "@/server/services/metrics";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold">{value}</p>
    </Card>
  );
}

export default async function PlatformPage() {
  const user = await requirePlatformUser();
  const metrics = await getPlatformMetrics(user);
  return (
    <>
      <h1 className="text-2xl font-semibold">{es.admin.metricsTitle}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat
          label={es.admin.mrr}
          value={`S/ ${Number(metrics.mrr).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`}
        />
        <Stat label={es.admin.activeAccounts} value={String(metrics.activeAccounts)} />
        <Stat label={es.admin.suspended} value={String(metrics.suspendedAccounts)} />
        <Stat label={es.admin.demos} value={String(metrics.activeDemos)} />
        <Stat label={es.admin.churn} value={`${(metrics.churn30d * 100).toFixed(1)} %`} />
      </div>
      <Card>
        <CardTitle>{es.admin.byPlan}</CardTitle>
        <ul className="space-y-1 text-sm">
          {metrics.accountsByPlan.map((row) => (
            <li key={row.plan} className="flex justify-between">
              <span>{row.plan}</span>
              <span className="font-medium">{row.count}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <CardTitle>{es.admin.aiUsage}</CardTitle>
        {metrics.aiUsage.length === 0 ? (
          <p className="text-sm text-muted-foreground">{es.admin.noAi}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {metrics.aiUsage.map((row) => (
              <li key={row.tenantId} className="flex justify-between gap-3">
                <span>{row.tenant}</span>
                <span className="font-medium">
                  {row.tokens.toLocaleString("es-PE")} tokens · US$ {Number(row.costUsd).toFixed(4)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
