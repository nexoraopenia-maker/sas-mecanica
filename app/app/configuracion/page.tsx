import Link from "next/link";
import { notFound } from "next/navigation";
import { AiTab } from "@/components/settings/ai-tab";
import { BillingTab } from "@/components/settings/billing-tab";
import { BranchesTab } from "@/components/settings/branches-tab";
import { CompanyTab } from "@/components/settings/company-tab";
import { PlanTab } from "@/components/settings/plan-tab";
import { RolesTab } from "@/components/settings/roles-tab";
import { UsersTab } from "@/components/settings/users-tab";
import { can, type AuthUser } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "usuarios", allowed: (u: AuthUser) => can(u, "users:ver") },
  { id: "sucursales", allowed: (u: AuthUser) => can(u, "branches:ver") },
  { id: "roles", allowed: (u: AuthUser) => can(u, "users:ver") },
  { id: "taller", allowed: (u: AuthUser) => can(u, "settings:ver") },
  { id: "facturacion", allowed: (u: AuthUser) => can(u, "billing:ver") },
  { id: "ia", allowed: (u: AuthUser) => can(u, "ai_agent:ver") || can(u, "settings:ver") },
  { id: "plan", allowed: (u: AuthUser) => can(u, "settings:ver") },
] as const;

type Params = {
  tab?: string;
  pago?: string;
  simulado?: string;
  aprobada?: string;
  sim?: string;
  rechazada?: string;
};

/**
 * Configuración del negocio con seis pestañas. Cada pestaña solo aparece si el rol la puede ver y
 * cada servicio vuelve a exigir el permiso en el servidor (esconder un botón nunca es la defensa).
 */
export default async function ConfigurationPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const user = await requireTenantUser();
  const params = await searchParams;
  const visible = TABS.filter((tab) => tab.allowed(user));
  if (visible.length === 0) notFound();
  const current = visible.find((tab) => tab.id === params.tab) ?? visible[0];
  if (!current) notFound();

  return (
    <>
      <h1 className="text-2xl font-semibold">{es.settingsPage.title}</h1>
      <nav aria-label="Secciones de configuración" className="flex flex-wrap gap-2">
        {visible.map((tab) => {
          const active = tab.id === current.id;
          return (
            <Link
              key={tab.id}
              href={`/app/configuracion?tab=${tab.id}`}
              aria-current={active ? "page" : undefined}
              data-testid={`settings-tab-${tab.id}`}
              className={cn(
                "inline-flex min-h-10 items-center rounded-full border px-4 text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "border-primary bg-primary/15 text-foreground"
                  : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {es.settingsPage.tabs[tab.id]}
            </Link>
          );
        })}
      </nav>
      {current.id === "usuarios" ? <UsersTab user={user} /> : null}
      {current.id === "sucursales" ? <BranchesTab user={user} /> : null}
      {current.id === "roles" ? <RolesTab user={user} /> : null}
      {current.id === "taller" ? <CompanyTab user={user} /> : null}
      {current.id === "facturacion" ? <BillingTab user={user} /> : null}
      {current.id === "ia" ? <AiTab user={user} notice={params} /> : null}
      {current.id === "plan" ? <PlanTab user={user} notice={params} /> : null}
    </>
  );
}
