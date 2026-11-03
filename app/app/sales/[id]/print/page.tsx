import { PrintButton } from "@/components/print-button";
import { requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { METHOD_LABEL } from "@/lib/pos/cash";
import { amountInWords, DEMO_RUC, qrString } from "@/lib/billing/sunat";
import { formatDateTime } from "@/lib/workshop/format";
import { withTenant } from "@/lib/db";
import { logoUrlOf } from "@/server/services/branding";
import { getSale } from "@/server/services/sales";

/** Comprobante imprimible: ticket térmico de 80 mm o A4. El navegador genera el PDF desde «Imprimir». */
export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ formato?: string }>;
}) {
  const { id } = await params;
  const { formato } = await searchParams;
  const user = await requireTenantUser();
  requirePermission(user, "pos:ver");
  const sale = await getSale(user, id);
  const ticket = formato !== "a4";
  const tenantId = user.tenantId ?? "";
  const { issuer, logoUrl } = await withTenant(tenantId, async (tx) => ({
    issuer: await tx.tenant.findFirstOrThrow({
      select: { legalName: true, tradeName: true, taxId: true, address: true, isDemo: true },
    }),
    logoUrl: await logoUrlOf(tx, tenantId),
  }));
  const ruc = issuer.taxId ?? (issuer.isDemo ? DEMO_RUC : null);
  const doc = sale.documents.find((d) => d.type === "BOLETA" || d.type === "FACTURA");
  const t = es.pos;
  const qr =
    doc && ruc
      ? qrString({
          issuerRuc: ruc,
          type: doc.type as "BOLETA" | "FACTURA",
          series: doc.number.split("-")[0] ?? "",
          correlative: Number(doc.number.split("-")[1] ?? 0),
          tax: sale.taxTotal,
          total: sale.total,
          issueDate: sale.createdAt,
          buyer: sale.customer?.docNumber
            ? {
                docType: sale.customer.docType,
                docNumber: sale.customer.docNumber,
                name: sale.customer.name,
              }
            : null,
        })
      : null;

  return (
    <div
      className={
        ticket
          ? "mx-auto w-[80mm] bg-paper p-2 text-[11px] leading-tight text-ink print:p-0"
          : "mx-auto max-w-[210mm] bg-paper p-8 text-sm text-ink print:p-0"
      }
      data-testid="print-sheet"
    >
      <PrintButton label={t.print} />
      <header className="text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logoUrl}
            alt={issuer.tradeName ?? issuer.legalName}
            className="mx-auto mb-1 max-h-16 w-auto max-w-full"
            data-testid="print-logo"
          />
        ) : null}
        <p className="text-base font-bold">{issuer.tradeName ?? issuer.legalName}</p>
        <p>{issuer.legalName}</p>
        {ruc ? (
          <p>
            RUC {ruc}
            {issuer.isDemo ? " (DEMO)" : ""}
          </p>
        ) : null}
        {issuer.address ? <p>{issuer.address}</p> : null}
        <p className="mt-1 font-semibold">
          {doc
            ? `${es.billing.type[doc.type]} electrónica ${doc.number}`
            : `${t.saleNote} N.º ${sale.number}`}
        </p>
        {doc && doc.status !== "ACCEPTED" ? (
          <p className="text-[10px]">Estado SUNAT: {es.billing.status[doc.status]}</p>
        ) : null}
        {sale.status === "VOIDED" ? <p className="font-bold">ANULADA</p> : null}
      </header>
      <p className="mt-2">Fecha: {formatDateTime(sale.createdAt)}</p>
      <p>
        Cliente: {sale.customer?.name ?? t.noCustomer}{" "}
        {sale.customer?.docNumber ? `(${sale.customer.docType} ${sale.customer.docNumber})` : ""}
      </p>
      {sale.vehicle ? <p>Placa: {sale.vehicle.plate}</p> : null}
      <table className="mt-2 w-full border-t border-ink">
        <thead>
          <tr className="text-left">
            <th>Cant.</th>
            <th>Descripción</th>
            <th className="text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {sale.items.map((item) => (
            <tr key={item.id} className="align-top">
              <td>{item.quantity}</td>
              <td>
                {item.description}
                {item.serial ? ` (serie ${item.serial})` : ""}
                {item.dotCode ? ` (DOT ${item.dotCode})` : ""}
              </td>
              <td className="text-right">{item.lineTotal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="mt-2 grid grid-cols-2 border-t border-ink pt-1">
        <dt>Op. gravada</dt>
        <dd className="text-right">S/ {sale.subtotal}</dd>
        <dt>{t.tax}</dt>
        <dd className="text-right">S/ {sale.taxTotal}</dd>
        <dt className="font-bold">{t.total}</dt>
        <dd className="text-right font-bold">S/ {sale.total}</dd>
      </dl>
      <p className="mt-1">{amountInWords(sale.total)}</p>
      <p className="mt-1">
        {sale.payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => `${METHOD_LABEL[p.method]} S/ ${p.amount}`)
          .join(" · ")}
      </p>
      {sale.receivable ? <p>Saldo a crédito: S/ {sale.receivable.balance}</p> : null}
      {qr ? <p className="mt-2 break-all text-[9px]">Datos QR: {qr}</p> : null}
      <p className="mt-2 text-center">¡Gracias por su compra!</p>
    </div>
  );
}
