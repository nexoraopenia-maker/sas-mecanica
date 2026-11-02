import { Banners } from "@/components/banners";
import { Header } from "@/components/nav";
import { can } from "@/lib/auth/can";
import { requireTenantUser } from "@/lib/auth/guards";
import { es } from "@/lib/i18n/es";

export default async function TenantLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const user = await requireTenantUser();
  const links = [
    { href: "/app", label: es.nav.dashboard },
    ...(can(user, "pos:crear") ? [{ href: "/app/pos", label: es.nav.pos }] : []),
    ...(can(user, "pos:ver") ? [{ href: "/app/sales", label: es.pos.sales }] : []),
    ...(can(user, "cash:ver") ? [{ href: "/app/cash", label: es.nav.cash }] : []),
    ...(can(user, "pos:ver") ? [{ href: "/app/quotes", label: es.nav.quotes }] : []),
    ...(can(user, "pos:ver") ? [{ href: "/app/receivables", label: es.nav.receivables }] : []),
    ...(can(user, "billing:ver") ? [{ href: "/app/billing", label: es.nav.billing }] : []),
    ...(can(user, "workshop:ver") ? [{ href: "/app/workshop", label: es.nav.workshop }] : []),
    ...(can(user, "customers:ver") ? [{ href: "/app/customers", label: es.nav.customers }] : []),
    ...(can(user, "warranties:ver") ? [{ href: "/app/warranties", label: es.nav.warranties }] : []),
    ...(can(user, "catalog:ver") ? [{ href: "/app/catalog", label: es.nav.catalog }] : []),
    ...(can(user, "inventory:ver") ? [{ href: "/app/inventory", label: es.nav.inventory }] : []),
    ...(can(user, "purchasing:ver") ? [{ href: "/app/purchasing", label: es.nav.purchasing }] : []),
    ...(can(user, "reports:ver") ? [{ href: "/app/reports", label: es.nav.reports }] : []),
    ...(can(user, "ai_agent:ver") ? [{ href: "/app/ai", label: es.nav.ai }] : []),
    ...(can(user, "settings:ver")
      ? [{ href: "/app/subscription", label: es.nav.subscription }]
      : []),
    ...(can(user, "settings:ver") || can(user, "ai_agent:ver")
      ? [{ href: "/app/settings", label: es.nav.settings }]
      : []),
    ...(can(user, "users:ver")
      ? [
          { href: "/app/users", label: es.nav.users },
          { href: "/app/roles", label: es.nav.roles },
        ]
      : []),
  ];
  return (
    <>
      <Banners user={user} />
      <Header
        title={user.tenantName ?? es.app.name}
        subtitle={`${user.name} · ${user.roleName ?? ""}`}
        links={links}
      />
      <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6">{children}</main>
    </>
  );
}
