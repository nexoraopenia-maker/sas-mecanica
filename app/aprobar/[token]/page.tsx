import { decideByTokenAction } from "@/app/actions/workshop";
import { ApprovalForm } from "@/components/forms/approval-form";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { DomainError } from "@/lib/errors";
import { getRequestMeta } from "@/lib/http";
import { es } from "@/lib/i18n/es";
import { formatDate, formatMoney } from "@/lib/workshop/format";
import { getApprovalView } from "@/server/services/work-order-approval";

export const metadata = {
  title: "Aprobación de presupuesto",
  robots: { index: false, follow: false },
};

/** Página pública (sin sesión): el cliente aprueba o rechaza el presupuesto desde el enlace de WhatsApp. */
export default async function ApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = es.approvalPage;
  let view: Awaited<ReturnType<typeof getApprovalView>> | null = null;
  try {
    view = await getApprovalView(token, (await getRequestMeta()).ip);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
  }

  return (
    <main className="mx-auto w-full max-w-xl space-y-4 px-4 py-8">
      {view === null ? (
        <Alert tone="error">{t.expired}</Alert>
      ) : (
        <>
          <header>
            <h1 className="text-2xl font-semibold">{view.company}</h1>
            <p className="text-sm text-muted-foreground">
              {t.title} · OT #{view.number}
            </p>
          </header>
          <Card className="space-y-1">
            <p>
              {t.vehicle}: <strong>{view.plate}</strong> {view.vehicle}
            </p>
            {view.diagnosis ? (
              <p>
                {t.diagnosis}: {view.diagnosis}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">Vence el {formatDate(view.expiresAt)}</p>
          </Card>
          <p className="text-sm">{t.intro}</p>
          <ApprovalForm
            action={decideByTokenAction}
            token={token}
            taxRate={Number(view.taxRate)}
            items={view.items.map((item) => ({
              ...item,
              unitPriceLabel: formatMoney(item.unitPrice),
            }))}
            labels={{
              include: t.include,
              yourName: t.yourName,
              approve: t.approveSelected,
              reject: t.rejectAll,
              total: t.totalWithTax,
            }}
          />
        </>
      )}
    </main>
  );
}
