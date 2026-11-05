import Link from "next/link";
import { DispatchGuideForm } from "@/components/dispatch/dispatch-guide-form";
import { Alert } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import {
  draftFromSale,
  draftFromTransfer,
  listGuideSources,
  type GuideDraft,
} from "@/server/services/dispatch-guides";
import { z } from "zod";

export default async function NewGuidePage({
  searchParams,
}: {
  searchParams: Promise<{ saleId?: string; transferId?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "billing:crear");
  const params = await searchParams;
  const g = es.gre;
  const sources = await listGuideSources(user);

  let draft: GuideDraft | null = null;
  let draftError: string | null = null;
  try {
    const saleId = z.uuid().safeParse(params.saleId);
    const transferId = z.uuid().safeParse(params.transferId);
    if (saleId.success) draft = await draftFromSale(user, saleId.data);
    else if (transferId.success) draft = await draftFromTransfer(user, transferId.data);
  } catch {
    draftError = "No se encontró la venta o la transferencia elegida.";
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" });

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{g.new}</h1>
        <Link href="/app/guias" className={buttonVariants({ variant: "ghost" })}>
          {g.back}
        </Link>
      </div>
      {draftError ? <Alert tone="error">{draftError}</Alert> : null}

      <Card>
        <form className="grid gap-3 sm:grid-cols-3" role="search" aria-label={g.loadFrom}>
          <div>
            <Label htmlFor="saleId">{g.loadSale}</Label>
            <Select id="saleId" name="saleId" defaultValue={params.saleId ?? ""}>
              <option value="">{g.none}</option>
              {sources.sales.map((sale) => (
                <option key={sale.id} value={sale.id}>
                  {sale.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="transferId">{g.loadTransfer}</Label>
            <Select id="transferId" name="transferId" defaultValue={params.transferId ?? ""}>
              <option value="">{g.none}</option>
              {sources.transfers.map((transfer) => (
                <option key={transfer.id} value={transfer.id}>
                  {transfer.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex items-end">
            <Button type="submit" variant="outline" className="w-full">
              {g.loadSubmit}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        {/* La clave fuerza un formulario nuevo al cambiar el origen precargado. */}
        <DispatchGuideForm
          key={draft?.saleId ?? draft?.transferId ?? "manual"}
          draft={draft}
          today={today}
        />
      </Card>
    </>
  );
}
