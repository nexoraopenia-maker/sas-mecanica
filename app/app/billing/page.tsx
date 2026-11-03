import { resendDocumentAction, retryDocumentAction } from "@/app/actions/sales";
import Link from "next/link";
import { ActionForm } from "@/components/forms/action-form";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { can, requirePermission } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { formatDateTime } from "@/lib/workshop/format";
import { getInvoiceSettings, listDocuments } from "@/server/services/billing";

const STATUSES = ["PENDING", "ACCEPTED", "REJECTED", "VOIDED"] as const;

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ estado?: string }>;
}) {
  const user = await requireTenantUser();
  requirePermission(user, "billing:ver");
  const t = es.billing;
  const { estado } = await searchParams;
  const status = STATUSES.find((s) => s === estado);
  const [documents, settings] = await Promise.all([
    listDocuments(user, status ? { status } : {}),
    getInvoiceSettings(user),
  ]);
  const canEdit = can(user, "billing:editar");

  return (
    <>
      <h1 className="text-2xl font-semibold">{t.title}</h1>
      {settings.provider === "NONE" ? <Alert>{t.noProviderWarning}</Alert> : null}

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Estado">
        <a className="rounded-full bg-muted px-3 py-2" href="/app/billing">
          {es.workshop.all}
        </a>
        {STATUSES.map((s) => (
          <a key={s} className="rounded-full bg-muted px-3 py-2" href={`/app/billing?estado=${s}`}>
            {t.status[s]}
          </a>
        ))}
      </nav>

      <h2 className="text-xl font-semibold">{t.documents}</h2>
      {documents.length === 0 ? <p className="text-muted-foreground">{t.none}</p> : null}
      <ul className="space-y-3">
        {documents.map((doc) => (
          <li key={doc.id}>
            <Card className="space-y-2" data-testid="billing-document">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-medium">
                  {t.type[doc.type]} {doc.number} · S/ {doc.total}
                </p>
                <span className="rounded-full bg-muted px-3 py-1 text-sm">
                  {t.status[doc.status]}
                </span>
              </div>
              <p className="text-sm text-muted-foreground">
                {formatDateTime(doc.issueDate)} {doc.saleNumber ? `· Venta #${doc.saleNumber}` : ""}{" "}
                {doc.attempts > 0 ? `· ${doc.attempts} ${t.attempts}` : ""}
                {doc.noteReason ? ` · ${doc.noteReason}` : ""}
              </p>
              {doc.errorMessage ? <Alert tone="error">{doc.errorMessage}</Alert> : null}
              <div className="flex flex-wrap gap-2">
                {canEdit && (doc.status === "PENDING" || doc.status === "REJECTED") ? (
                  <ActionForm
                    action={retryDocumentAction}
                    submitLabel={t.retry}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="documentId" value={doc.id} />
                  </ActionForm>
                ) : null}
                {can(user, "billing:crear") && doc.status === "ACCEPTED" ? (
                  <ActionForm
                    action={resendDocumentAction}
                    submitLabel={t.resend}
                    size="sm"
                    variant="outline"
                    className="inline"
                  >
                    <input type="hidden" name="documentId" value={doc.id} />
                  </ActionForm>
                ) : null}
              </div>
            </Card>
          </li>
        ))}
      </ul>

      {canEdit ? (
        <p className="text-sm text-muted-foreground">
          {t.settingsMoved}{" "}
          <Link className="text-primary underline" href="/app/configuracion?tab=facturacion">
            {t.settingsLink}
          </Link>
        </p>
      ) : null}
    </>
  );
}
