import Link from "next/link";
import { Card, CardTitle } from "@/components/ui/card";
import { can } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDate } from "@/lib/workshop/format";
import { getDashboard } from "@/server/services/dashboard";

function Stat({
  label,
  value,
  tone,
  testId,
}: {
  label: string;
  value: string | number;
  tone?: "danger" | "warning";
  testId?: string;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`text-2xl font-semibold ${tone === "danger" ? "text-destructive" : tone === "warning" ? "text-amber-600" : ""}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}

export default async function DashboardPage() {
  const user = await requireTenantUser();
  const t = es.dash;
  const data = await getDashboard(user);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {es.dashboard.greeting}, {user.name}
        </h1>
        {can(user, "reports:ver") ? (
          <Link href="/app/reports" className="text-sm underline">
            {t.reports}
          </Link>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {data.stock ? (
          <Card
            data-testid="dash-stock"
            className={data.stock.critical > 0 ? "border-destructive/60" : ""}
          >
            <CardTitle>{t.stock}</CardTitle>
            <dl className="grid grid-cols-2 gap-3">
              <Stat
                label={t.critical}
                value={data.stock.critical}
                tone={data.stock.critical > 0 ? "danger" : undefined}
                testId="dash-critical"
              />
              <Stat
                label={t.reorder}
                value={data.stock.reorder}
                tone={data.stock.reorder > 0 ? "warning" : undefined}
              />
            </dl>
            {data.stock.criticalItems.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">{t.noCritical}</p>
            ) : null}
            <ul className="mt-3 space-y-1 text-sm">
              {data.stock.criticalItems.map((item) => (
                <li key={`${item.productId}-${item.warehouse}`} className="text-destructive">
                  {item.name} · {item.quantity} / mín. {item.minStock}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {data.sales ? (
          <Card data-testid="dash-sales">
            <CardTitle>{t.sales}</CardTitle>
            <dl className="grid grid-cols-3 gap-3">
              <Stat
                label={`${t.today} (${data.sales.todayCount} ${t.salesCount})`}
                value={`S/ ${data.sales.todayTotal}`}
                testId="dash-sales-today"
              />
              <Stat label={t.yesterday} value={`S/ ${data.sales.yesterdayTotal}`} />
              <Stat label={t.month} value={`S/ ${data.sales.monthTotal}`} />
            </dl>
            {data.receivables && data.receivables.overdueCount > 0 ? (
              <p className="mt-3 text-sm text-destructive">
                {t.receivables}: {data.receivables.overdueCount} · S/{" "}
                {data.receivables.overdueTotal} ·{" "}
                <Link className="underline" href="/app/receivables">
                  {es.receivables.title}
                </Link>
              </p>
            ) : null}
          </Card>
        ) : null}

        {data.workshop ? (
          <Card data-testid="dash-workshop">
            <CardTitle>{t.workshop}</CardTitle>
            <dl className="grid grid-cols-2 gap-3">
              <Stat label={t.active} value={data.workshop.active} testId="dash-active-ot" />
              <Stat
                label={t.overdue}
                value={data.workshop.overdue}
                tone={data.workshop.overdue > 0 ? "danger" : undefined}
              />
            </dl>
            <ul className="mt-3 space-y-1 text-sm">
              {data.workshop.byStatus.map((row) => (
                <li key={row.status}>
                  {es.workshop.status[row.status as keyof typeof es.workshop.status]}: {row.count}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {data.warranties ? (
          <Card data-testid="dash-warranties">
            <CardTitle>{t.warranties}</CardTitle>
            <p className="text-2xl font-semibold">{data.warranties.expiring30}</p>
            {data.warranties.next.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{t.none}</p>
            ) : null}
            <ul className="mt-2 space-y-1 text-sm">
              {data.warranties.next.map((w) => (
                <li key={w.id}>
                  {w.description} {w.plate ? `· ${w.plate}` : ""} · {formatDate(w.expiresAt)}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        {data.ai ? (
          <Card data-testid="dash-ai" className="md:col-span-2">
            <CardTitle>
              {t.ai} · {data.ai.monthLabel}
            </CardTitle>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label={t.aiSavings} value={`S/ ${data.ai.savingsLocal}`} />
              <Stat label={t.aiCost} value={`S/ ${data.ai.costLocal}`} />
              <Stat label={t.aiNet} value={`S/ ${data.ai.netLocal}`} testId="dash-ai-net" />
              <Stat label="Pedidos de la IA" value={data.ai.ordersCreated} />
            </dl>
          </Card>
        ) : null}
      </div>

      <Card>
        <CardTitle>{user.tenantName}</CardTitle>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">{es.dashboard.role}</dt>
            <dd className="font-medium">{user.roleName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{es.dashboard.permissions}</dt>
            <dd className="font-medium" data-testid="permission-count">
              {user.permissions.size}
            </dd>
          </div>
        </dl>
      </Card>
    </>
  );
}
