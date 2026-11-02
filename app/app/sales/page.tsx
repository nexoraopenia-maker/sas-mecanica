import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDateTime } from "@/lib/workshop/format";
import { listSales } from "@/server/services/sales";

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const t = es.pos;
  const { q } = await searchParams;
  const sales = await listSales(user, { q });

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.sales}</h1>
      <form className="flex gap-2" role="search">
        <Input
          name="q"
          defaultValue={q ?? ""}
          placeholder="N.º de venta o cliente"
          aria-label="Buscar ventas"
        />
        <Button type="submit" variant="outline">
          Buscar
        </Button>
      </form>
      {sales.length === 0 ? <p className="text-muted-foreground">{t.noSales}</p> : null}
      <ul className="space-y-3">
        {sales.map((sale) => (
          <li key={sale.id}>
            <Link href={`/app/sales/${sale.id}`} className="block" data-testid="sale">
              <Card className="space-y-1 hover:bg-muted/40">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    {t.saleNumber} #{sale.number} · S/ {sale.total}
                  </p>
                  <span className="rounded-full bg-muted px-3 py-1 text-sm">
                    {sale.status === "VOIDED"
                      ? t.status.VOIDED
                      : t.paymentStatus[sale.paymentStatus]}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">
                  {formatDateTime(sale.createdAt)} · {sale.customer ?? es.pos.noCustomer} ·{" "}
                  {sale.document
                    ? `${sale.document.number} (${es.billing.status[sale.document.status]})`
                    : es.pos.saleNote}
                </p>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
