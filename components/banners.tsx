import Link from "next/link";
import { endImpersonationAction } from "@/app/actions/admin";
import { restoreDemoAction } from "@/app/actions/auth";
import { ActionForm } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import type { AuthUser } from "@/lib/auth/can";
import { es } from "@/lib/i18n/es";

/** Banners permanentes: modo soporte (impersonación) y cuenta demo. No se pueden ocultar. */
export function Banners({ user }: { user: AuthUser }) {
  return (
    <>
      {user.impersonation ? (
        <div
          role="alert"
          className="bg-destructive px-4 py-3 text-sm text-white print:hidden"
          data-testid="support-banner"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <p>
              <strong>{es.banner.support}</strong> · {user.tenantName} · {es.banner.supportReason}:{" "}
              {user.impersonation.reason}. {es.banner.supportNote}
            </p>
            <form action={endImpersonationAction}>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                className="border-white bg-transparent text-white hover:bg-white/20"
              >
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
          className="bg-destructive px-4 py-3 text-sm text-white print:hidden"
          data-testid="billing-banner"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
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
              href="/app/subscription"
              className="rounded-lg border border-white px-4 py-2 font-medium"
            >
              {es.banner.billingPay}
            </Link>
          </div>
        </div>
      ) : null}
      {user.isDemo && !user.impersonation ? (
        <div
          className="bg-primary px-4 py-3 text-sm text-primary-foreground print:hidden"
          data-testid="demo-banner"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
            <p>
              {es.banner.demo}
              {user.demoExpiresAt
                ? ` ${es.banner.demoExpires}: ${user.demoExpiresAt.toLocaleString("es-PE", { timeZone: "America/Lima" })}.`
                : ""}
            </p>
            <ActionForm
              action={restoreDemoAction}
              submitLabel={es.banner.restore}
              variant="outline"
              size="sm"
              className="shrink-0"
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
