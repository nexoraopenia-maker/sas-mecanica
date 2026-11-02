import Link from "next/link";
import { Card } from "@/components/ui/card";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { availableReports } from "@/server/services/reports";

export default async function ReportsPage() {
  const user = await requireTenantUser();
  requirePermission(user, "reports:ver");
  const reports = availableReports(user);
  return (
    <>
      <h1 className="text-2xl font-semibold">{es.reports.title}</h1>
      {reports.length === 0 ? <p className="text-muted-foreground">{es.reports.noAccess}</p> : null}
      <ul className="grid gap-3 sm:grid-cols-2">
        {reports.map((report) => (
          <li key={report.id}>
            <Link href={`/app/reports/${report.id}`} className="block" data-testid="report-link">
              <Card className="hover:bg-muted/40">{report.label}</Card>
            </Link>
          </li>
        ))}
      </ul>
      <Link href="/app/reports/ple" className="block" data-testid="ple-link">
        <Card className="hover:bg-muted/40">{es.ple.link}</Card>
      </Link>
    </>
  );
}
