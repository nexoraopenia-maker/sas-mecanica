import Link from "next/link";
import { Plus } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { DISPATCH_REASON_LABEL } from "@/lib/dispatch/sunat";
import { es } from "@/lib/i18n/es";
import { cn } from "@/lib/utils";
import { listDispatchGuides } from "@/server/services/dispatch-guides";

const TONE = {
  ACCEPTED: "bg-success/15 text-success",
  PENDING: "bg-warning/15 text-warning",
  REJECTED: "bg-danger/15 text-danger",
  VOIDED: "bg-muted text-muted-foreground",
} as const;

const dateFormat = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "short",
  timeZone: "America/Lima",
});

export default async function GuidesPage() {
  const user = await requireTenantUser();
  requirePermission(user, "billing:ver");
  const guides = await listDispatchGuides(user);
  const g = es.gre;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{g.title}</h1>
          <p className="text-sm text-muted-foreground">{g.subtitle}</p>
        </div>
        {can(user, "billing:crear") ? (
          <Link href="/app/guias/nueva" className={buttonVariants()}>
            <Plus className="size-4" aria-hidden /> {g.new}
          </Link>
        ) : null}
      </div>
      {guides.length === 0 ? (
        <Card className="text-center text-muted-foreground" data-testid="gre-empty">
          {g.empty}
        </Card>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[40rem] text-sm" data-testid="gre-list">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">{g.number}</th>
                <th className="p-3">{g.issueDate}</th>
                <th className="p-3">{g.transferDate}</th>
                <th className="p-3">{g.reason}</th>
                <th className="p-3">{g.recipient}</th>
                <th className="p-3 text-right">{g.weight}</th>
                <th className="p-3">{g.status}</th>
              </tr>
            </thead>
            <tbody>
              {guides.map((guide) => (
                <tr key={guide.id} className="border-t border-border">
                  <td className="p-3 font-medium">
                    <Link
                      href={`/app/guias/${guide.id}`}
                      className="underline-offset-4 hover:underline"
                    >
                      {guide.number}
                    </Link>
                  </td>
                  <td className="p-3">{dateFormat.format(guide.issueDate)}</td>
                  <td className="p-3">{dateFormat.format(guide.transferDate)}</td>
                  <td className="p-3">
                    {DISPATCH_REASON_LABEL[guide.reason as keyof typeof DISPATCH_REASON_LABEL]}
                  </td>
                  <td className="p-3">{guide.recipientName}</td>
                  <td className="p-3 text-right">{Number(guide.grossWeightKg).toFixed(2)}</td>
                  <td className="p-3">
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        TONE[guide.status],
                      )}
                    >
                      {g.statuses[guide.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
