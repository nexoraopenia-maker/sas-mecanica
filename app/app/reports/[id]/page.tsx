import { notFound } from "next/navigation";
import { ZodError } from "zod";
import { PrintButton } from "@/components/print-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { defaultPeriod } from "@/lib/reports/period";
import { REPORT_IDS } from "@/lib/reports/table";
import { availableReports, reportNeedsPeriod, runReport } from "@/server/services/reports";

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; agrupar?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await requireTenantUser();
  requirePermission(user, "reports:ver");
  const reportId = REPORT_IDS.find((r) => r === id);
  if (!reportId || !availableReports(user).some((r) => r.id === reportId)) notFound();
  const t = es.reports;
  const fallback = defaultPeriod();
  const period = { from: query.from ?? fallback.from, to: query.to ?? fallback.to };
  const groupBy = query.agrupar === "month" ? "month" : "day";
  let report: Awaited<ReturnType<typeof runReport>> | null = null;
  let rangeError: string | null = null;
  try {
    report = await runReport(user, reportId, period, new Date(), groupBy);
  } catch (error) {
    // Un rango inválido se explica en pantalla; cualquier otro error sigue siendo un error real.
    if (!(error instanceof ZodError)) throw error;
    rangeError = error.issues[0]?.message ?? "Rango de fechas inválido";
  }
  const needsPeriod = reportNeedsPeriod(reportId);
  const csvQuery = new URLSearchParams({
    ...(needsPeriod ? period : {}),
    ...(reportId === "sales" ? { agrupar: groupBy } : {}),
  }).toString();

  return (
    <div className="space-y-4" data-testid="report">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">
          {report?.title ?? availableReports(user).find((r) => r.id === reportId)?.label}
        </h1>
        <div className="flex flex-wrap gap-2 print:hidden">
          <a
            className="inline-flex h-12 items-center rounded-lg border border-border px-4 text-sm"
            href={`/app/reports/${reportId}/export?${csvQuery}`}
            data-testid="report-csv"
          >
            {t.csv}
          </a>
          <PrintButton label={t.print} />
        </div>
      </div>

      {needsPeriod ? (
        <form className="grid gap-2 sm:grid-cols-5 print:hidden" role="search">
          <div>
            <Label htmlFor="from">{t.from}</Label>
            <Input id="from" name="from" type="date" defaultValue={period.from} required />
          </div>
          <div>
            <Label htmlFor="to">{t.to}</Label>
            <Input id="to" name="to" type="date" defaultValue={period.to} required />
          </div>
          {reportId === "sales" ? (
            <div>
              <Label htmlFor="agrupar">Agrupar</Label>
              <Select id="agrupar" name="agrupar" defaultValue={groupBy}>
                <option value="day">{t.byDay}</option>
                <option value="month">{t.byMonth}</option>
              </Select>
            </div>
          ) : null}
          <div className="flex items-end">
            <Button type="submit" variant="outline" className="w-full">
              {t.run}
            </Button>
          </div>
        </form>
      ) : null}
      {needsPeriod ? (
        <p className="hidden text-sm print:block">
          {period.from} → {period.to}
        </p>
      ) : null}

      {rangeError ? <Alert tone="error">{rangeError}</Alert> : null}
      {report ? (
        <>
          <Card>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="report-summary">
              {report.summary.map((item) => (
                <div key={item.label}>
                  <dt className="text-xs text-muted-foreground">{item.label}</dt>
                  <dd className="font-semibold">{item.value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          {report.rows.length === 0 ? <p className="text-muted-foreground">{t.empty}</p> : null}
          {report.rows.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted text-left">
                  <tr>
                    {report.columns.map((c) => (
                      <th
                        key={c.key}
                        className={`px-3 py-2 ${c.kind && c.kind !== "text" ? "text-right" : ""}`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.rows.map((row, index) => (
                    <tr key={index} className="border-t border-border" data-testid="report-row">
                      {report.columns.map((c) => (
                        <td
                          key={c.key}
                          className={`px-3 py-2 ${c.kind && c.kind !== "text" ? "text-right tabular-nums" : ""}`}
                        >
                          {row[c.key] === null || row[c.key] === undefined
                            ? "—"
                            : c.kind === "percent"
                              ? `${row[c.key]} %`
                              : String(row[c.key])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="text-xs text-muted-foreground">
            <p className="font-medium">{t.notes}</p>
            <ul className="list-disc pl-5">
              {report.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
