import { buttonVariants } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { es } from "@/lib/i18n/es";
import type { PlanOverview } from "@/server/services/plan-overview";
import { cn } from "@/lib/utils";

/** Límites del plan con su uso, funciones incluidas y botón de WhatsApp (activar o cambiar de plan). */
export function PlanLimits({
  overview,
  whatsapp,
  isDemo,
}: {
  overview: PlanOverview;
  whatsapp: string | null;
  isDemo: boolean;
}) {
  return (
    <Card className="space-y-4" data-testid="plan-limits">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="mb-0">Límites y funciones del plan {overview.name}</CardTitle>
        {whatsapp ? (
          <a
            href={whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className={buttonVariants({ size: "sm" })}
            data-testid="plan-whatsapp"
          >
            {isDemo ? es.banner.activatePlan : es.settingsPage.changePlan}
          </a>
        ) : null}
      </div>
      <ul className="grid gap-3 sm:grid-cols-3">
        {overview.limits.map((limit) => {
          const reached = limit.max !== null && limit.used >= limit.max;
          return (
            <li key={limit.id} data-testid={`limit-${limit.id}`}>
              <p className="text-sm text-muted-foreground">{limit.label}</p>
              <p className={cn("text-lg font-semibold", reached ? "text-warning" : "")}>
                {limit.used} / {limit.max ?? "ilimitado"}
              </p>
              {reached ? (
                <p className="text-xs text-warning">{es.settingsPage.limitReached}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ul className="grid gap-1 text-sm sm:grid-cols-2">
        {overview.features.map((feature) => (
          <li
            key={feature.label}
            className={feature.included ? "text-foreground" : "text-muted-foreground"}
          >
            {feature.included ? "✓" : "—"} {feature.label}
          </li>
        ))}
      </ul>
      {!whatsapp ? (
        <p className="text-sm text-muted-foreground">{es.settingsPage.contactSupport}</p>
      ) : null}
    </Card>
  );
}
