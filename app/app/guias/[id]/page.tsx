import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { voidDispatchGuideAction } from "@/app/actions/dispatch";
import { PrintButton } from "@/components/catalog/print-button";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { DISPATCH_MODE_LABEL, DISPATCH_REASON_LABEL } from "@/lib/dispatch/sunat";
import { es } from "@/lib/i18n/es";
import { getDispatchGuide } from "@/server/services/dispatch-guides";
import { NotFoundError } from "@/lib/errors";

const dateFormat = new Intl.DateTimeFormat("es-PE", {
  dateStyle: "long",
  timeZone: "America/Lima",
});

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[12rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default async function GuideDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireTenantUser();
  requirePermission(user, "billing:ver");
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  let guide;
  try {
    guide = await getDispatchGuide(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const g = es.gre;
  const isPublic = guide.transportMode === "PUBLIC";
  return (
    <>
      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .gre-print, .gre-print * { visibility: visible !important; }
          .gre-print { position: absolute; left: 0; top: 0; width: 100%; background: var(--paper) !important; color: var(--ink) !important; border: 0 !important; }
        }
      `}</style>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {g.title} · {guide.number}
        </h1>
        <div className="flex gap-2">
          <PrintButton label={g.printable} />
          <Link href="/app/guias" className={buttonVariants({ variant: "ghost" })}>
            {g.back}
          </Link>
        </div>
      </div>

      {guide.status === "PENDING" ? <Alert tone="warning">{g.pendingHint}</Alert> : null}
      {guide.status === "ACCEPTED" && guide.providerRef?.startsWith("SIM-") ? (
        <Alert>{g.simulatedHint}</Alert>
      ) : null}
      {guide.status === "REJECTED" ? <Alert tone="error">{guide.errorMessage}</Alert> : null}
      {guide.status === "VOIDED" ? (
        <Alert tone="error">
          {g.voidedOn}
          {guide.voidedAt ? ` el ${dateFormat.format(guide.voidedAt)}` : ""}: {guide.voidReason}
        </Alert>
      ) : null}

      <Card className="gre-print space-y-4" data-testid="gre-detail">
        <dl className="space-y-2">
          <Row label={g.sender}>
            {guide.issuer.name} · RUC {guide.issuer.ruc ?? "—"}
          </Row>
          <Row label={g.issueDate}>{dateFormat.format(guide.issueDate)}</Row>
          <Row label={g.transferDate}>{dateFormat.format(guide.transferDate)}</Row>
          <Row label={g.reason}>
            {DISPATCH_REASON_LABEL[guide.reason]}
            {guide.reasonNote ? ` — ${guide.reasonNote}` : ""}
          </Row>
          {guide.relatedDocument ? (
            <Row label={g.relatedDocument}>{guide.relatedDocument}</Row>
          ) : null}
          <Row label={g.recipient}>
            {guide.recipientName} · {guide.recipientDocType} {guide.recipientDocNumber}
          </Row>
          <Row label={g.origin}>
            {guide.originAddress} (UBIGEO {guide.originUbigeo})
          </Row>
          <Row label={g.destination}>
            {guide.destinationAddress} (UBIGEO {guide.destinationUbigeo})
          </Row>
          <Row label={g.mode}>{DISPATCH_MODE_LABEL[guide.transportMode]}</Row>
          {isPublic ? (
            <Row label={g.carrier}>
              {guide.carrierName} · RUC {guide.carrierDocNumber}
            </Row>
          ) : (
            <Row label={g.driver}>
              {guide.driverName} · DNI {guide.driverDocNumber}
              {guide.driverLicense ? ` · Licencia ${guide.driverLicense}` : ""}
            </Row>
          )}
          {guide.vehiclePlate ? <Row label={g.vehicle}>{guide.vehiclePlate}</Row> : null}
          <Row label={g.grossWeight}>
            {Number(guide.grossWeightKg).toFixed(3)} kg
            {guide.packages ? ` · ${guide.packages} bultos` : ""}
          </Row>
        </dl>
        <table className="w-full text-sm">
          <caption className="mb-1 text-left font-medium">{g.items}</caption>
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">{g.itemSku}</th>
              <th className="p-2">{g.itemDescription}</th>
              <th className="p-2">{g.itemUnit}</th>
              <th className="p-2 text-right">{g.itemQty}</th>
            </tr>
          </thead>
          <tbody>
            {guide.items.map((item) => (
              <tr key={item.id} className="border-t border-border">
                <td className="p-2">{item.sku ?? "—"}</td>
                <td className="p-2">{item.description}</td>
                <td className="p-2">{item.unit}</td>
                <td className="p-2 text-right">{Number(item.quantity).toString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {guide.status !== "VOIDED" && can(user, "billing:editar") ? (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">{g.void}</h2>
          <ActionForm action={voidDispatchGuideAction} submitLabel={g.voidSubmit} variant="outline">
            <input type="hidden" name="guideId" value={guide.id} />
            <div>
              <Label htmlFor="reason">{g.voidReason}</Label>
              <Input id="reason" name="reason" required minLength={5} maxLength={300} />
            </div>
          </ActionForm>
        </Card>
      ) : null}
    </>
  );
}
