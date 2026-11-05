import Link from "next/link";
import { ImportWizard } from "@/components/catalog/import-wizard";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { listWarehouses } from "@/server/services/stock-queries";

export default async function CatalogImportPage() {
  const user = await requireTenantUser();
  requirePermission(user, "catalog:crear");
  requirePermission(user, "inventory:crear");
  const warehouses = await listWarehouses(user);
  const t = es.catalogImport;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <Link href="/app/catalog" className={buttonVariants({ variant: "ghost" })}>
          {es.labels.back}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t.subtitle}</p>
      {warehouses.length === 0 ? (
        <Alert tone="error">{t.noWarehouse}</Alert>
      ) : (
        <ImportWizard warehouses={warehouses.map(({ id, name }) => ({ id, name }))} />
      )}
    </>
  );
}
