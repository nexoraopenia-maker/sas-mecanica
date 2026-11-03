import Link from "next/link";
import { endImpersonationAction } from "@/app/actions/admin";
import { restoreDemoAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Button, buttonVariants } from "@/components/ui/button";
import type { AuthUser } from "@/lib/auth/can";
import { getEnv } from "@/lib/env";
import { es } from "@/lib/i18n/es";
import { salesWhatsappUrl } from "@/lib/sales-whatsapp";

const strip = "border-b px-4 py-3 text-sm backdrop-blur-[14px] print:hidden";
const inner = "mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3";

/** Banners permanentes: modo soporte (impersonación), cobro pendiente y cuenta demo. No se pueden ocultar. */
export function Banners({ user }: { user: AuthUser }) {
  const whatsapp = salesWhatsappUrl(
    getEnv().NEXT_PUBLIC_SALES_WHATSAPP,
    user.tenantName ?? es.app.name,
  );
  return (
    <>
      {user.impersonation ? (
        <div
          role="alert"
          className={`${strip} border-danger/40 bg-danger/10 text-danger`}
          data-testid="support-banner"
        >
          <div className={inner}>
            <p>
              <strong>{es.banner.support}</strong> · {user.tenantName} · {es.banner.supportReason}:{" "}
              {user.impersonation.reason}. {es.banner.supportNote}
            </p>
            <form action={endImpersonationAction}>
              <Button type="submit" size="sm" variant="outline">
                {es.banner.supportEnd}
              </Button>
            </form>
          </div>
        </div>
      ) : null}
      {!user.isDemo &&
      (user.subscription?.status === "GRACE" || user.subscription?.status === "PAST_DUE") ? (
        <div
          role="alert"
          className={`${strip} border-danger/40 bg-danger/10 text-danger`}
          data-testid="billing-banner"
        >
          <div className={inner}>
            <p>
              <strong>
                {user.subscription.status === "GRACE"
                  ? es.banner.billingGrace
                  : es.banner.billingPastDue}
              </strong>
              {user.subscription.graceEndsAt
                ? ` ${es.banner.billingUntil} ${user.subscription.graceEndsAt.toLocaleDateString("es-PE", { timeZone: "America/Lima" })}.`
                : ""}
            </p>
            <Link
              href="/app/configuracion?tab=plan"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              {es.banner.billingPay}
            </Link>
          </div>
        </div>
      ) : null}
      {user.isDemo && !user.impersonation ? (
        <div
          className={`${strip} border-primary/40 bg-primary/10 text-foreground`}
          data-testid="demo-banner"
        >
          <div className={inner}>
            <p>
              {es.banner.demo}
              {user.demoExpiresAt
                ? ` ${es.banner.demoExpires}: ${user.demoExpiresAt.toLocaleString("es-PE", { timeZone: "America/Lima" })}.`
                : ""}
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {whatsapp ? (
                <a
                  href={whatsapp}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ size: "sm" })}
                  data-testid="demo-activate"
                >
                  {es.banner.activatePlan}
                </a>
              ) : (
                <Link
                  href="/app/configuracion?tab=plan"
                  className={buttonVariants({ size: "sm" })}
                  data-testid="demo-activate"
                >
                  {es.banner.activatePlan}
                </Link>
              )}
              <ActionForm
                action={restoreDemoAction}
                submitLabel={es.banner.restore}
                variant="outline"
                size="sm"
                className="shrink-0"
              />
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
